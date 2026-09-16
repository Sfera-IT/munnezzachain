import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env.ts";

export const clientIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? "sconosciuto";

/** A malformed or missing JSON body is the client's error (400), not a crash (500). */
export async function readJson<T extends object>(c: Context<AppEnv>): Promise<Partial<T>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HTTPException(400, { message: "Richiesta non leggibile" });
  return body as Partial<T>;
}

export async function audit(
  env: Env,
  entry: { userId?: string | null; action: string; reportId?: string; detail?: unknown },
): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (at, user_id, action, report_id, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(
      new Date().toISOString(),
      entry.userId ?? null,
      entry.action,
      entry.reportId ?? null,
      entry.detail == null ? null : JSON.stringify(entry.detail),
    )
    .run();
}

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Human-readable, date-sortable report code, e.g. 20260916-K7Q2M9XP. */
export function newReportId(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => BASE32[b % 32]).join("");
  return `${day}-${rand}`;
}
