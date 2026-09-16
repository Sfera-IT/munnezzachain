import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildTimeStampRequest, inspectTimeStampResponse } from "../src/worker/tsa.ts";
import { fromHex } from "../src/shared/bytes.ts";

// A real exchange with FreeTSA, recorded once so CI never depends on the network.
const dir = new URL("./fixtures/tsa/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("meta.json", dir), "utf8")) as { digest: string; nonceHex: string };
const response = new Uint8Array(readFileSync(new URL("response.tsr", dir)));
const nonce = fromHex(meta.nonceHex);

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("RFC 3161 with a recorded FreeTSA response", () => {
  it("rebuilds the exact request that was sent", () => {
    expect(Buffer.from(buildTimeStampRequest(meta.digest, nonce))).toEqual(readFileSync(new URL("request.tsq", dir)));
  });

  it("accepts the response and extracts genTime", () => {
    const r = inspectTimeStampResponse(response, meta.digest, nonce);
    expect(r.granted).toBe(true);
    expect(r.genTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("rejects the response for a different digest", () => {
    const r = inspectTimeStampResponse(response, "ff".repeat(32), nonce);
    expect(r.granted).toBe(false);
    expect(r.error).toMatch(/impronta/);
  });

  it("rejects the response when the nonce does not match (replay)", () => {
    const r = inspectTimeStampResponse(response, meta.digest, fromHex("0badc0de0badc0de"));
    expect(r.granted).toBe(false);
    expect(r.error).toMatch(/nonce/);
  });

  it("never throws on malformed responses and never grants them", () => {
    const samples = [[], [0x30], [0x30, 0x84, 0xff], [0x30, 0x03, 0x30, 0x01, 0x02], [0x04, 0x02, 0x00, 0x00], [...response.subarray(0, 40)]];
    for (const s of samples) {
      const r = inspectTimeStampResponse(new Uint8Array(s), meta.digest, nonce);
      expect(r.granted).toBe(false);
    }
    // Every truncation of the real response is refused too.
    for (let cut = 0; cut < response.length; cut += 97) {
      expect(inspectTimeStampResponse(response.subarray(0, cut), meta.digest, nonce).granted).toBe(false);
    }
  });

  it.skipIf(!hasOpenssl)("verifies cryptographically with openssl, as documented in docs/catena.md", () => {
    const out = execFileSync(
      "openssl",
      ["ts", "-verify", "-digest", meta.digest, "-in", new URL("response.tsr", dir).pathname, "-CAfile", new URL("cacert.pem", dir).pathname, "-untrusted", new URL("tsa.crt", dir).pathname],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toContain("Verification: OK");
  });

  it.skipIf(!hasOpenssl)("produces a request openssl can parse", () => {
    const out = execFileSync("openssl", ["ts", "-query", "-in", new URL("request.tsq", dir).pathname, "-text"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("Hash Algorithm: sha256");
    expect(out).toContain("Certificate required: yes");
  });
});
