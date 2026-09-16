// Starts an isolated local instance (fresh D1/R2 state, generous public rate limit, no external TSA),
// then runs the API and browser end-to-end tests against it.
// Usage: npm run test:e2e   (needs Chrome/Chromium; set CHROME_PATH if it is not found)
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "../../src/shared/password.ts";
import { runApiTests, runRateLimitTest } from "./api.ts";
import { runUiTests } from "./ui.ts";
import { passed } from "./assert.ts";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const base = `http://localhost:${PORT}`;
const root = new URL("../../", import.meta.url).pathname;
const persist = mkdtempSync(join(tmpdir(), "munnezzachain-e2e-"));
const config = join(root, ".wrangler.e2e.jsonc");
const skipUi = process.argv.includes("--solo-api");

function wrangler(args: string[]) {
  execFileSync("npx", ["wrangler", ...args, "-c", config], { cwd: root, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
}

function build(version: string) {
  execFileSync("node", ["scripts/build-web.ts"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, APP_VERSION: version } });
}

// Same bindings as production, adjusted for a test run: the text edits fail loudly if the config drifts.
function writeConfig() {
  let c = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const edit = (from: RegExp, to: string) => {
    if (!from.test(c)) throw new Error(`wrangler.jsonc non contiene ${from}: aggiorna test/e2e/run.ts`);
    c = c.replace(from, to);
  };
  edit(/"name": "PUBLIC_SUBMIT_LIMITER", "namespace_id": "(\d+)", "simple": \{ "limit": \d+/, '"name": "PUBLIC_SUBMIT_LIMITER", "namespace_id": "$1", "simple": { "limit": 1000');
  edit(/"TSA_URL": "[^"]*"/, '"TSA_URL": ""');
  edit(/\s*"routes": \[[^\]]*\],/, "");
  writeFileSync(config, c);
}

async function waitReady(proc: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error("wrangler dev è terminato durante l'avvio");
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev non risponde");
}

let dev: ChildProcess | undefined;
let log = "";
try {
  writeConfig();
  build("e2e-1");
  wrangler(["d1", "migrations", "apply", "munnezzachain", "--local", "--persist-to", persist]);
  const adminPassword = "password-provvisoria-e2e";
  const hash = await hashPassword(adminPassword);
  wrangler([
    "d1", "execute", "munnezzachain", "--local", "--persist-to", persist, "--command",
    `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at) VALUES ('admin-e2e', 'admin', 'Admin E2E', 'admin', '${hash}', 1, 1, '${new Date().toISOString()}')`,
  ]);

  dev = spawn("npx", ["wrangler", "dev", "-c", config, "--port", String(PORT), "--persist-to", persist, "--var", "APP_VERSION:e2e-1", "--show-interactive-dev-session=false"], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.stdout!.on("data", (d) => (log += d));
  dev.stderr!.on("data", (d) => (log += d));
  await waitReady(dev);
  console.log(`Istanza di test su ${base}`);

  const password = await runApiTests(base, "admin", adminPassword);
  if (!skipUi) await runUiTests(base, "admin", password, build);
  await runRateLimitTest(base);
  console.log(`\n${passed} controlli end-to-end superati.`);
} catch (e) {
  console.error(`\n${(e as Error).message}`);
  if (log) console.error(`\n--- log di wrangler dev (ultime righe) ---\n${log.split("\n").slice(-40).join("\n")}`);
  process.exitCode = 1;
} finally {
  dev?.kill("SIGTERM");
  rmSync(config, { force: true });
  rmSync(persist, { recursive: true, force: true });
  // Leave public/ as a normal build, not the e2e one.
  try {
    build(`dev-${Date.now()}`);
  } catch {
    /* ignore */
  }
}
