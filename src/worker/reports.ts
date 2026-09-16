import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { CATEGORIES, STATUSES, FLAG_LABELS, chainPreimage, type Flag } from "../shared/model.ts";
import { isSha256Hex } from "../shared/bytes.ts";
import type { ExifInfo } from "../shared/exif.ts";
import type { AppEnv, Env, SessionUser } from "./env.ts";
import { requireActiveOperator } from "./auth.ts";
import { audit } from "./util.ts";
import { storageKeys, QUARANTINE_PREFIX } from "./storage.ts";
import { verifyChain, type ChainRow } from "./chain.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

export interface ReportRow {
  id: string;
  client_report_id: string;
  received_at: string;
  channel: "operatore" | "pubblico";
  submitted_by: string | null;
  submitter_name?: string | null;
  category: keyof typeof CATEGORIES;
  description: string;
  contact: string | null;
  lat: number | null;
  lon: number | null;
  location_source: string | null;
  warn_count: number;
  manifest_key: string;
  manifest_sha256: string;
  country: string | null;
  user_agent: string | null;
  moderation: "in_attesa" | "accettata" | "rifiutata";
  moderated_at: string | null;
  moderated_by: string | null;
  rejection_reason: string | null;
  status: keyof typeof STATUSES;
  status_note: string | null;
  status_updated_at: string | null;
  status_updated_by: string | null;
  photo_count?: number;
}

export interface PhotoRow {
  report_id: string;
  idx: number;
  sha256: string;
  size: number;
  mime: string;
  origin: string;
  captured_at: string;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  location_source: string | null;
  exif_json: string | null;
  flags_json: string;
  original_key: string;
  derived_key: string | null;
  derived_sha256: string | null;
  removed: number;
}

export const REJECTION_REASONS = {
  illecito: "Contenuto illecito",
  dati_personali: "Dati personali non pertinenti (persone, documenti)",
  non_pertinente: "Non riguarda una segnalazione ambientale",
  duplicato: "Duplicato o spam",
  altro: "Altro",
} as const;

export const reports = new Hono<AppEnv>();

/** Operators only ever see accepted reports; quarantine is for admins. */
function canSee(user: SessionUser, r: Pick<ReportRow, "moderation">) {
  return r.moderation === "accettata" || user.role === "admin";
}

async function loadReport(c: Context<AppEnv>, id: string, user: SessionUser): Promise<ReportRow> {
  const r = await c.env.DB.prepare(
    `SELECT r.*, u.name AS submitter_name FROM reports r LEFT JOIN users u ON u.id = r.submitted_by WHERE r.id = ?`,
  )
    .bind(id)
    .first<ReportRow>();
  if (!r || !canSee(user, r)) throw new HTTPException(404, { message: "Segnalazione non trovata" });
  return r;
}

const photoView = (p: PhotoRow) => ({
  index: p.idx,
  sha256: p.sha256,
  size: p.size,
  mime: p.mime,
  origin: p.origin,
  capturedAt: p.captured_at,
  location: p.lat === null ? null : { lat: p.lat, lon: p.lon, accuracy: p.accuracy, source: p.location_source },
  exif: p.exif_json ? (JSON.parse(p.exif_json) as ExifInfo) : null,
  flags: (JSON.parse(p.flags_json) as Flag[]).map((f) => ({ ...f, label: FLAG_LABELS[f.code] })),
  hasDerived: p.derived_key !== null,
  derivedSha256: p.derived_sha256,
  removed: p.removed === 1,
});

reports.get("/", async (c) => {
  const user = requireActiveOperator(c);
  const q = c.req.query();
  const where: string[] = [];
  const args: unknown[] = [];
  const moderation = user.role === "admin" ? (q.moderation ?? "accettata") : "accettata";
  if (moderation !== "tutte") {
    where.push("r.moderation = ?");
    args.push(moderation);
  }
  if (q.status && q.status in STATUSES) {
    where.push("r.status = ?");
    args.push(q.status);
  }
  if (q.category && q.category in CATEGORIES) {
    where.push("r.category = ?");
    args.push(q.category);
  }
  if (q.from) {
    where.push("r.received_at >= ?");
    args.push(q.from);
  }
  if (q.to) {
    where.push("r.received_at < ?");
    args.push(q.to);
  }
  if (q.q) {
    where.push("(r.id LIKE ? OR r.description LIKE ?)");
    args.push(`%${q.q}%`, `%${q.q}%`);
  }
  const limit = Math.min(Number(q.limit) || 200, 1000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const sql = `SELECT r.id, r.received_at, r.channel, r.category, r.description, r.lat, r.lon, r.location_source, r.warn_count,
      r.moderation, r.status, r.rejection_reason, u.name AS submitter_name,
      (SELECT COUNT(*) FROM photos p WHERE p.report_id = r.id) AS photo_count
    FROM reports r LEFT JOIN users u ON u.id = r.submitted_by
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY r.received_at DESC LIMIT ? OFFSET ?`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(...args, limit, offset)
    .all<ReportRow>();
  const pending =
    user.role === "admin"
      ? ((await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE moderation = 'in_attesa'").first<{ n: number }>())?.n ?? 0)
      : undefined;
  return c.json({ reports: results, pendingModeration: pending });
});

reports.get("/:id", async (c) => {
  const user = requireActiveOperator(c);
  const r = await loadReport(c, c.req.param("id"), user);
  const [{ results: photos }, chain, { results: history }] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM photos WHERE report_id = ? ORDER BY idx").bind(r.id).all<PhotoRow>(),
    c.env.DB.prepare("SELECT * FROM chain WHERE report_id = ?").bind(r.id).first<ChainRow>(),
    c.env.DB.prepare(
      `SELECT a.at, a.action, a.detail, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.report_id = ? ORDER BY a.id`,
    )
      .bind(r.id)
      .all<{ at: string; action: string; detail: string | null; user_name: string | null }>(),
  ]);
  await audit(c.env, { userId: user.id, action: "consultazione", reportId: r.id });
  return c.json({
    report: { ...r, user_agent: user.role === "admin" ? r.user_agent : null },
    photos: photos.map(photoView),
    chain: chain && {
      seq: chain.seq,
      prevHash: chain.prev_hash,
      entryHash: chain.entry_hash,
      manifestSha256: chain.manifest_sha256,
      receivedAt: chain.received_at,
      preimage: chainPreimage({ seq: chain.seq, prevHash: chain.prev_hash, manifestSha256: chain.manifest_sha256, receivedAt: chain.received_at }),
      tsa: { status: chain.tsa_status, genTime: chain.tsa_gen_time, error: chain.tsa_error, attempts: chain.tsa_attempts },
    },
    history: history.map((h) => ({ ...h, detail: h.detail ? JSON.parse(h.detail) : null })),
  });
});

reports.get("/:id/photos/:idx/:kind", async (c) => {
  const user = requireActiveOperator(c);
  const r = await loadReport(c, c.req.param("id"), user);
  const p = await c.env.DB.prepare("SELECT * FROM photos WHERE report_id = ? AND idx = ?")
    .bind(r.id, Number(c.req.param("idx")))
    .first<PhotoRow>();
  const kind = c.req.param("kind");
  const key = kind === "originale" ? p?.original_key : kind === "gps" ? p?.derived_key : null;
  if (!p || p.removed || !key) return c.json({ error: "Foto non disponibile" }, 404);
  const obj = await c.env.EVIDENCE.get(key);
  if (!obj) return c.json({ error: "Foto mancante nell'archivio" }, 404);
  const download = c.req.query("download") === "1";
  if (download) await audit(c.env, { userId: user.id, action: "download_foto", reportId: r.id, detail: { foto: p.idx + 1, tipo: kind } });
  const ext = p.mime === "image/jpeg" || kind === "gps" ? "jpg" : p.mime.split("/")[1];
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${r.id}-foto${p.idx + 1}${kind === "gps" ? "-gps" : ""}.${ext}"`,
      "x-content-sha256": kind === "originale" ? p.sha256 : (p.derived_sha256 ?? ""),
    },
  });
});

reports.patch("/:id", async (c) => {
  const user = requireActiveOperator(c);
  const r = await loadReport(c, c.req.param("id"), user);
  if (r.moderation !== "accettata") return c.json({ error: "Prima va completata la moderazione" }, 409);
  const body = await c.req.json<{ status?: string; note?: string }>();
  if (!body.status || !(body.status in STATUSES)) return c.json({ error: "Stato non valido" }, 400);
  const note = (body.note ?? "").trim().slice(0, 2000) || null;
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE reports SET status = ?, status_note = ?, status_updated_at = ?, status_updated_by = ? WHERE id = ?")
    .bind(body.status, note, now, user.id, r.id)
    .run();
  await audit(c.env, { userId: user.id, action: "cambio_stato", reportId: r.id, detail: { da: r.status, a: body.status, nota: note } });
  return c.json({ ok: true });
});

reports.post("/:id/moderazione", async (c) => {
  const user = requireActiveOperator(c, "admin");
  const r = await loadReport(c, c.req.param("id"), user);
  if (r.moderation !== "in_attesa") return c.json({ error: "Questa segnalazione è già stata moderata" }, 409);
  const body = await c.req.json<{ decision?: "accetta" | "rifiuta"; reason?: string; note?: string }>();
  const { results: photos } = await c.env.DB.prepare("SELECT * FROM photos WHERE report_id = ? ORDER BY idx").bind(r.id).all<PhotoRow>();
  const now = new Date().toISOString();

  if (body.decision === "accetta") {
    const keys = storageKeys(r.id, true);
    const updates: D1PreparedStatement[] = [];
    // Copy into the locked prefixes first; only once D1 points at the new keys is quarantine emptied.
    for (const p of photos) {
      const ext = p.original_key.split(".").pop()!;
      const originalKey = keys.original(p.idx, p.sha256, ext);
      await copyObject(c.env, p.original_key, originalKey, p.sha256);
      let derivedKey: string | null = null;
      if (p.derived_key) {
        derivedKey = keys.derived(p.idx);
        await copyObject(c.env, p.derived_key, derivedKey, p.derived_sha256!);
      }
      updates.push(
        c.env.DB.prepare("UPDATE photos SET original_key = ?, derived_key = ? WHERE report_id = ? AND idx = ?").bind(originalKey, derivedKey, r.id, p.idx),
      );
    }
    await copyObject(c.env, r.manifest_key, keys.manifest, r.manifest_sha256);
    updates.push(
      c.env.DB.prepare("UPDATE reports SET manifest_key = ?, moderation = 'accettata', moderated_at = ?, moderated_by = ? WHERE id = ?").bind(
        keys.manifest,
        now,
        user.id,
        r.id,
      ),
    );
    await c.env.DB.batch(updates);
    await purgeQuarantine(c.env, r.id);
    await audit(c.env, { userId: user.id, action: "moderazione_accettata", reportId: r.id, detail: { nota: body.note ?? null } });
    return c.json({ ok: true, moderation: "accettata" });
  }

  if (body.decision === "rifiuta") {
    if (!body.reason || !(body.reason in REJECTION_REASONS)) return c.json({ error: "Indica il motivo del rifiuto" }, 400);
    // Photos first: their trigger only permits removal while the report is still awaiting moderation.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE photos SET removed = 1, exif_json = NULL, lat = NULL, lon = NULL, accuracy = NULL, location_source = NULL, derived_key = NULL
         WHERE report_id = ?`,
      ).bind(r.id),
      c.env.DB.prepare(
        `UPDATE reports SET moderation = 'rifiutata', moderated_at = ?, moderated_by = ?, rejection_reason = ?,
           description = '', contact = NULL, lat = NULL, lon = NULL, location_source = NULL, user_agent = NULL
         WHERE id = ?`,
      ).bind(now, user.id, body.reason, r.id),
    ]);
    await purgeQuarantine(c.env, r.id);
    await audit(c.env, { userId: user.id, action: "moderazione_rifiutata", reportId: r.id, detail: { motivo: body.reason, nota: body.note ?? null } });
    return c.json({ ok: true, moderation: "rifiutata" });
  }

  return c.json({ error: "Decisione non valida" }, 400);
});

async function copyObject(env: Env, from: string, to: string, sha256: string) {
  const src = await env.EVIDENCE.get(from);
  if (!src) {
    // A retried acceptance may already have moved it.
    if (await env.EVIDENCE.head(to)) return;
    throw new Error(`oggetto mancante in quarantena: ${from}`);
  }
  await env.EVIDENCE.put(to, await src.arrayBuffer(), {
    sha256,
    httpMetadata: src.httpMetadata,
    customMetadata: src.customMetadata,
  });
}

async function purgeQuarantine(env: Env, reportId: string) {
  const prefix = `${QUARANTINE_PREFIX}${reportId}/`;
  let cursor: string | undefined;
  do {
    const list = await env.EVIDENCE.list({ prefix, cursor });
    if (list.objects.length) await env.EVIDENCE.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

// ---------------------------------------------------------------------------------------------
// Evidence package

reports.get("/:id/pacchetto.zip", async (c) => {
  const user = requireActiveOperator(c);
  const r = await loadReport(c, c.req.param("id"), user);
  if (r.moderation !== "accettata") return c.json({ error: "Il pacchetto è disponibile solo per segnalazioni accettate" }, 409);
  const [{ results: photos }, chain] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM photos WHERE report_id = ? ORDER BY idx").bind(r.id).all<PhotoRow>(),
    c.env.DB.prepare("SELECT * FROM chain WHERE report_id = ?").bind(r.id).first<ChainRow>(),
  ]);
  if (!chain) throw new Error("voce di catena mancante");
  const prev = await c.env.DB.prepare("SELECT seq, entry_hash, report_id FROM chain WHERE seq = ?").bind(chain.seq - 1).first();

  const entries: ZipEntry[] = [];
  const sums: string[] = [];
  const date = new Date(r.received_at);
  const add = (name: string, data: Uint8Array, sha?: string) => {
    entries.push({ name, data, date });
    if (sha) sums.push(`${sha}  ${name}`);
  };

  for (const p of photos) {
    const orig = await c.env.EVIDENCE.get(p.original_key);
    if (!orig) throw new Error(`foto ${p.idx + 1} mancante`);
    const ext = p.original_key.split(".").pop();
    add(`originali/foto-${p.idx + 1}.${ext}`, new Uint8Array(await orig.arrayBuffer()), p.sha256);
    if (p.derived_key) {
      const d = await c.env.EVIDENCE.get(p.derived_key);
      if (d) add(`copie-con-gps/foto-${p.idx + 1}-gps.jpg`, new Uint8Array(await d.arrayBuffer()), p.derived_sha256 ?? undefined);
    }
  }
  const manifest = await c.env.EVIDENCE.get(r.manifest_key);
  if (!manifest) throw new Error("manifest mancante");
  add("manifest.json", new Uint8Array(await manifest.arrayBuffer()), r.manifest_sha256);

  const enc = new TextEncoder();
  const chainInfo = {
    seq: chain.seq,
    prevHash: chain.prev_hash,
    entryHash: chain.entry_hash,
    manifestSha256: chain.manifest_sha256,
    receivedAt: chain.received_at,
    preimage: chainPreimage({ seq: chain.seq, prevHash: chain.prev_hash, manifestSha256: chain.manifest_sha256, receivedAt: chain.received_at }),
    previousEntry: prev ?? null,
    timestamp: { status: chain.tsa_status, genTime: chain.tsa_gen_time, tsaUrl: c.env.TSA_URL || null },
  };
  add("catena.json", enc.encode(JSON.stringify(chainInfo, null, 2)));
  if (chain.tsa_key) {
    const tsr = await c.env.EVIDENCE.get(chain.tsa_key);
    if (tsr) add("marca-temporale.tsr", new Uint8Array(await tsr.arrayBuffer()));
  }
  const { results: history } = await c.env.DB.prepare(
    `SELECT a.at, a.action, u.name AS utente, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.report_id = ? ORDER BY a.id`,
  )
    .bind(r.id)
    .all();
  add("registro-accessi.json", enc.encode(JSON.stringify(history, null, 2)));
  add("SHA256SUMS", enc.encode(sums.join("\n") + "\n"));
  add("LEGGIMI.txt", enc.encode(readme(r, chainInfo.preimage, chain)));

  await audit(c.env, { userId: user.id, action: "export_pacchetto", reportId: r.id });
  return new Response(buildZip(entries), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="segnalazione-${r.id}.zip"`,
      "cache-control": "private, no-store",
    },
  });
});

function readme(r: ReportRow, preimage: string, chain: ChainRow): string {
  return `PACCHETTO PROBATORIO — SEGNALAZIONE ${r.id}

Ricevuta dal server: ${r.received_at}
Categoria: ${CATEGORIES[r.category]}
Canale: ${r.channel}

CONTENUTO
  originali/        le foto esattamente come sono arrivate dal telefono
  copie-con-gps/    (se presenti) copie con la posizione scritta nei metadati EXIF, per
                    l'importazione in strumenti cartografici. NON sono l'originale: ogni copia
                    dichiara nel campo ImageDescription l'impronta dell'originale da cui deriva.
  manifest.json     i dati della segnalazione, nella forma esatta di cui è calcolata l'impronta
  catena.json       la posizione della segnalazione nella catena di impronte
  marca-temporale.tsr  marca temporale RFC 3161 sull'impronta della voce di catena
  registro-accessi.json  chi ha ricevuto, moderato, consultato ed esportato la segnalazione

VERIFICA
1. Impronte dei file:
     shasum -a 256 -c SHA256SUMS

2. Voce di catena: l'impronta SHA-256 della stringa seguente (senza a capo finale)
     ${preimage}
   deve valere
     ${chain.entry_hash}
   Comando:  printf '%s' '${preimage}' | shasum -a 256

3. Marca temporale (serve il certificato della TSA, es. per FreeTSA cacert.pem e tsa.crt):
     openssl ts -verify -digest ${chain.entry_hash} -in marca-temporale.tsr \\
       -CAfile cacert.pem -untrusted tsa.crt

4. Collegamento con la voce precedente: "prevHash" in catena.json deve coincidere con
   l'impronta della voce precedente, verificabile anche su /verifica del servizio.
`;
}

// ---------------------------------------------------------------------------------------------
// Map exports and chain verification

export const exportsApi = new Hono<AppEnv>();

async function acceptedReports(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.received_at, r.channel, r.category, r.description, r.lat, r.lon, r.location_source, r.warn_count, r.status,
       c.seq, c.entry_hash, c.tsa_gen_time
     FROM reports r JOIN chain c ON c.report_id = r.id WHERE r.moderation = 'accettata' ORDER BY r.received_at`,
  ).all<ReportRow & { seq: number; entry_hash: string; tsa_gen_time: string | null }>();
  return results;
}

exportsApi.get("/segnalazioni.geojson", async (c) => {
  const user = requireActiveOperator(c);
  const rows = await acceptedReports(c.env);
  await audit(c.env, { userId: user.id, action: "export_geojson", detail: { segnalazioni: rows.length } });
  const fc = {
    type: "FeatureCollection",
    features: rows
      .filter((r) => r.lat !== null && r.lon !== null)
      .map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        properties: {
          id: r.id,
          ricevuta: r.received_at,
          categoria: CATEGORIES[r.category],
          stato: STATUSES[r.status],
          descrizione: r.description,
          origine_posizione: r.location_source,
          avvisi: r.warn_count,
          canale: r.channel,
          catena_seq: r.seq,
          catena_impronta: r.entry_hash,
          marca_temporale: r.tsa_gen_time,
        },
      })),
  };
  return new Response(JSON.stringify(fc, null, 2), {
    headers: { "content-type": "application/geo+json", "content-disposition": 'attachment; filename="segnalazioni.geojson"' },
  });
});

exportsApi.get("/segnalazioni.csv", async (c) => {
  const user = requireActiveOperator(c);
  const rows = await acceptedReports(c.env);
  await audit(c.env, { userId: user.id, action: "export_csv", detail: { segnalazioni: rows.length } });
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Prefix formula-looking cells so spreadsheets don't execute them.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const header = ["id", "ricevuta", "categoria", "stato", "latitudine", "longitudine", "origine_posizione", "avvisi", "canale", "descrizione", "catena_seq", "catena_impronta", "marca_temporale"];
  const lines = rows.map((r) =>
    [r.id, r.received_at, CATEGORIES[r.category], STATUSES[r.status], r.lat, r.lon, r.location_source, r.warn_count, r.channel, r.description, r.seq, r.entry_hash, r.tsa_gen_time]
      .map(esc)
      .join(";"),
  );
  return new Response("﻿" + [header.join(";"), ...lines].join("\r\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="segnalazioni.csv"' },
  });
});

exportsApi.get("/catena/verifica", async (c) => {
  const user = requireActiveOperator(c, "admin");
  const deep = c.req.query("completa") === "1";
  const result = await verifyChain(c.env, deep);
  await audit(c.env, { userId: user.id, action: "verifica_catena", detail: { completa: deep, esito: result.ok, voci: result.length } });
  return c.json(result);
});

// ---------------------------------------------------------------------------------------------
// Public verification: hashes in, provenance facts out. Never content, location or personal data.

export const verify = new Hono<AppEnv>();

verify.get("/testa", async (c) => {
  const head = await c.env.DB.prepare("SELECT seq, entry_hash, received_at FROM chain ORDER BY seq DESC LIMIT 1").first<{
    seq: number;
    entry_hash: string;
    received_at: string;
  }>();
  return c.json({ length: head?.seq ?? 0, head: head?.entry_hash ?? null, lastReceivedAt: head?.received_at ?? null });
});

verify.get("/:hash", async (c) => {
  const hash = c.req.param("hash").toLowerCase();
  if (!isSha256Hex(hash)) return c.json({ error: "Serve un'impronta SHA-256 di 64 caratteri esadecimali" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT c.seq, c.prev_hash, c.entry_hash, c.manifest_sha256, c.received_at, c.tsa_status, c.tsa_gen_time, r.id, r.moderation,
       CASE
         WHEN c.entry_hash = ?1 THEN 'voce_catena'
         WHEN c.manifest_sha256 = ?1 THEN 'manifest'
         WHEN EXISTS (SELECT 1 FROM photos p WHERE p.report_id = r.id AND p.sha256 = ?1) THEN 'foto_originale'
         ELSE 'copia_con_gps'
       END AS kind
     FROM chain c JOIN reports r ON r.id = c.report_id
     WHERE c.entry_hash = ?1 OR c.manifest_sha256 = ?1
        OR r.id IN (SELECT report_id FROM photos WHERE sha256 = ?1 OR derived_sha256 = ?1)
     ORDER BY c.seq LIMIT 1`,
  )
    .bind(hash)
    .first<{ seq: number; prev_hash: string; entry_hash: string; manifest_sha256: string; received_at: string; tsa_status: string; tsa_gen_time: string | null; id: string; moderation: string; kind: string }>();
  if (!row) return c.json({ found: false });
  return c.json({
    found: true,
    kind: row.kind,
    reportId: row.id,
    moderation: row.moderation,
    receivedAt: row.received_at,
    seq: row.seq,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
    manifestSha256: row.manifest_sha256,
    preimage: chainPreimage({ seq: row.seq, prevHash: row.prev_hash, manifestSha256: row.manifest_sha256, receivedAt: row.received_at }),
    timestamp: { status: row.tsa_status, genTime: row.tsa_gen_time },
  });
});

verify.get("/:hash/marca-temporale.tsr", async (c) => {
  const hash = c.req.param("hash").toLowerCase();
  if (!isSha256Hex(hash)) return c.json({ error: "Impronta non valida" }, 400);
  const row = await c.env.DB.prepare("SELECT tsa_key FROM chain WHERE entry_hash = ?").bind(hash).first<{ tsa_key: string | null }>();
  const obj = row?.tsa_key ? await c.env.EVIDENCE.get(row.tsa_key) : null;
  if (!obj) return c.json({ error: "Marca temporale non disponibile" }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "application/timestamp-reply", "content-disposition": `attachment; filename="${hash.slice(0, 16)}.tsr"` },
  });
});
