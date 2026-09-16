import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { sha256Hex, toHex } from "../shared/bytes.ts";
import { hashPassword, verifyPassword } from "../shared/password.ts";
import type { AppEnv, SessionUser } from "./env.ts";
import { audit, clientIp } from "./util.ts";

const COOKIE = "mc_session";
const SESSION_DAYS = 30;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "operatore" | "admin";
  password_hash: string;
  active: number;
  must_change_password: number;
}

const toSessionUser = (r: UserRow): SessionUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  mustChangePassword: r.must_change_password === 1,
});

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  const token = getCookie(c, COOKIE);
  if (token) {
    const row = await c.env.DB.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
      .bind(await sha256Hex(token), new Date().toISOString())
      .first<UserRow>();
    if (row) c.set("user", toSessionUser(row));
  }
  await next();
};

export function requireUser(c: Context<AppEnv>, role?: "admin"): SessionUser {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Accesso richiesto" });
  if (role === "admin" && user.role !== "admin") throw new HTTPException(403, { message: "Serve un account amministratore" });
  return user;
}

/** Operators must replace a password an admin handed them before touching evidence. */
export function requireActiveOperator(c: Context<AppEnv>, role?: "admin"): SessionUser {
  const user = requireUser(c, role);
  if (user.mustChangePassword) throw new HTTPException(403, { message: "Cambia la password prima di continuare" });
  return user;
}

export const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: clientIp(c) });
  if (!success) return c.json({ error: "Troppi tentativi, riprova tra un minuto" }, 429);

  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "");
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  const ok = row && row.active === 1 && (await verifyPassword(password, row.password_hash));
  if (!row || !ok) {
    await audit(c.env, { action: "login_fallito", detail: { email } });
    return c.json({ error: "Email o password non corretti" }, 401);
  }

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), row.id, now.toISOString(), expires.toISOString())
    .run();
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", expires });
  await audit(c.env, { userId: row.id, action: "login" });
  return c.json({ user: toSessionUser(row) });
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

auth.get("/me", (c) => c.json({ user: c.get("user") }));

auth.post("/password", async (c) => {
  const user = requireUser(c);
  const { current, next } = await c.req.json<{ current?: string; next?: string }>();
  if (!next || next.length < 12) return c.json({ error: "La nuova password deve avere almeno 12 caratteri" }, 400);
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  if (!row || !(await verifyPassword(String(current ?? ""), row.password_hash))) {
    return c.json({ error: "La password attuale non è corretta" }, 400);
  }
  const token = getCookie(c, COOKIE);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").bind(await hashPassword(next), user.id),
    // Sign out every other device that knew the old password.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, token ? await sha256Hex(token) : ""),
  ]);
  await audit(c.env, { userId: user.id, action: "cambio_password" });
  return c.json({ ok: true });
});
