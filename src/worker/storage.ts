// Quarantined public reports live under a prefix with no retention lock, so an admin can destroy unlawful
// content. Accepted evidence is moved under prefixes covered by R2 bucket lock rules (see docs/deploy.md).

import { toHex, sha256Hex } from "../shared/bytes.ts";
import type { Env } from "./env.ts";

export const QUARANTINE_PREFIX = "quarantena/";

export function storageKeys(reportId: string, accepted: boolean) {
  const q = accepted ? "" : `${QUARANTINE_PREFIX}${reportId}/`;
  return {
    manifest: accepted ? `manifests/${reportId}.json` : `${q}manifest.json`,
    original: (idx: number, sha: string, ext: string) => (accepted ? `originals/${reportId}/` : q) + `${idx + 1}-${sha}.${ext}`,
    derived: (idx: number) => (accepted ? `derived/${reportId}/` : q) + `${idx + 1}-gps.jpg`,
  };
}

const inQuarantine = (key: string | null) => key !== null && key.startsWith(QUARANTINE_PREFIX);

/**
 * Copies an object to a locked prefix. A locked key refuses overwrites, so a retried move must find its
 * earlier copy and check it holds the same bytes instead of writing again.
 */
async function copyObject(env: Env, from: string, to: string, sha256: string) {
  const existing = await env.EVIDENCE.head(to);
  if (existing) {
    const stored = existing.checksums.sha256 ? toHex(existing.checksums.sha256) : await sha256Hex(await (await env.EVIDENCE.get(to))!.arrayBuffer());
    if (stored !== sha256) throw new Error(`archivio: ${to} esiste già con un contenuto diverso`);
    return;
  }
  const src = await env.EVIDENCE.get(from);
  if (!src) throw new Error(`oggetto mancante in quarantena: ${from}`);
  await env.EVIDENCE.put(to, await src.arrayBuffer(), { sha256, httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
}

/**
 * Moves an accepted report's files out of quarantine. Runs after the acceptance is committed, and is safe to
 * repeat: an interrupted move is completed by the next call (the cron sweep calls it too).
 */
export async function moveToArchive(env: Env, reportId: string): Promise<void> {
  const report = await env.DB.prepare("SELECT manifest_key, manifest_sha256, moderation FROM reports WHERE id = ?")
    .bind(reportId)
    .first<{ manifest_key: string; manifest_sha256: string; moderation: string }>();
  if (!report || report.moderation !== "accettata") throw new Error(`segnalazione ${reportId} non accettata`);
  const { results: photos } = await env.DB.prepare(
    "SELECT idx, sha256, original_key, derived_key, derived_sha256 FROM photos WHERE report_id = ? ORDER BY idx",
  )
    .bind(reportId)
    .all<{ idx: number; sha256: string; original_key: string; derived_key: string | null; derived_sha256: string | null }>();

  const keys = storageKeys(reportId, true);
  const updates: D1PreparedStatement[] = [];
  for (const p of photos) {
    let originalKey = p.original_key;
    let derivedKey = p.derived_key;
    if (inQuarantine(originalKey)) {
      originalKey = keys.original(p.idx, p.sha256, p.original_key.split(".").pop()!);
      await copyObject(env, p.original_key, originalKey, p.sha256);
    }
    if (inQuarantine(derivedKey)) {
      derivedKey = keys.derived(p.idx);
      await copyObject(env, p.derived_key!, derivedKey, p.derived_sha256!);
    }
    if (originalKey !== p.original_key || derivedKey !== p.derived_key) {
      updates.push(
        env.DB.prepare("UPDATE photos SET original_key = ?, derived_key = ? WHERE report_id = ? AND idx = ?").bind(originalKey, derivedKey, reportId, p.idx),
      );
    }
  }
  if (inQuarantine(report.manifest_key)) {
    await copyObject(env, report.manifest_key, keys.manifest, report.manifest_sha256);
    updates.push(env.DB.prepare("UPDATE reports SET manifest_key = ? WHERE id = ?").bind(keys.manifest, reportId));
  }
  // Quarantine is emptied only once D1 points at the archived copies.
  if (updates.length) await env.DB.batch(updates);
  await purgeQuarantine(env, reportId);
}

export async function purgeQuarantine(env: Env, reportId: string) {
  const prefix = `${QUARANTINE_PREFIX}${reportId}/`;
  let cursor: string | undefined;
  do {
    const list = await env.EVIDENCE.list({ prefix, cursor });
    if (list.objects.length) await env.EVIDENCE.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

/** Files of a failed submission are not deleted until the submission has surely ended. */
const ORPHAN_AGE_MS = 60 * 60_000;

/**
 * Finishes what an interrupted request left in quarantine: moves of accepted reports, purges of rejected ones,
 * and files of submissions that never reached the database. Pending reports are left alone.
 */
export async function sweepQuarantine(env: Env, maxActions = 10): Promise<number> {
  const listing = await env.EVIDENCE.list({ prefix: QUARANTINE_PREFIX, delimiter: "/" });
  const ids = listing.delimitedPrefixes.map((p) => p.slice(QUARANTINE_PREFIX.length, -1)).filter(Boolean);
  let actions = 0;
  for (let i = 0; i < ids.length && actions < maxActions; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT id, moderation FROM reports WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ id: string; moderation: string }>();
    const moderation = new Map(results.map((r) => [r.id, r.moderation]));
    for (const id of chunk) {
      if (actions >= maxActions) break;
      const state = moderation.get(id);
      if (state === "in_attesa") continue;
      try {
        if (state === "accettata") await moveToArchive(env, id);
        else if (state === "rifiutata") await purgeQuarantine(env, id);
        else {
          const { objects } = await env.EVIDENCE.list({ prefix: `${QUARANTINE_PREFIX}${id}/` });
          if (objects.some((o) => Date.now() - o.uploaded.getTime() < ORPHAN_AGE_MS)) continue;
          await purgeQuarantine(env, id);
        }
        actions++;
      } catch (e) {
        console.error(`pulizia quarantena ${id}`, e);
      }
    }
  }
  return actions;
}
