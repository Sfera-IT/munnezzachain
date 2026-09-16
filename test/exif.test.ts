import { describe, expect, it } from "vitest";
import { buildExifSegment, readExif, replaceExif, distanceMeters } from "../src/shared/exif.ts";

// Smallest valid JPEG skeleton: SOI, a JFIF APP0, then SOS and EOI.
const jpeg = () =>
  new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
  ]);

describe("exif", () => {
  it("round-trips GPS and provenance fields", () => {
    const seg = buildExifSegment({
      software: "munnezzachain",
      make: "Google",
      model: "Pixel 9",
      dateTimeOriginal: "2026:09:16 13:14:51",
      offsetTimeOriginal: "+02:00",
      gps: { lat: 45.459950, lon: 10.979603, altitude: 124.5, accuracy: 7.25, heading: 313, time: "2026-09-16T11:14:51.250Z" },
    });
    const out = replaceExif(jpeg(), seg);
    const info = readExif(out)!;
    expect(info.make).toBe("Google");
    expect(info.model).toBe("Pixel 9");
    expect(info.software).toBe("munnezzachain");
    expect(info.dateTimeOriginal).toBe("2026:09:16 13:14:51");
    expect(info.offsetTimeOriginal).toBe("+02:00");
    expect(distanceMeters(info.gps!, { lat: 45.45995, lon: 10.979603 })).toBeLessThan(0.01);
    expect(info.gps!.altitude).toBeCloseTo(124.5);
    expect(info.gps!.accuracy).toBeCloseTo(7.25);
    expect(info.gps!.heading).toBe(313);
    expect(info.gps!.time).toBe("2026-09-16T11:14:51.250Z");
  });

  it("handles southern and western hemispheres and negative altitude", () => {
    const out = replaceExif(jpeg(), buildExifSegment({ gps: { lat: -33.8688, lon: -70.6693, altitude: -12 } }));
    const g = readExif(out)!.gps!;
    expect(g.lat).toBeCloseTo(-33.8688, 6);
    expect(g.lon).toBeCloseTo(-70.6693, 6);
    expect(g.altitude).toBe(-12);
  });

  it("replaces an existing Exif segment instead of stacking a second one", () => {
    const once = replaceExif(jpeg(), buildExifSegment({ software: "a", gps: { lat: 1, lon: 1 } }));
    const twice = replaceExif(once, buildExifSegment({ software: "b" }));
    const info = readExif(twice)!;
    expect(info.software).toBe("b");
    expect(info.gps).toBeUndefined();
    const count = [...twice].filter((b, i) => b === 0xff && twice[i + 1] === 0xe1).length;
    expect(count).toBe(1);
    // Image data after the headers is untouched.
    expect([...twice.slice(-8)]).toEqual([...jpeg().slice(-8)]);
  });

  it("reports a zeroed GPS block as stripped, not as a position at 0,0", () => {
    // Hand-built GPS IFD with 0/0 rationals and no hemisphere, as left behind by mail clients.
    const seg = buildExifSegment({ gps: { lat: 0, lon: 0 } });
    const tiffStart = 10;
    const bytes = new Uint8Array(seg);
    // Blank out the N/E references so the block looks scrubbed.
    for (let i = tiffStart; i < bytes.length - 1; i++) {
      if ((bytes[i] === 0x4e || bytes[i] === 0x45) && bytes[i + 1] === 0) bytes[i] = 0;
    }
    const info = readExif(replaceExif(jpeg(), bytes))!;
    expect(info.gps).toBeUndefined();
    expect(info.gpsZeroed).toBe(true);
  });

  it("returns null for a JPEG without EXIF and for non-JPEG data", () => {
    expect(readExif(jpeg())).toBeNull();
    expect(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
