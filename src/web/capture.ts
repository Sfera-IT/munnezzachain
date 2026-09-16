import { sha256Hex } from "../shared/bytes.ts";
import { buildExifSegment, exifLocalDate, readExif, replaceExif } from "../shared/exif.ts";
import type { CaptureOrigin, PhotoLocation } from "../shared/model.ts";
import { h } from "./dom.ts";

export interface CapturedPhoto {
  blob: Blob;
  thumb: Blob;
  sha256: string;
  size: number;
  origin: CaptureOrigin;
  capturedAt: string;
  fileLastModified?: string;
  location?: PhotoLocation;
}

// ---------------------------------------------------------------------------------------------
// Location

export type FixState =
  | { kind: "waiting" }
  | { kind: "ok"; position: GeolocationPosition }
  | { kind: "denied" }
  | { kind: "unavailable"; message: string };

/** A fix older than this is not attached to a new photo. */
export const MAX_FIX_AGE_MS = 60_000;

export class LocationTracker {
  state: FixState = { kind: "waiting" };
  private watchId: number | null = null;
  private listeners = new Set<(s: FixState) => void>();

  start() {
    if (this.watchId !== null) return;
    if (!("geolocation" in navigator)) {
      this.set({ kind: "unavailable", message: "Questo browser non fornisce la posizione" });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.set({ kind: "ok", position }),
      (err) =>
        this.set(
          err.code === err.PERMISSION_DENIED
            ? { kind: "denied" }
            : { kind: "unavailable", message: err.code === err.TIMEOUT ? "Segnale GPS debole, spostati all'aperto" : "Posizione non disponibile" },
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.listeners.clear();
  }

  subscribe(fn: (s: FixState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(s: FixState) {
    // Keep a good fix through a transient timeout.
    if (s.kind === "unavailable" && this.state.kind === "ok" && this.freshFix()) return;
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }

  freshFix(): GeolocationPosition | null {
    if (this.state.kind !== "ok") return null;
    return Date.now() - this.state.position.timestamp <= MAX_FIX_AGE_MS ? this.state.position : null;
  }
}

const toLocation = (p: GeolocationPosition): PhotoLocation => {
  const c = p.coords;
  const loc: PhotoLocation = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, fixTime: new Date(p.timestamp).toISOString(), source: "device_gps" };
  if (c.altitude !== null) loc.altitude = c.altitude;
  if (c.altitudeAccuracy !== null) loc.altitudeAccuracy = c.altitudeAccuracy;
  if (c.heading !== null && !Number.isNaN(c.heading)) loc.heading = c.heading;
  return loc;
};

// ---------------------------------------------------------------------------------------------
// Images

async function thumbnail(source: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, 480 / Math.max(source.width, source.height));
  const canvas = new OffscreenCanvas(Math.round(source.width * scale), Math.round(source.height * scale));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
}

async function thumbnailFromBlob(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const t = await thumbnail(bmp);
    bmp.close();
    return t;
  } catch {
    return blob; // HEIC on browsers that cannot decode it: the original is its own preview
  }
}

export const supportsInAppCamera = () => Boolean(navigator.mediaDevices?.getUserMedia) && typeof OffscreenCanvas !== "undefined";

/**
 * Full-screen camera. Every shot gets EXIF written here — capture time, device GPS and accuracy — and
 * is hashed immediately, so what the server receives can be checked against what was shot.
 */
export function openCamera(tracker: LocationTracker, opts: { requireLocation: boolean; onShot: (p: CapturedPhoto) => void; remaining: () => number }): Promise<void> {
  return new Promise((resolve) => {
    let stream: MediaStream | null = null;
    let busy = false;
    const video = h("video", { autoplay: true, playsinline: true, muted: true, class: "camera-video" });
    video.muted = true;
    video.setAttribute("playsinline", "");
    const status = h("div", { class: "camera-status" }, "Avvio fotocamera…");
    const counter = h("div", { class: "camera-counter" });
    const shutter = h("button", { class: "camera-shutter", type: "button", "aria-label": "Scatta", disabled: true });
    const flash = h("div", { class: "camera-flash" });
    const close = () => {
      clearInterval(ticker);
      stream?.getTracks().forEach((t) => t.stop());
      unsubscribe();
      overlay.remove();
      document.body.classList.remove("no-scroll");
      resolve();
    };
    const done = h("button", { class: "btn btn-light", type: "button", onclick: close }, "Fine");
    const overlay = h(
      "div",
      { class: "camera", role: "dialog", "aria-label": "Fotocamera" },
      video,
      flash,
      h("div", { class: "camera-top" }, status, counter),
      h("div", { class: "camera-bottom" }, h("span"), shutter, done),
    );

    const refresh = () => {
      const fix = tracker.freshFix();
      const left = opts.remaining();
      counter.textContent = left > 0 ? `Ancora ${left} foto` : "Numero massimo di foto raggiunto";
      if (fix) {
        const acc = Math.round(fix.coords.accuracy);
        status.textContent = `📍 Posizione ±${acc} m`;
        status.className = `camera-status ${acc <= 30 ? "good" : acc <= 100 ? "fair" : "poor"}`;
      } else {
        const s = tracker.state;
        status.textContent =
          s.kind === "denied" ? "⚠ Posizione negata: consentila nelle impostazioni del browser" : s.kind === "unavailable" ? `⚠ ${s.message}` : "Rilevo la posizione…";
        status.className = "camera-status poor";
      }
      shutter.disabled = busy || !stream || left <= 0 || (opts.requireLocation && !fix);
    };
    const unsubscribe = tracker.subscribe(refresh);
    const ticker = setInterval(refresh, 2000);

    shutter.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      refresh();
      flash.classList.remove("go");
      void flash.offsetWidth;
      flash.classList.add("go");
      try {
        const fix = tracker.freshFix();
        const capturedAt = new Date();
        const photo = await grabFrame(video, stream!, capturedAt, fix ? toLocation(fix) : undefined);
        navigator.vibrate?.(40);
        opts.onShot(photo);
      } catch (e) {
        status.textContent = `Scatto non riuscito: ${(e as Error).message}`;
      } finally {
        busy = false;
        refresh();
      }
    });

    document.body.classList.add("no-scroll");
    document.body.append(overlay);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } }, audio: false })
      .then(async (s) => {
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        refresh();
      })
      .catch((e: DOMException) => {
        status.textContent =
          e.name === "NotAllowedError" ? "Accesso alla fotocamera negato. Consentilo nelle impostazioni del browser." : "Fotocamera non disponibile";
        status.className = "camera-status poor";
      });
  });
}

async function grabFrame(video: HTMLVideoElement, stream: MediaStream, capturedAt: Date, location?: PhotoLocation): Promise<CapturedPhoto> {
  let bitmap: ImageBitmap | null = null;
  let make: string | undefined;
  let model: string | undefined;
  const track = stream.getVideoTracks()[0];
  // Full sensor resolution where ImageCapture exists (Chromium); a video frame elsewhere (Safari, Firefox).
  const IC = (globalThis as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (IC && track) {
    try {
      const blob = await new IC(track).takePhoto();
      const exif = readExif(new Uint8Array(await blob.arrayBuffer()));
      make = exif?.make;
      model = exif?.model;
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      bitmap = null;
    }
  }
  if (!bitmap) {
    if (!video.videoWidth) throw new Error("fotocamera non pronta");
    bitmap = await createImageBitmap(video);
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  const encoded = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
  const thumb = await thumbnail(bitmap);
  const { width, height } = bitmap;
  bitmap.close();

  const local = exifLocalDate(capturedAt);
  const withExif = replaceExif(
    encoded,
    buildExifSegment({
      make,
      model,
      software: "munnezzachain PWA",
      pixelWidth: width,
      pixelHeight: height,
      dateTime: local.dateTime,
      dateTimeOriginal: local.dateTime,
      offsetTimeOriginal: local.offset,
      gps: location && { lat: location.lat, lon: location.lon, altitude: location.altitude, accuracy: location.accuracy, heading: location.heading, time: location.fixTime },
    }),
  );
  return {
    blob: new Blob([withExif as BlobPart], { type: "image/jpeg" }),
    thumb,
    sha256: await sha256Hex(withExif),
    size: withExif.length,
    origin: "in_app_camera",
    capturedAt: capturedAt.toISOString(),
    location,
  };
}

// ---------------------------------------------------------------------------------------------
// File inputs: the phone's own camera app (fallback) and the gallery (operators only)

export function pickFiles(opts: { capture: boolean; multiple: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: opts.capture ? "image/jpeg,image/*" : "image/*", multiple: opts.multiple, class: "visually-hidden" });
    if (opts.capture) input.setAttribute("capture", "environment");
    input.addEventListener("change", () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Files are hashed byte-for-byte as selected; nothing is re-encoded. */
export async function fromFile(file: File, origin: "native_camera" | "file_upload", tracker: LocationTracker): Promise<CapturedPhoto> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const capturedAt = new Date();
  let location: PhotoLocation | undefined;
  if (origin === "native_camera") {
    const fix = tracker.freshFix();
    if (fix) location = toLocation(fix);
  } else {
    const exif = readExif(bytes);
    if (exif?.gps) {
      location = { lat: exif.gps.lat, lon: exif.gps.lon, source: "exif" };
      if (exif.gps.accuracy !== undefined) location.accuracy = exif.gps.accuracy;
      if (exif.gps.altitude !== undefined) location.altitude = exif.gps.altitude;
      if (exif.gps.time) location.fixTime = exif.gps.time;
    }
  }
  return {
    blob: file,
    thumb: await thumbnailFromBlob(file),
    sha256: await sha256Hex(bytes),
    size: bytes.length,
    origin,
    capturedAt: capturedAt.toISOString(),
    fileLastModified: new Date(file.lastModified).toISOString(),
    location,
  };
}
