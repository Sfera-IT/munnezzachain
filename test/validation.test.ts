import { describe, expect, it } from "vitest";
import { validateMeta } from "../src/worker/submit.ts";

const valid = () => ({
  clientReportId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  category: "rifiuti",
  description: "Sacchi abbandonati",
  consent: true,
  clientCreatedAt: "2026-09-16T12:00:00Z",
  queued: false,
  photos: [
    {
      index: 0,
      sha256: "a".repeat(64),
      size: 1234,
      origin: "in_app_camera",
      capturedAt: "2026-09-16T11:59:00Z",
      location: { lat: 45.46, lon: 10.98, accuracy: 6, fixTime: "2026-09-16T11:58:58Z", source: "device_gps" },
    },
  ],
});

describe("submission validation", () => {
  it("accepts a well-formed report and normalises dates", () => {
    const m = validateMeta(valid());
    expect(m.photos[0]!.capturedAt).toBe("2026-09-16T11:59:00.000Z");
    expect(m.description).toBe("Sacchi abbandonati");
  });

  const cases: [string, (m: ReturnType<typeof valid>) => unknown, RegExp][] = [
    ["unknown category", (m) => (m.category = "boh"), /categoria/],
    ["description too short", (m) => (m.description = "ok"), /descrizione/],
    ["no photos", (m) => (m.photos = []), /foto/],
    ["eleven photos", (m) => (m.photos = Array.from({ length: 11 }, (_, i) => ({ ...valid().photos[0]!, index: i }))), /foto/],
    ["bad hash", (m) => (m.photos[0]!.sha256 = "xyz"), /impronta/],
    ["uppercase hash", (m) => (m.photos[0]!.sha256 = "A".repeat(64)), /impronta/],
    ["photo too large", (m) => (m.photos[0]!.size = 21 * 1024 * 1024), /dimensione/],
    ["indexes out of order", (m) => (m.photos[0]!.index = 1), /ordine/],
    ["latitude out of range", (m) => (m.photos[0]!.location.lat = 91), /coordinate/],
    ["NaN longitude", (m) => (m.photos[0]!.location.lon = Number.NaN), /coordinate/],
    ["in-app photo claiming manual position", (m) => (m.photos[0]!.location.source = "manual"), /GPS del dispositivo/],
    ["upload claiming device GPS", (m) => (m.photos[0]!.origin = "file_upload"), /caricata/],
    ["invalid capture date", (m) => (m.photos[0]!.capturedAt = "ieri"), /ora di scatto/],
    ["short client id", (m) => (m.clientReportId = "abc"), /identificativo/],
    ["contact too long", (m) => ((m as Record<string, unknown>).contact = "x".repeat(201)), /contatto/],
    ["consent not boolean", (m) => ((m as Record<string, unknown>).consent = "sì"), /consenso/],
  ];

  for (const [name, mutate, message] of cases) {
    it(`rejects: ${name}`, () => {
      const m = valid();
      mutate(m);
      expect(() => validateMeta(m)).toThrow(message);
    });
  }

  it("rejects non-object payloads", () => {
    expect(() => validateMeta(null)).toThrow();
    expect(() => validateMeta("stringa")).toThrow();
  });
});
