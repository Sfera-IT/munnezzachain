import type { ExifInfo } from "./exif.ts";
import { distanceMeters } from "./exif.ts";
import { sha256Hex, canonicalJson } from "./bytes.ts";

export const CATEGORIES = {
  rifiuti: "Rifiuti abbandonati",
  acqua: "Inquinamento dell'acqua",
  aria: "Emissioni o odori nell'aria",
  suolo: "Suolo contaminato",
  incendio: "Incendio o combustione di rifiuti",
  altro: "Altro",
} as const;
export type Category = keyof typeof CATEGORIES;

export const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** All photos of one report together. A Worker isolate has 128 MB and holds the whole upload in memory. */
export const MAX_REPORT_BYTES = 60 * 1024 * 1024;

export const STATUSES = {
  nuova: "Nuova",
  in_verifica: "In verifica",
  inviata: "Inviata al portale",
  archiviata: "Archiviata",
  scartata: "Scartata",
} as const;
export type Status = keyof typeof STATUSES;

/**
 * in_app_camera — shot through the PWA's own camera view; the app wrote EXIF and hashed it on the spot.
 * native_camera — the phone's camera app opened by the PWA (fallback when getUserMedia is missing).
 * file_upload   — picked from the gallery or file system; provenance is only what its EXIF claims.
 */
export type CaptureOrigin = "in_app_camera" | "native_camera" | "file_upload";
export type LocationSource = "device_gps" | "exif" | "manual";

export interface PhotoLocation {
  lat: number;
  lon: number;
  accuracy?: number;
  altitude?: number;
  altitudeAccuracy?: number;
  heading?: number;
  /** When the position was obtained (device clock), ISO 8601. */
  fixTime?: string;
  source: LocationSource;
}

export interface PhotoMeta {
  index: number;
  sha256: string;
  size: number;
  origin: CaptureOrigin;
  /** Device clock at the moment of capture or selection, ISO 8601. */
  capturedAt: string;
  /** File.lastModified for native_camera and file_upload, ISO 8601. */
  fileLastModified?: string;
  location?: PhotoLocation;
}

export interface SubmitMeta {
  clientReportId: string;
  category: Category;
  description: string;
  contact?: string;
  consent: boolean;
  photos: PhotoMeta[];
  clientCreatedAt: string;
  queued: boolean;
  turnstileToken?: string;
}

export type FlagCode =
  | "GPS_MISSING"
  | "GPS_ACCURACY_LOW"
  | "GPS_FIX_STALE"
  | "LOCATION_MANUAL"
  | "LOCATION_FROM_EXIF"
  | "EXIF_GPS_MISMATCH"
  | "EXIF_GPS_ZEROED"
  | "EXIF_DATE_MISSING"
  | "EXIF_EDITING_SOFTWARE"
  | "UPLOAD_NOT_CAMERA"
  | "NATIVE_CAMERA_NOT_FRESH"
  | "CLOCK_AHEAD"
  | "SUBMIT_DELAYED"
  | "FORMAT_NO_EXIF_SUPPORT";

export interface Flag {
  code: FlagCode;
  level: "info" | "warn";
  detail?: string;
}

export const FLAG_LABELS: Record<FlagCode, string> = {
  GPS_MISSING: "Nessuna posizione associata alla foto",
  GPS_ACCURACY_LOW: "Posizione poco precisa",
  GPS_FIX_STALE: "Posizione rilevata troppo prima o dopo lo scatto",
  LOCATION_MANUAL: "Posizione indicata a mano sulla mappa",
  LOCATION_FROM_EXIF: "Posizione letta dai metadati EXIF del file",
  EXIF_GPS_MISMATCH: "Il GPS nei metadati non coincide con la posizione dichiarata",
  EXIF_GPS_ZEROED: "Il file ha un blocco GPS azzerato: la posizione è stata rimossa da un'app",
  EXIF_DATE_MISSING: "Il file non riporta la data di scatto",
  EXIF_EDITING_SOFTWARE: "Il file è stato salvato da un programma di fotoritocco",
  UPLOAD_NOT_CAMERA: "Foto caricata da galleria, non scattata nell'app",
  NATIVE_CAMERA_NOT_FRESH: "Il file della fotocamera non è stato creato al momento dello scatto",
  CLOCK_AHEAD: "L'orologio del telefono è avanti rispetto al server",
  SUBMIT_DELAYED: "Inviata più di 24 ore dopo lo scatto",
  FORMAT_NO_EXIF_SUPPORT: "Formato non JPEG: metadati non letti dal server",
};

const EDITORS = /photoshop|lightroom|gimp|snapseed|picsart|affinity|pixelmator|canva|facetune|vsco|luminar|darktable|paint\.net/i;

export interface FlagInput {
  photo: PhotoMeta;
  mime: string;
  exif: ExifInfo | null;
  receivedAt: Date;
}

export function computePhotoFlags({ photo, mime, exif, receivedAt }: FlagInput): Flag[] {
  const flags: Flag[] = [];
  const loc = photo.location;
  const captured = new Date(photo.capturedAt);

  if (!loc) flags.push({ code: "GPS_MISSING", level: "warn" });
  else {
    if (loc.source === "manual") flags.push({ code: "LOCATION_MANUAL", level: "warn" });
    if (loc.source === "exif") flags.push({ code: "LOCATION_FROM_EXIF", level: "info" });
    if (loc.accuracy !== undefined && loc.accuracy > 50) {
      flags.push({ code: "GPS_ACCURACY_LOW", level: "warn", detail: `±${Math.round(loc.accuracy)} m` });
    }
    if (loc.source === "device_gps" && loc.fixTime) {
      const gap = Math.abs(new Date(loc.fixTime).getTime() - captured.getTime()) / 1000;
      if (gap > 120) flags.push({ code: "GPS_FIX_STALE", level: "warn", detail: `${Math.round(gap)} s` });
    }
    if (exif?.gps && loc.source !== "manual") {
      const d = distanceMeters(exif.gps, loc);
      const tolerance = Math.max(25, (loc.accuracy ?? 0) + (exif.gps.accuracy ?? 0));
      if (d > tolerance) flags.push({ code: "EXIF_GPS_MISMATCH", level: "warn", detail: `${Math.round(d)} m` });
    }
  }

  if (exif?.gpsZeroed) flags.push({ code: "EXIF_GPS_ZEROED", level: "warn" });
  if (mime !== "image/jpeg") flags.push({ code: "FORMAT_NO_EXIF_SUPPORT", level: "info" });

  if (photo.origin === "file_upload") {
    flags.push({ code: "UPLOAD_NOT_CAMERA", level: "info" });
    if (mime === "image/jpeg" && !exif?.dateTimeOriginal) flags.push({ code: "EXIF_DATE_MISSING", level: "warn" });
  }
  if (photo.origin !== "in_app_camera" && exif?.software && EDITORS.test(exif.software)) {
    flags.push({ code: "EXIF_EDITING_SOFTWARE", level: "warn", detail: exif.software });
  }
  if (photo.origin === "native_camera" && photo.fileLastModified) {
    const age = (captured.getTime() - new Date(photo.fileLastModified).getTime()) / 1000;
    if (age > 300) flags.push({ code: "NATIVE_CAMERA_NOT_FRESH", level: "warn", detail: `${Math.round(age / 60)} min` });
  }

  const ahead = (captured.getTime() - receivedAt.getTime()) / 1000;
  if (ahead > 300) flags.push({ code: "CLOCK_AHEAD", level: "warn", detail: `${Math.round(ahead / 60)} min` });
  if (photo.origin !== "file_upload" && -ahead > 86400) {
    flags.push({ code: "SUBMIT_DELAYED", level: "info", detail: `${Math.round(-ahead / 3600)} h` });
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Manifest and chain

export interface ManifestPhoto {
  index: number;
  sha256: string;
  size: number;
  mime: string;
  origin: CaptureOrigin;
  capturedAt: string;
  fileLastModified?: string;
  location?: PhotoLocation;
  exif?: ExifInfo;
  flags: Flag[];
  derivedSha256?: string;
}

export interface Manifest {
  format: "munnezzachain/manifest";
  version: 1;
  reportId: string;
  clientReportId: string;
  receivedAt: string;
  channel: "operatore" | "pubblico";
  submittedBy?: string;
  category: Category;
  description: string;
  clientCreatedAt: string;
  queued: boolean;
  photos: ManifestPhoto[];
}

export const GENESIS_HASH = "0".repeat(64);

export const manifestBytes = (m: Manifest) => new TextEncoder().encode(canonicalJson(m));

export interface ChainLink {
  seq: number;
  prevHash: string;
  manifestSha256: string;
  receivedAt: string;
}

/** Keep in sync with docs/catena.md: this string is what an independent verifier recomputes. */
export const chainPreimage = (l: ChainLink) => `munnezzachain/v1|${l.seq}|${l.prevHash}|${l.manifestSha256}|${l.receivedAt}`;

export const entryHash = (l: ChainLink) => sha256Hex(chainPreimage(l));
