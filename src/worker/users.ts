import { Hono } from "hono";
import { generatePassword, hashPassword } from "../shared/password.ts";
import type { AppEnv } from "./env.ts";
import { requireActiveOperator } from "./auth.ts";
import { audit } from "./util.ts";

export const users = new Hono<AppEnv>();

const ROLES = ["operatore", "admin"] as const;

users.get("/", async (c) => {
  requireActiveOperator(c, "admin");
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, role, active, must_change_password, created_at FROM users ORDER BY active DESC, name",
  ).all();
  return c.json({ users: results });
});

users.post("/", async (c) => {
  const admin = requireActiveOperator(c, "admin");
  const body = await c.req.json<{ email?: string; name?: string; role?: string }>();
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Email non valida" }, 400);
  if (name.length < 2) return c.json({ error: "Indica il nome" }, 400);
  if (!ROLES.includes(body.role as (typeof ROLES)[number])) return c.json({ error: "Ruolo non valido" }, 400);
  const password = generatePassword();
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)",
    )
      .bind(id, email, name, body.role, await hashPassword(password), new Date().toISOString())
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return c.json({ error: "Esiste già un utente con questa email" }, 409);
    throw e;
  }
  await audit(c.env, { userId: admin.id, action: "utente_creato", detail: { id, email, role: body.role } });
  // The temporary password is shown once to the admin and never stored in clear.
  return c.json({ id, temporaryPassword: password }, 201);
});

users.patch("/:id", async (c) => {
  const admin = requireActiveOperator(c, "admin");
  const id = c.req.param("id");
  const body = await c.req.json<{ active?: boolean; role?: string; resetPassword?: boolean }>();
  if (id === admin.id && (body.active === false || (body.role && body.role !== "admin"))) {
    return c.json({ error: "Non puoi disattivare o declassare il tuo stesso account" }, 400);
  }
  const statements: D1PreparedStatement[] = [];
  let temporaryPassword: string | undefined;
  if (typeof body.active === "boolean") {
    statements.push(c.env.DB.prepare("UPDATE users SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id));
    if (!body.active) statements.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role as (typeof ROLES)[number])) return c.json({ error: "Ruolo non valido" }, 400);
    statements.push(c.env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, id));
  }
  if (body.resetPassword) {
    temporaryPassword = generatePassword();
    statements.push(
      c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").bind(await hashPassword(temporaryPassword), id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    );
  }
  if (!statements.length) return c.json({ error: "Nessuna modifica" }, 400);
  await c.env.DB.batch(statements);
  await audit(c.env, {
    userId: admin.id,
    action: "utente_modificato",
    detail: { id, active: body.active, role: body.role, resetPassword: body.resetPassword === true },
  });
  return c.json({ ok: true, temporaryPassword });
});
