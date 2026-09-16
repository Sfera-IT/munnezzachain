// An isolated local instance: fresh D1/R2 state, production bindings with a generous public rate limit and
// no external TSA. Shared by the end-to-end tests and the README screenshot generator.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "../../src/shared/password.ts";

export const root = new URL("../../", import.meta.url).pathname;

export function build(version: string) {
  execFileSync("node", ["scripts/build-web.ts"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, APP_VERSION: version } });
}

export interface Instance {
  base: string;
  adminLogin: string;
  adminPassword: string;
  log: () => string;
  stop: () => void;
}

export async function startInstance(opts: { port: number; version: string; adminName?: string; timestamping?: boolean }): Promise<Instance> {
  const base = `http://localhost:${opts.port}`;
  const persist = mkdtempSync(join(tmpdir(), "munnezzachain-"));
  const config = join(root, `.wrangler.local-${opts.port}.jsonc`);
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  const bin = join(root, "node_modules/.bin/wrangler");
  const wrangler = (args: string[]) => execFileSync(bin, [...args, "-c", config], { cwd: root, stdio: ["ignore", "pipe", "inherit"], env });

  // Same bindings as production; the text edits fail loudly if wrangler.jsonc drifts.
  let c = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const edit = (from: RegExp, to: string) => {
    if (!from.test(c)) throw new Error(`wrangler.jsonc non contiene ${from}: aggiorna test/e2e/instance.ts`);
    c = c.replace(from, to);
  };
  edit(/"name": "PUBLIC_SUBMIT_LIMITER", "namespace_id": "(\d+)", "simple": \{ "limit": \d+/, '"name": "PUBLIC_SUBMIT_LIMITER", "namespace_id": "$1", "simple": { "limit": 1000');
  // Tests stay offline; screenshots may use the real TSA to show a granted timestamp.
  if (!opts.timestamping) edit(/"TSA_URL": "[^"]*"/, '"TSA_URL": ""');
  edit(/\s*"routes": \[[^\]]*\],/, "");
  writeFileSync(config, c);

  let dev: ChildProcess | undefined;
  let log = "";
  const stop = () => {
    // wrangler spawns workerd: kill the whole process group, or the children keep the pipes (and CI) alive.
    if (dev?.pid && dev.exitCode === null) {
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        dev.kill("SIGTERM");
      }
    }
    rmSync(config, { force: true });
    rmSync(persist, { recursive: true, force: true });
  };

  try {
    build(opts.version);
    wrangler(["d1", "migrations", "apply", "munnezzachain", "--local", "--persist-to", persist]);
    const adminPassword = "password-provvisoria-locale";
    wrangler([
      "d1", "execute", "munnezzachain", "--local", "--persist-to", persist, "--command",
      `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at)
       VALUES ('admin-locale', 'admin', '${opts.adminName ?? "Admin"}', 'admin', '${await hashPassword(adminPassword)}', 1, 1, '${new Date().toISOString()}')`,
    ]);
    dev = spawn(bin, ["dev", "-c", config, "--port", String(opts.port), "--persist-to", persist, "--var", `APP_VERSION:${opts.version}`, "--show-interactive-dev-session=false"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    dev.stdout!.on("data", (d) => (log += d));
    dev.stderr!.on("data", (d) => (log += d));
    for (let i = 0; ; i++) {
      if (dev.exitCode !== null) throw new Error("wrangler dev è terminato durante l'avvio");
      if (i > 120) throw new Error("wrangler dev non risponde");
      try {
        if ((await fetch(`${base}/api/config`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { base, adminLogin: "admin", adminPassword, log: () => log, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
