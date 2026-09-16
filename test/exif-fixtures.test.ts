import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readExif, replaceExif, buildExifSegment, distanceMeters } from "../src/shared/exif.ts";
import { computePhotoFlags } from "../src/shared/model.ts";
import { sniffImageMime } from "../src/shared/bytes.ts";

// Fixtures written by exiftool, the reference implementation, not by our own writer.
const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/exif/${name}`, import.meta.url)));

describe("EXIF from real files", () => {
  it("reads little-endian (Intel) EXIF as written by most phone cameras", () => {
    const info = readExif(load("camera-ii.jpg"))!;
    expect(info.make).toBe("samsung");
    expect(info.model).toBe("SM-S918B");
    expect(info.dateTimeOriginal).toBe("2026:09:16 13:14:51");
    expect(info.offsetTimeOriginal).toBe("+02:00");
    expect(distanceMeters(info.gps!, { lat: 45.45995, lon: 10.979603 })).toBeLessThan(1);
    expect(info.gps!.altitude).toBeCloseTo(124);
    expect(info.gps!.time).toBe("2026-09-16T11:14:51.000Z");
  });

  it("recognises GPS scrubbed by a mail client instead of placing the photo at 0,0", () => {
    const info = readExif(load("gmail-stripped.jpg"))!;
    expect(info.gps).toBeUndefined();
    expect(info.gpsZeroed).toBe(true);
    const codes = computePhotoFlags({
      photo: { index: 0, sha256: "a".repeat(64), size: 1, origin: "file_upload", capturedAt: new Date().toISOString() },
      mime: "image/jpeg",
      exif: info,
      receivedAt: new Date(),
    }).map((f) => f.code);
    expect(codes).toContain("EXIF_GPS_ZEROED");
    expect(codes).toContain("GPS_MISSING");
  });

  it("flags files saved by photo editors", () => {
    const info = readExif(load("edited.jpg"))!;
    expect(info.software).toMatch(/Photoshop/);
  });

  it("returns null for a JPEG with no EXIF", () => {
    expect(readExif(load("no-exif.jpg"))).toBeNull();
  });

  it("keeps the image data intact when replacing EXIF on a real file", () => {
    const src = load("camera-ii.jpg");
    const out = replaceExif(src, buildExifSegment({ software: "munnezzachain", gps: { lat: 1, lon: 2 } }));
    const sos = (b: Uint8Array) => {
      for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return b.subarray(i);
      throw new Error("SOS mancante");
    };
    expect(Buffer.from(sos(out))).toEqual(Buffer.from(sos(src)));
    expect(sniffImageMime(out)).toBe("image/jpeg");
    expect(readExif(out)!.gps).toMatchObject({ lat: 1, lon: 2 });
  });
});

describe("EXIF reader robustness", () => {
  it("never throws on truncated or corrupted input", () => {
    const src = load("camera-ii.jpg");
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 400; i++) {
      const b = new Uint8Array(src.subarray(0, Math.floor(rand() * src.length)));
      for (let k = 0; k < 8; k++) if (b.length) b[Math.floor(rand() * Math.min(b.length, 400))] = Math.floor(rand() * 256);
      expect(() => readExif(b)).not.toThrow();
    }
  });
});
