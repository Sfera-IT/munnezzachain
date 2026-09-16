// RFC 3161 trusted timestamping. The request is tiny, so it is DER-encoded by hand. The response is
// stored verbatim; this module only checks status, nonce and digest echo, and extracts genTime.
// Full cryptographic verification is done offline with `openssl ts -verify` (see docs/catena.md).

import { fromHex } from "../shared/bytes.ts";

const SHA256_OID = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];

function tlv(tag: number, content: Uint8Array | number[]): Uint8Array {
  const body = content instanceof Uint8Array ? content : new Uint8Array(content);
  const len = body.length;
  const header =
    len < 0x80 ? [tag, len] : len < 0x100 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 0xff];
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(body, header.length);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function buildTimeStampRequest(digestHex: string, nonce: Uint8Array): Uint8Array {
  const n = new Uint8Array(nonce);
  n[0] = (n[0]! & 0x7f) | 0x01; // positive and minimally encoded
  const imprint = tlv(0x30, concat(tlv(0x30, concat(new Uint8Array(SHA256_OID), new Uint8Array([0x05, 0x00]))), tlv(0x04, fromHex(digestHex))));
  return tlv(0x30, concat(tlv(0x02, [1]), imprint, tlv(0x02, n), tlv(0x01, [0xff])));
}

interface Node {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

function readNode(b: Uint8Array, at: number): Node {
  if (at + 2 > b.length) throw new Error("DER troncato");
  const tag = b[at]!;
  let len = b[at + 1]!;
  let contentStart = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + 2 + n > b.length) throw new Error("lunghezza DER non supportata");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[at + 2 + i]!;
    contentStart += n;
  }
  const end = contentStart + len;
  if (end > b.length) throw new Error("DER troncato");
  return { tag, start: at, contentStart, end };
}

export interface TsaResult {
  granted: boolean;
  status: number;
  genTime?: string;
  error?: string;
}

const indexOf = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

/** Never throws: a malformed response is reported as not granted. */
export function inspectTimeStampResponse(resp: Uint8Array, digestHex: string, nonce: Uint8Array): TsaResult {
  try {
    return inspect(resp, digestHex, nonce);
  } catch (e) {
    return { granted: false, status: -1, error: `risposta TSA malformata: ${(e as Error).message}` };
  }
}

function inspect(resp: Uint8Array, digestHex: string, nonce: Uint8Array): TsaResult {
  const outer = readNode(resp, 0);
  if (outer.tag !== 0x30) throw new Error("atteso SEQUENCE");
  const statusInfo = readNode(resp, outer.contentStart);
  const statusInt = readNode(resp, statusInfo.contentStart);
  if (statusInfo.tag !== 0x30 || statusInt.tag !== 0x02 || statusInt.end === statusInt.contentStart) throw new Error("PKIStatusInfo non valido");
  const status = resp[statusInt.end - 1]!;
  if (status > 1) return { granted: false, status, error: `la TSA ha rifiutato la richiesta (stato ${status})` };
  if (statusInfo.end >= outer.end) return { granted: false, status, error: "risposta senza token" };

  const token = resp.subarray(statusInfo.end, outer.end);
  if (indexOf(token, fromHex(digestHex)) === -1) return { granted: false, status, error: "il token non contiene l'impronta richiesta" };
  const n = new Uint8Array(nonce);
  n[0] = (n[0]! & 0x7f) | 0x01;
  if (indexOf(token, n) === -1) return { granted: false, status, error: "nonce non corrispondente" };

  // TSTInfo.genTime is the only GeneralizedTime in a typical token (CMS signingTime uses UTCTime).
  for (let i = 0; i < token.length - 16; i++) {
    if (token[i] !== 0x18) continue;
    const len = token[i + 1]!;
    if (len < 15 || len > 24) continue;
    const s = new TextDecoder().decode(token.subarray(i + 2, i + 2 + len));
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
    if (m) {
      return { granted: true, status, genTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z` };
    }
  }
  return { granted: true, status };
}

export interface TsaConfig {
  url: string;
  username?: string;
  password?: string;
}

export async function requestTimestamp(cfg: TsaConfig, digestHex: string): Promise<{ result: TsaResult; response?: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const headers: Record<string, string> = { "content-type": "application/timestamp-query" };
  if (cfg.username) headers.authorization = `Basic ${btoa(`${cfg.username}:${cfg.password ?? ""}`)}`;
  const res = await fetch(cfg.url, { method: "POST", headers, body: buildTimeStampRequest(digestHex, nonce) });
  if (!res.ok) return { result: { granted: false, status: -1, error: `HTTP ${res.status} dalla TSA` } };
  const response = new Uint8Array(await res.arrayBuffer());
  return { result: inspectTimeStampResponse(response, digestHex, nonce), response };
}
