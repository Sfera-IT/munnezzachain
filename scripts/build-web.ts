// Builds the PWA into public/. Every build gets a version string that is baked into the app, the service
// worker and index.html, so each deploy produces a byte-different sw.js and browsers pick up the update.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const outdir = "public/assets";
const sha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "nogit";
  }
})();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const version = process.env.APP_VERSION ?? `${stamp}-${sha}`;
const dev = process.argv.includes("--dev");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const app = await build({
  entryPoints: { app: "src/web/main.ts" },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir,
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "[name]-[hash]",
  loader: { ".png": "file" },
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  target: ["es2022", "safari16"],
  metafile: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

const outputs = Object.keys(app.metafile.outputs).map((p) => "/" + relative("public", p));
const js = outputs.find((p) => /\/app-[^/]+\.js$/.test(p))!;
const css = outputs.find((p) => /\/app-[^/]+\.css$/.test(p))!;

const html = readFileSync("src/web/index.html", "utf8").replace("%JS%", js).replace("%CSS%", css).replace("%VERSION%", version);
writeFileSync("public/index.html", html);

const statics = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? statics(p) : ["/" + relative("public", p)];
  });
const precache = ["/index.html", "/manifest.webmanifest", ...outputs, ...statics("public/icons")];

await build({
  entryPoints: ["src/web/sw.ts"],
  bundle: true,
  format: "iife",
  outfile: "public/sw.js",
  minify: !dev,
  target: ["es2022", "safari16"],
  define: { __APP_VERSION__: JSON.stringify(version), __PRECACHE__: JSON.stringify(precache) },
  logLevel: "warning",
});

writeFileSync("public/version.json", JSON.stringify({ version }) + "\n");
writeFileSync(".app-version", version);
console.log(`PWA ${version}: ${js}, ${css}, ${precache.length} file in cache`);
