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

/**
 * Cloudflare Turnstile. Without a secret configured the check is off (local development); with one, a missing or
 * rejected token fails. An unreachable siteverify throws: the request fails as a server error and can be retried.
 */
export async function turnstileOk(c: Context<AppEnv>, token: unknown): Promise<boolean> {
  if (!c.env.TURNSTILE_SECRET_KEY) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token, remoteip: clientIp(c) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Turnstile siteverify: HTTP ${res.status}`);
  const data = await res.json<{ success: boolean }>();
  return data.success === true;
}

/** Tells the app the anti-spam check failed, so it fetches a new token instead of giving up. */
export const TURNSTILE_FAILED = { error: "Verifica anti-spam non superata. Riprova.", code: "turnstile" } as const;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Human-readable, date-sortable report code, e.g. 20260916-K7Q2M9XP. */
export function newReportId(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => BASE32[b % 32]).join("");
  return `${day}-${rand}`;
}
