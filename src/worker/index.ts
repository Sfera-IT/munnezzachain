import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env.ts";
import { auth, loadSession } from "./auth.ts";
import { submit } from "./submit.ts";
import { reports, exportsApi, verify, REJECTION_REASONS } from "./reports.ts";
import { users } from "./users.ts";
import { retryPendingTimestamps } from "./chain.ts";

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", async (c, next) => {
  // Cookies are SameSite=Strict; the Origin check is the second lock on every state-changing request.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Origine non consentita" }, 403);
  }
  await next();
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
  c.header("x-content-type-options", "nosniff");
  if (c.env.APP_VERSION) c.header("x-app-version", c.env.APP_VERSION);
});

app.use("*", loadSession);

app.get("/config", (c) =>
  c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    publicAreaBbox: c.env.PUBLIC_AREA_BBOX ? c.env.PUBLIC_AREA_BBOX.split(",").map(Number) : null,
    privacyContact: c.env.PRIVACY_CONTACT || null,
    timestamping: Boolean(c.env.TSA_URL),
    rejectionReasons: REJECTION_REASONS,
  }),
);

app.route("/auth", auth);
app.route("/segnalazioni", submit);
app.route("/segnalazioni", reports);
app.route("/export", exportsApi);
app.route("/verifica", verify);
app.route("/utenti", users);

app.notFound((c) => c.json({ error: "Risorsa non trovata" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Errore interno. Riprova tra poco." }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(retryPendingTimestamps(env));
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run());
  },
} satisfies ExportedHandler<Env>;
