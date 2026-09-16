// Runs the API and browser end-to-end tests against an isolated local instance.
// Usage: npm run test:e2e [-- --solo-api]   (browser tests need Chrome/Chromium; set CHROME_PATH if not found)
import { runApiTests, runRateLimitTest } from "./api.ts";
import { runUiTests } from "./ui.ts";
import { passed } from "./assert.ts";
import { build, startInstance, type Instance } from "./instance.ts";

let instance: Instance | undefined;
try {
  instance = await startInstance({ port: Number(process.env.E2E_PORT ?? 8799), version: "e2e-1", adminName: "Admin E2E" });
  console.log(`Istanza di test su ${instance.base}`);
  const password = await runApiTests(instance.base, instance.adminLogin, instance.adminPassword);
  if (!process.argv.includes("--solo-api")) await runUiTests(instance.base, instance.adminLogin, password, build);
  await runRateLimitTest(instance.base);
  console.log(`\n${passed} controlli end-to-end superati.`);
} catch (e) {
  console.error(`\n${(e as Error).message}`);
  const log = instance?.log();
  if (log) console.error(`\n--- log di wrangler dev (ultime righe) ---\n${log.split("\n").slice(-40).join("\n")}`);
  process.exitCode = 1;
} finally {
  instance?.stop();
  // Leave public/ as a normal build, not the e2e one.
  try {
    build(`dev-${Date.now()}`);
  } catch {
    /* ignore */
  }
  // Never wait on stray handles: a hung CI job is worse than a failed one.
  process.exit(process.exitCode ?? 0);
}
