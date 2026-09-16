import { GENESIS_HASH, entryHash } from "../shared/model.ts";
import { sha256Hex } from "../shared/bytes.ts";
import type { Env } from "./env.ts";
import { requestTimestamp } from "./tsa.ts";

export interface ChainRow {
  seq: number;
  report_id: string;
  manifest_sha256: string;
  prev_hash: string;
  entry_hash: string;
  received_at: string;
  tsa_status: "pending" | "granted" | "error" | "disabled";
  tsa_key: string | null;
  tsa_gen_time: string | null;
  tsa_error: string | null;
  tsa_attempts: number;
}

/**
 * Appends a link and commits `statements` (the report and photo rows) in the same D1 transaction, so a
 * report can never exist without its link. Losing a race on seq aborts the batch and we retry.
 */
export async function appendToChain(
  env: Env,
  link: { reportId: string; manifestSha256: string; receivedAt: string },
  statements: D1PreparedStatement[],
): Promise<ChainRow> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const last = await env.DB.prepare("SELECT seq, entry_hash FROM chain ORDER BY seq DESC LIMIT 1").first<{ seq: number; entry_hash: string }>();
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.entry_hash ?? GENESIS_HASH;
    const hash = await entryHash({ seq, prevHash, manifestSha256: link.manifestSha256, receivedAt: link.receivedAt });
    try {
      await env.DB.batch([
        ...statements,
        env.DB.prepare(
          "INSERT INTO chain (seq, report_id, manifest_sha256, prev_hash, entry_hash, received_at, tsa_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(seq, link.reportId, link.manifestSha256, prevHash, hash, link.receivedAt, env.TSA_URL ? "pending" : "disabled"),
      ]);
      return {
        seq,
        report_id: link.reportId,
        manifest_sha256: link.manifestSha256,
        prev_hash: prevHash,
        entry_hash: hash,
        received_at: link.receivedAt,
        tsa_status: env.TSA_URL ? "pending" : "disabled",
        tsa_key: null,
        tsa_gen_time: null,
        tsa_error: null,
        tsa_attempts: 0,
      };
    } catch (e) {
      const msg = String((e as Error).message);
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(msg) || /client_report_id/.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
    }
  }
  throw new Error("impossibile aggiungere la voce alla catena: troppe scritture concorrenti");
}

export async function timestampLink(env: Env, row: Pick<ChainRow, "seq" | "report_id" | "entry_hash" | "tsa_attempts">): Promise<void> {
  if (!env.TSA_URL) return;
  let status: ChainRow["tsa_status"] = "error";
  let key: string | null = null;
  let genTime: string | null = null;
  let error: string | null = null;
  try {
    const { result, response } = await requestTimestamp(
      { url: env.TSA_URL, username: env.TSA_USERNAME, password: env.TSA_PASSWORD },
      row.entry_hash,
    );
    if (result.granted && response) {
      // One key per attempt: tsa/ is under a retention lock, which refuses to overwrite an earlier token.
      key = `tsa/${row.report_id}-${Date.now()}.tsr`;
      await env.EVIDENCE.put(key, response, {
        httpMetadata: { contentType: "application/timestamp-reply" },
        customMetadata: { entryHash: row.entry_hash, seq: String(row.seq) },
      });
      status = "granted";
      genTime = result.genTime ?? null;
    } else {
      error = result.error ?? "richiesta non accolta";
    }
  } catch (e) {
    key = null;
    status = "error";
    error = `TSA non raggiungibile: ${(e as Error).message}`;
  }
  // A token already recorded by a concurrent attempt is never replaced, least of all by a failure.
  await env.DB.prepare(
    "UPDATE chain SET tsa_status = ?, tsa_key = ?, tsa_gen_time = ?, tsa_error = ?, tsa_attempts = tsa_attempts + 1 WHERE seq = ? AND tsa_status <> 'granted'",
  )
    .bind(status, key, genTime, error, row.seq)
    .run();
}

/** Links younger than this are still being timestamped by the request that created them. */
const TSA_GRACE_MS = 5 * 60_000;

export async function retryPendingTimestamps(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM chain WHERE tsa_attempts < 50 AND (tsa_status = 'error' OR (tsa_status = 'pending' AND received_at < ?))
     ORDER BY seq LIMIT 10`,
  )
    .bind(new Date(Date.now() - TSA_GRACE_MS).toISOString())
    .all<ChainRow>();
  for (const row of results) await timestampLink(env, row);
  return results.length;
}

export interface ChainProblem {
  seq: number;
  reportId: string;
  problem: string;
}

/** A deep check reads every file of a report: batches keep one request within the Worker's CPU and subrequest limits. */
export const DEEP_BATCH = 25;

/**
 * Recomputes links from `from` on; with `deep`, also re-hashes each stored manifest and original photo, and stops
 * after DEEP_BATCH links. `next` is where the following batch starts, or null when the chain has been covered.
 */
export async function verifyChain(
  env: Env,
  deep: boolean,
  from = 1,
): Promise<{ ok: boolean; from: number; length: number; head: string; problems: ChainProblem[]; next: number | null }> {
  const problems: ChainProblem[] = [];
  let prev = GENESIS_HASH;
  if (from > 1) {
    const before = await env.DB.prepare("SELECT entry_hash FROM chain WHERE seq = ?").bind(from - 1).first<{ entry_hash: string }>();
    if (!before) return { ok: false, from, length: 0, head: prev, problems: [{ seq: from - 1, reportId: "", problem: "anello mancante" }], next: null };
    prev = before.entry_hash;
  }
  let expectedSeq = from;
  let length = 0;
  const pageSize = deep ? DEEP_BATCH : 500;
  for (let offset = 0; ; offset += pageSize) {
    const { results } = await env.DB.prepare("SELECT * FROM chain WHERE seq >= ? ORDER BY seq LIMIT ? OFFSET ?").bind(from, pageSize, offset).all<ChainRow>();
    for (const row of results) {
      length++;
      const p = (problem: string) => problems.push({ seq: row.seq, reportId: row.report_id, problem });
      if (row.seq !== expectedSeq) p(`numerazione interrotta: atteso ${expectedSeq}`);
      if (row.prev_hash !== prev) p("l'impronta precedente non coincide con la voce prima");
      const recomputed = await entryHash({ seq: row.seq, prevHash: row.prev_hash, manifestSha256: row.manifest_sha256, receivedAt: row.received_at });
      if (recomputed !== row.entry_hash) p("l'impronta della voce non corrisponde ai suoi dati");
      if (deep) {
        // Rejected reports keep only their hashes: their content was destroyed on purpose.
        const report = await env.DB.prepare("SELECT manifest_key, moderation FROM reports WHERE id = ?")
          .bind(row.report_id)
          .first<{ manifest_key: string; moderation: string }>();
        if (!report) p("segnalazione mancante nel database");
        else if (report.moderation !== "rifiutata") {
          const manifest = await env.EVIDENCE.get(report.manifest_key);
          if (!manifest) p("manifest mancante nell'archivio");
          else if ((await sha256Hex(await manifest.arrayBuffer())) !== row.manifest_sha256) p("il manifest archiviato è stato alterato");
          const { results: photos } = await env.DB.prepare("SELECT idx, sha256, original_key FROM photos WHERE report_id = ? AND removed = 0")
            .bind(row.report_id)
            .all<{ idx: number; sha256: string; original_key: string }>();
          for (const ph of photos) {
            const obj = await env.EVIDENCE.get(ph.original_key);
            if (!obj) p(`foto ${ph.idx + 1} mancante nell'archivio`);
            else if ((await sha256Hex(await obj.arrayBuffer())) !== ph.sha256) p(`foto ${ph.idx + 1} alterata nell'archivio`);
          }
        }
      }
      prev = row.entry_hash;
      expectedSeq = row.seq + 1;
    }
    if (deep) return { ok: problems.length === 0, from, length, head: prev, problems, next: results.length < pageSize ? null : expectedSeq };
    if (results.length < pageSize) break;
  }
  return { ok: problems.length === 0, from, length, head: prev, problems, next: null };
}
