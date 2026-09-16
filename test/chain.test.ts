import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/shared/bytes.ts";
import { chainPreimage, entryHash, GENESIS_HASH, computePhotoFlags } from "../src/shared/model.ts";
import { buildTimeStampRequest, inspectTimeStampResponse } from "../src/worker/tsa.ts";
import { buildZip, crc32 } from "../src/worker/zip.ts";
import { hashPassword, verifyPassword } from "../src/shared/password.ts";

describe("canonical JSON", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

describe("chain", () => {
  it("hashes the documented preimage", async () => {
    const link = { seq: 1, prevHash: GENESIS_HASH, manifestSha256: "a".repeat(64), receivedAt: "2026-09-16T11:14:51.000Z" };
    expect(chainPreimage(link)).toBe(`munnezzachain/v1|1|${"0".repeat(64)}|${"a".repeat(64)}|2026-09-16T11:14:51.000Z`);
    expect(await entryHash(link)).toBe(await sha256Hex(chainPreimage(link)));
  });
});

describe("RFC 3161 request", () => {
  it("encodes a well-formed TimeStampReq", () => {
    const digest = "ab".repeat(32);
    const req = buildTimeStampRequest(digest, new Uint8Array([0xff, 1, 2, 3, 4, 5, 6, 7]));
    expect(req[0]).toBe(0x30);
    expect(req[1]).toBe(req.length - 2);
    // version INTEGER 1
    expect([...req.slice(2, 5)]).toEqual([0x02, 0x01, 0x01]);
    // nonce is forced positive
    const nonceAt = req.length - 3 - 10;
    expect(req[nonceAt]).toBe(0x02);
    expect(req[nonceAt + 2]! & 0x80).toBe(0);
    // certReq TRUE
    expect([...req.slice(-3)]).toEqual([0x01, 0x01, 0xff]);
  });

  it("reads a rejection status", () => {
    const resp = new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]);
    expect(inspectTimeStampResponse(resp, "00".repeat(32), new Uint8Array(8)).granted).toBe(false);
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes a central directory that points at every entry", () => {
    const zip = buildZip([{ name: "a.txt", data: new TextEncoder().encode("ciao") }, { name: "b/ç.bin", data: new Uint8Array([1, 2, 3]) }]);
    const dv = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(2);
    const cdOffset = dv.getUint32(end + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
  });
});

describe("password", () => {
  it("verifies the right password only", async () => {
    const h = await hashPassword("una-password-lunga");
    expect(await verifyPassword("una-password-lunga", h)).toBe(true);
    expect(await verifyPassword("sbagliata", h)).toBe(false);
  });
});

describe("flags", () => {
  const receivedAt = new Date("2026-09-16T12:00:00Z");
  it("marks an in-app photo with a precise, fresh fix as clean", () => {
    const flags = computePhotoFlags({
      photo: { index: 0, sha256: "a".repeat(64), size: 1, origin: "in_app_camera", capturedAt: "2026-09-16T11:59:00Z", location: { lat: 45, lon: 10, accuracy: 8, fixTime: "2026-09-16T11:58:55Z", source: "device_gps" } },
      mime: "image/jpeg",
      exif: { gps: { lat: 45, lon: 10 } },
      receivedAt,
    });
    expect(flags).toEqual([]);
  });
  it("warns on an upload with stripped GPS and an editor signature", () => {
    const codes = computePhotoFlags({
      photo: { index: 0, sha256: "a".repeat(64), size: 1, origin: "file_upload", capturedAt: "2026-09-16T11:59:00Z" },
      mime: "image/jpeg",
      exif: { gpsZeroed: true, software: "Adobe Photoshop 25.0" },
      receivedAt,
    }).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["GPS_MISSING", "EXIF_GPS_ZEROED", "UPLOAD_NOT_CAMERA", "EXIF_DATE_MISSING", "EXIF_EDITING_SOFTWARE"]));
  });
});
