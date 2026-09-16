import { Hono } from "hono";
import type { Context } from "hono";
import { isSha256Hex, sha256Hex, sniffImageMime, extensionFor, canonicalJson } from "../shared/bytes.ts";
import { readExif, buildExifSegment, replaceExif } from "../shared/exif.ts";
import type { ExifInfo } from "../shared/exif.ts";
import {
  CATEGORIES,
  computePhotoFlags,
  manifestBytes,
  type CaptureOrigin,
  type LocationSource,
  type Manifest,
  type ManifestPhoto,
  type PhotoLocation,
  type PhotoMeta,
  type SubmitMeta,
} from "../shared/model.ts";
import type { AppEnv, Env } from "./env.ts";
import { appendToChain, timestampLink, type ChainRow } from "./chain.ts";
import { audit, clientIp, newReportId } from "./util.ts";
import { storageKeys } from "./storage.ts";

export const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

class Invalid extends Error {}

const ORIGINS: CaptureOrigin[] = ["in_app_camera", "native_camera", "file_upload"];
const SOURCES: LocationSource[] = ["device_gps", "exif", "manual"];

const isIsoDate = (s: unknown): s is string => typeof s === "string" && s.length <= 40 && !Number.isNaN(Date.parse(s));
const finite = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const optionalFinite = (n: unknown, min: number, max: number) => n === undefined || n === null || finite(n, min, max);

function validateLocation(raw: unknown, origin: CaptureOrigin): PhotoLocation | undefined {
  if (raw === undefined || raw === null) return undefined;
  const l = raw as Record<string, unknown>;
  if (!finite(l.lat, -90, 90) || !finite(l.lon, -180, 180)) throw new Invalid("coordinate non valide");
  if (!SOURCES.includes(l.source as LocationSource)) throw new Invalid("origine della posizione non valida");
  const source = l.source as LocationSource;
  if (source === "device_gps" && origin === "file_upload") throw new Invalid("una foto caricata non può avere il GPS del dispositivo");
  if (source !== "device_gps" && origin !== "file_upload") throw new Invalid("una foto scattata deve usare il GPS del dispositivo");
  if (!optionalFinite(l.accuracy, 0, 1e6) || !optionalFinite(l.altitude, -1e4, 1e5) || !optionalFinite(l.heading, 0, 360)) {
    throw new Invalid("dati di posizione non validi");
  }
  if (!optionalFinite(l.altitudeAccuracy, 0, 1e6)) throw new Invalid("dati di posizione non validi");
  if (l.fixTime !== undefined && !isIsoDate(l.fixTime)) throw new Invalid("ora della posizione non valida");
  const loc: PhotoLocation = { lat: l.lat as number, lon: l.lon as number, source };
  for (const k of ["accuracy", "altitude", "altitudeAccuracy", "heading"] as const) {
    if (typeof l[k] === "number") loc[k] = l[k] as number;
  }
  if (typeof l.fixTime === "string") loc.fixTime = new Date(l.fixTime).toISOString();
  return loc;
}

export function validateMeta(raw: unknown): SubmitMeta {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new Invalid("dati della segnalazione mancanti");
  if (typeof m.clientReportId !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(m.clientReportId)) throw new Invalid("identificativo client non valido");
  if (typeof m.category !== "string" || !(m.category in CATEGORIES)) throw new Invalid("categoria non valida");
  if (typeof m.description !== "string" || m.description.trim().length < 5 || m.description.length > 4000) {
    throw new Invalid("la descrizione deve avere tra 5 e 4000 caratteri");
  }
  if (m.contact !== undefined && (typeof m.contact !== "string" || m.contact.length > 200)) throw new Invalid("contatto non valido");
  if (typeof m.consent !== "boolean") throw new Invalid("consenso mancante");
  if (!isIsoDate(m.clientCreatedAt)) throw new Invalid("data di creazione non valida");
  if (!Array.isArray(m.photos) || m.photos.length === 0 || m.photos.length > MAX_PHOTOS) {
    throw new Invalid(`servono da 1 a ${MAX_PHOTOS} foto`);
  }
  const photos: PhotoMeta[] = m.photos.map((rawPhoto, i) => {
    const p = rawPhoto as Record<string, unknown>;
    if (p.index !== i) throw new Invalid("ordine delle foto non valido");
    if (!isSha256Hex(p.sha256)) throw new Invalid(`impronta della foto ${i + 1} non valida`);
    if (!finite(p.size, 1, MAX_PHOTO_BYTES)) throw new Invalid(`dimensione della foto ${i + 1} non valida`);
    if (!ORIGINS.includes(p.origin as CaptureOrigin)) throw new Invalid(`provenienza della foto ${i + 1} non valida`);
    if (!isIsoDate(p.capturedAt)) throw new Invalid(`ora di scatto della foto ${i + 1} non valida`);
    if (p.fileLastModified !== undefined && !isIsoDate(p.fileLastModified)) throw new Invalid("data del file non valida");
    const origin = p.origin as CaptureOrigin;
    const photo: PhotoMeta = {
      index: i,
      sha256: p.sha256,
      size: p.size as number,
      origin,
      capturedAt: new Date(p.capturedAt).toISOString(),
    };
    if (typeof p.fileLastModified === "string") photo.fileLastModified = new Date(p.fileLastModified).toISOString();
    const location = validateLocation(p.location, origin);
    if (location) photo.location = location;
    return photo;
  });
  const meta: SubmitMeta = {
    clientReportId: m.clientReportId,
    category: m.category as SubmitMeta["category"],
    description: m.description.trim(),
    consent: m.consent,
    clientCreatedAt: new Date(m.clientCreatedAt).toISOString(),
    queued: m.queued === true,
    photos,
  };
  if (typeof m.contact === "string" && m.contact.trim()) meta.contact = m.contact.trim();
  if (typeof m.turnstileToken === "string") meta.turnstileToken = m.turnstileToken;
  return meta;
}

function withinPublicArea(env: Env, loc: PhotoLocation): boolean {
  if (!env.PUBLIC_AREA_BBOX) return true;
  const [minLon, minLat, maxLon, maxLat] = env.PUBLIC_AREA_BBOX.split(",").map(Number);
  return loc.lon >= minLon! && loc.lon <= maxLon! && loc.lat >= minLat! && loc.lat <= maxLat!;
}

async function turnstileOk(c: Context<AppEnv>, token: string | undefined): Promise<boolean> {
  if (!c.env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token, remoteip: clientIp(c) }),
  });
  const data = await res.json<{ success: boolean }>();
  return data.success === true;
}

export interface Receipt {
  reportId: string;
  receivedAt: string;
  moderation: "in_attesa" | "accettata";
  seq: number;
  prevHash: string;
  entryHash: string;
  manifestSha256: string;
  photos: { index: number; sha256: string; flags: string[] }[];
  tsaStatus: ChainRow["tsa_status"];
  duplicate?: boolean;
}

export const submit = new Hono<AppEnv>();

submit.post("/", async (c) => {
  const sessionUser = c.get("user");
  const operator = sessionUser && !sessionUser.mustChangePassword ? sessionUser : null;
  const channel = operator ? "operatore" : "pubblico";

  if (!operator) {
    const { success } = await c.env.PUBLIC_SUBMIT_LIMITER.limit({ key: clientIp(c) });
    if (!success) return c.json({ error: "Troppe segnalazioni in poco tempo. Riprova tra un minuto." }, 429);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Richiesta non leggibile" }, 400);
  }

  let meta: SubmitMeta;
  try {
    meta = validateMeta(JSON.parse(String(form.get("meta") ?? "null")));
    if (!operator) {
      if (!meta.consent) throw new Invalid("serve la presa visione dell'informativa privacy");
      if (meta.photos.some((p) => p.origin === "file_upload")) throw new Invalid("dal pubblico si accettano solo foto scattate con l'app");
      if (meta.photos.some((p) => !p.location)) throw new Invalid("ogni foto deve avere la posizione GPS");
      if (meta.photos.some((p) => !withinPublicArea(c.env, p.location!))) throw new Invalid("la posizione è fuori dall'area coperta dal servizio");
    }
  } catch (e) {
    if (e instanceof Invalid || e instanceof SyntaxError) return c.json({ error: `Segnalazione non valida: ${e.message}` }, 422);
    throw e;
  }

  const existing = await findExisting(c.env, meta);
  if (existing === "conflict") return c.json({ error: "Identificativo già usato per una segnalazione diversa" }, 409);
  if (existing) return c.json({ ...existing, duplicate: true });

  if (!operator && !(await turnstileOk(c, meta.turnstileToken))) {
    return c.json({ error: "Verifica anti-spam non superata. Ricarica la pagina e riprova." }, 403);
  }

  const receivedAt = new Date();
  const receivedIso = receivedAt.toISOString();
  const reportId = newReportId(receivedAt);
  const moderation = operator ? "accettata" : "in_attesa";
  const keys = storageKeys(reportId, moderation === "accettata");

  const manifestPhotos: ManifestPhoto[] = [];
  const photoRows: D1PreparedStatement[] = [];
  const written: string[] = [];

  try {
    for (const photo of meta.photos) {
      const file = form.get(`photo_${photo.index}`);
      if (!(file instanceof File)) throw new Invalid(`manca il file della foto ${photo.index + 1}`);
      if (file.size > MAX_PHOTO_BYTES) throw new Invalid(`la foto ${photo.index + 1} supera i 20 MB`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImageMime(bytes);
      if (!mime) throw new Invalid(`la foto ${photo.index + 1} non è un'immagine supportata`);
      const hash = await sha256Hex(bytes);
      if (hash !== photo.sha256 || bytes.length !== photo.size) {
        throw new Invalid(`la foto ${photo.index + 1} è arrivata diversa da com'era sul telefono (impronta non corrispondente)`);
      }
      if (!operator && mime !== "image/jpeg") throw new Invalid("dal pubblico si accettano solo foto JPEG");

      const exif = mime === "image/jpeg" ? readExif(bytes) : null;
      if (photo.location?.source === "exif" && !exif?.gps) throw new Invalid(`la foto ${photo.index + 1} non contiene GPS nei metadati`);
      const flags = computePhotoFlags({ photo, mime, exif, receivedAt });

      const originalKey = keys.original(photo.index, hash, extensionFor(mime));
      await c.env.EVIDENCE.put(originalKey, bytes, {
        sha256: hash,
        httpMetadata: { contentType: mime },
        customMetadata: { reportId, sha256: hash },
      });
      written.push(originalKey);

      let derivedKey: string | null = null;
      let derivedSha: string | undefined;
      if (mime === "image/jpeg" && photo.location && !exif?.gps) {
        const derived = deriveWithGps(bytes, exif, photo.location, hash);
        derivedSha = await sha256Hex(derived);
        derivedKey = keys.derived(photo.index);
        await c.env.EVIDENCE.put(derivedKey, derived, {
          sha256: derivedSha,
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: { reportId, derivedFrom: hash },
        });
        written.push(derivedKey);
      }

      const mp: ManifestPhoto = { ...photo, mime, flags };
      if (exif) mp.exif = exif;
      if (derivedSha) mp.derivedSha256 = derivedSha;
      manifestPhotos.push(mp);

      photoRows.push(
        c.env.DB.prepare(
          `INSERT INTO photos (report_id, idx, sha256, size, mime, origin, captured_at, lat, lon, accuracy, location_source,
             exif_json, flags_json, original_key, derived_key, derived_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          reportId,
          photo.index,
          hash,
          bytes.length,
          mime,
          photo.origin,
          photo.capturedAt,
          photo.location?.lat ?? null,
          photo.location?.lon ?? null,
          photo.location?.accuracy ?? null,
          photo.location?.source ?? null,
          exif ? JSON.stringify(exif) : null,
          JSON.stringify(flags),
          originalKey,
          derivedKey,
          derivedSha ?? null,
        ),
      );
    }
  } catch (e) {
    // Nothing is in D1 yet, so these objects belong to no report. Quarantine objects delete cleanly; under a
    // retention lock (operator uploads) the delete is refused and the orphan stays, which is harmless.
    await Promise.allSettled(written.map((k) => c.env.EVIDENCE.delete(k)));
    if (e instanceof Invalid) return c.json({ error: e.message }, 422);
    throw e;
  }

  const manifest: Manifest = {
    format: "munnezzachain/manifest",
    version: 1,
    reportId,
    clientReportId: meta.clientReportId,
    receivedAt: receivedIso,
    channel,
    category: meta.category,
    description: meta.description,
    clientCreatedAt: meta.clientCreatedAt,
    queued: meta.queued,
    photos: manifestPhotos,
  };
  if (operator) manifest.submittedBy = operator.id;
  const mBytes = manifestBytes(manifest);
  const manifestSha = await sha256Hex(mBytes);
  await c.env.EVIDENCE.put(keys.manifest, mBytes, {
    sha256: manifestSha,
    httpMetadata: { contentType: "application/json" },
    customMetadata: { reportId },
  });

  const first = meta.photos.find((p) => p.location);
  const warnCount = manifestPhotos.reduce((n, p) => n + p.flags.filter((f) => f.level === "warn").length, 0);
  const cf = (c.req.raw as unknown as { cf?: { country?: string } }).cf;

  const reportRow = c.env.DB.prepare(
    `INSERT INTO reports (id, client_report_id, received_at, channel, submitted_by, category, description, contact, lat, lon,
       location_source, warn_count, manifest_key, manifest_sha256, country, user_agent, moderation, moderated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    reportId,
    meta.clientReportId,
    receivedIso,
    channel,
    operator?.id ?? null,
    meta.category,
    meta.description,
    meta.contact ?? null,
    first?.location?.lat ?? null,
    first?.location?.lon ?? null,
    first?.location?.source ?? null,
    warnCount,
    keys.manifest,
    manifestSha,
    cf?.country ?? null,
    (c.req.header("user-agent") ?? "").slice(0, 300),
    moderation,
    operator ? receivedIso : null,
  );

  let link: ChainRow;
  try {
    link = await appendToChain(c.env, { reportId, manifestSha256: manifestSha, receivedAt: receivedIso }, [reportRow, ...photoRows]);
  } catch (e) {
    if (/client_report_id/.test(String((e as Error).message))) {
      await Promise.allSettled([...written, keys.manifest].map((k) => c.env.EVIDENCE.delete(k)));
      const again = await findExisting(c.env, meta);
      if (again && again !== "conflict") return c.json({ ...again, duplicate: true });
    }
    throw e;
  }

  c.executionCtx.waitUntil(timestampLink(c.env, link));
  await audit(c.env, { userId: operator?.id, action: "segnalazione_ricevuta", reportId, detail: { channel, photos: meta.photos.length } });

  const receipt: Receipt = {
    reportId,
    receivedAt: receivedIso,
    moderation,
    seq: link.seq,
    prevHash: link.prev_hash,
    entryHash: link.entry_hash,
    manifestSha256: manifestSha,
    photos: manifestPhotos.map((p) => ({ index: p.index, sha256: p.sha256, flags: p.flags.map((f) => f.code) })),
    tsaStatus: link.tsa_status,
  };
  return c.json(receipt, 201);
});

function deriveWithGps(bytes: Uint8Array, exif: ExifInfo | null, loc: PhotoLocation, originalSha: string): Uint8Array {
  const info: ExifInfo = {
    make: exif?.make,
    model: exif?.model,
    software: exif?.software,
    dateTime: exif?.dateTime,
    dateTimeOriginal: exif?.dateTimeOriginal,
    offsetTimeOriginal: exif?.offsetTimeOriginal,
    imageDescription: `Copia con GPS derivata da originale sha256:${originalSha} (munnezzachain)`,
    gps: { lat: loc.lat, lon: loc.lon, altitude: loc.altitude, accuracy: loc.accuracy, heading: loc.heading, time: loc.fixTime },
  };
  return replaceExif(bytes, buildExifSegment(info));
}

async function findExisting(env: Env, meta: SubmitMeta): Promise<Receipt | "conflict" | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.received_at, r.moderation, r.manifest_sha256, c.seq, c.prev_hash, c.entry_hash, c.tsa_status
     FROM reports r JOIN chain c ON c.report_id = r.id WHERE r.client_report_id = ?`,
  )
    .bind(meta.clientReportId)
    .first<{ id: string; received_at: string; moderation: string; manifest_sha256: string; seq: number; prev_hash: string; entry_hash: string; tsa_status: ChainRow["tsa_status"] }>();
  if (!row) return null;
  const { results } = await env.DB.prepare("SELECT idx, sha256, flags_json FROM photos WHERE report_id = ? ORDER BY idx")
    .bind(row.id)
    .all<{ idx: number; sha256: string; flags_json: string }>();
  const same = canonicalJson(results.map((r) => r.sha256)) === canonicalJson(meta.photos.map((p) => p.sha256));
  if (!same) return "conflict";
  return {
    reportId: row.id,
    receivedAt: row.received_at,
    moderation: row.moderation === "accettata" ? "accettata" : "in_attesa",
    seq: row.seq,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
    manifestSha256: row.manifest_sha256,
    photos: results.map((r) => ({ index: r.idx, sha256: r.sha256, flags: (JSON.parse(r.flags_json) as { code: string }[]).map((f) => f.code) })),
    tsaStatus: row.tsa_status,
  };
}
