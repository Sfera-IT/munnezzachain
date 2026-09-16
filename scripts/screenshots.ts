// Generates the README screenshots from a local instance filled with realistic example reports.
// Photos are public-domain/CC0 images from Wikimedia Commons, downloaded once into .demo-cache/.
// Usage: npm run screenshots   (needs Chrome/Chromium, ffmpeg and pngquant, network for photos and map tiles)
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExifSegment, exifLocalDate, replaceExif } from "../src/shared/exif.ts";
import { sha256Hex } from "../src/shared/bytes.ts";
import { build, root, startInstance, type Instance } from "../test/e2e/instance.ts";

const OUT = join(root, "docs/screenshots");
const CACHE = join(root, ".demo-cache");
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Photos

interface Photo {
  key: string;
  file: string;
}

const PHOTOS: Photo[] = [
  { key: "discarica1", file: "File:Illegal dumping on public lands in the Medford District (19185316671).jpg" },
  { key: "discarica2", file: "File:Illegal dumping on public lands in the Medford District (19175945902).jpg" },
  { key: "discarica3", file: "File:Illegal dumping on public lands in the Medford District (18994171538).jpg" },
  { key: "pneumatici", file: "File:Tire piles waiting for recycling.jpg" },
  { key: "schiuma", file: "File:FOAM, A SIGN OF POLLUTION, FLOATS ON THE ST. CROIX RIVER AT CALAIS, A FEW MILES BELOW THE GEORGIA PACIFIC PAPER MILL - NARA - 550373.jpg" },
  { key: "scarico", file: "File:Polluted water flowing into Shibuya river.jpg" },
  { key: "camino", file: "File:House chimney with dark smoke pollution - This photo has been released into the public domain. There are no copyrights you can use and modify this photo without asking, and without attribution.jpg" },
  { key: "idrocarburi", file: "File:EPA's response to the Enbridge oil spill (4855132374).jpg" },
  { key: "bordostrada", file: "File:ROADSIDE GARBAGE - NARA - 546120.jpg" },
  { key: "fiume", file: "File:WATER STINKS, WRITES THE PHOTOGRAPHER ABOUT THIS SCENE - NARA - 544681 A.jpg" },
];

const UA = "munnezzachain-screenshots/1.0 (https://github.com/Sfera-IT/munnezzachain)";

async function fetchPhotos(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const credits: string[] = [];
  for (const p of PHOTOS) {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    Object.entries({ action: "query", format: "json", titles: p.file, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1600", iiextmetadatafilter: "LicenseShortName|Artist" }).forEach(([k, v]) =>
      url.searchParams.set(k, v),
    );
    const info = (await (await fetch(url, { headers: { "user-agent": UA } })).json()) as any;
    const ii = Object.values(info.query.pages as Record<string, any>)[0].imageinfo[0];
    const license = ii.extmetadata.LicenseShortName.value as string;
    if (!/CC0|public domain/i.test(license)) throw new Error(`${p.file}: licenza ${license} non ammessa`);
    const artist = String(ii.extmetadata.Artist?.value ?? "").replace(/<[^>]+>/g, "").trim();
    credits.push(`- [${p.file.replace(/^File:/, "")}](${ii.descriptionurl}) — ${artist || "autore sconosciuto"}, ${license}`);
    const cached = join(CACHE, `${p.key}.jpg`);
    if (!existsSync(cached)) writeFileSync(cached, new Uint8Array(await (await fetch(ii.thumburl, { headers: { "user-agent": UA } })).arrayBuffer()));
    out.set(p.key, new Uint8Array(readFileSync(cached)));
  }
  writeFileSync(
    join(OUT, "CREDITI.md"),
    `# Crediti delle foto di esempio\n\nGli screenshot usano foto di pubblico dominio o CC0 da Wikimedia Commons, con posizioni e testi inventati.\nI luoghi reali delle foto non corrispondono a quelli indicati nelle segnalazioni di esempio.\n\n${credits.join("\n")}\n`,
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// Example data around Verona

type Json = Record<string, any>;

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

class Client {
  cookie = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers: Record<string, string> = { origin: this.base, "user-agent": PHONE_UA };
    if (this.cookie) headers.cookie = this.cookie;
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(this.base + path, { ...init, headers, body });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${data.error ?? ""}`);
    return data;
  }
}

interface Example {
  photo: string;
  category: string;
  description: string;
  lat: number;
  lon: number;
  accuracy?: number;
  by: "giulia" | "marco" | "pubblico";
  gallery?: boolean;
  status?: string;
  note?: string;
  moderation?: "accetta" | "rifiuta" | "attesa";
}

const EXAMPLES: Example[] = [
  { photo: "discarica1", category: "rifiuti", description: "Cumulo di mobili, elettrodomestici e sacchi lungo la strada sterrata che costeggia l'Adige, circa 200 m dopo il ponte ciclabile.", lat: 45.4541, lon: 11.0212, by: "giulia", status: "inviata", note: "Prot. n. 4521/2026 sul portale regionale" },
  { photo: "idrocarburi", category: "suolo", description: "Terreno impregnato di idrocarburi vicino a un deposito dismesso. Odore forte, macchia di circa 20 m².", lat: 45.4118, lon: 10.9735, by: "marco", status: "inviata", note: "Prot. n. 4533/2026" },
  { photo: "schiuma", category: "acqua", description: "Schiuma persistente sul fiume a valle dello scarico del depuratore. Presente anche ieri pomeriggio.", lat: 45.4872, lon: 10.8683, by: "giulia", status: "in_verifica" },
  { photo: "pneumatici", category: "rifiuti", description: "Centinaia di pneumatici accatastati in una cava abbandonata, accesso da strada vicinale.", lat: 45.4035, lon: 10.8471, by: "marco", status: "in_verifica" },
  { photo: "camino", category: "aria", description: "Fumo nero continuo da un camino di un capannone artigianale, dalle 7 alle 9.", lat: 45.3727, lon: 11.1318, by: "giulia", accuracy: 85, status: "nuova" },
  { photo: "bordostrada", category: "rifiuti", description: "Sacchi di rifiuti domestici abbandonati nella piazzola di sosta.", lat: 45.5297, lon: 10.9381, by: "marco", status: "archiviata", note: "Rimossi dal Comune il 12 settembre" },
  { photo: "discarica2", category: "rifiuti", description: "Materiale edile e lastre, probabile amianto. Non mi sono avvicinata.", lat: 45.5702, lon: 11.0274, by: "giulia", gallery: true, status: "nuova" },
  { photo: "scarico", category: "acqua", description: "Scarico di acqua torbida e maleodorante nel fosso che confluisce nel canale.", lat: 45.3838, lon: 11.0405, by: "pubblico", moderation: "accetta", status: "nuova" },
  { photo: "discarica3", category: "rifiuti", description: "Rifiuti ingombranti in un'area boschiva vicino al sentiero CAI 250.", lat: 45.5051, lon: 10.7412, by: "pubblico", moderation: "accetta", status: "in_verifica" },
  { photo: "fiume", category: "acqua", description: "L'acqua del torrente è grigia e fa un odore terribile, ci sono pesci morti vicino alla riva.", lat: 45.2712, lon: 10.9967, by: "pubblico", moderation: "attesa" },
  { photo: "camino", category: "incendio", description: "Stanno bruciando plastica e rifiuti nel campo dietro le case, fumo nerissimo.", lat: 45.4301, lon: 11.0712, by: "pubblico", moderation: "attesa" },
  { photo: "bordostrada", category: "altro", description: "Foto non pertinente inviata per prova.", lat: 45.44, lon: 10.99, by: "pubblico", moderation: "rifiuta" },
];

async function withExif(photo: Uint8Array, lat: number, lon: number, accuracy: number, when: Date) {
  const local = exifLocalDate(when);
  const bytes = replaceExif(
    photo,
    buildExifSegment({
      software: "munnezzachain PWA",
      dateTime: local.dateTime,
      dateTimeOriginal: local.dateTime,
      offsetTimeOriginal: local.offset,
      gps: { lat, lon, accuracy, altitude: 60, time: when.toISOString() },
    }),
  );
  return { bytes, sha: await sha256Hex(bytes) };
}

async function seed(instance: Instance, photos: Map<string, Uint8Array>) {
  const admin = new Client(instance.base);
  await admin.call("/api/auth/login", { method: "POST", json: { email: instance.adminLogin, password: instance.adminPassword } });
  const adminPassword = "ufficio-ambiente-demo";
  await admin.call("/api/auth/password", { method: "POST", json: { current: instance.adminPassword, next: adminPassword } });

  const rangers: Record<string, Client> = {};
  for (const [key, name] of [
    ["giulia", "Giulia Ferrari"],
    ["marco", "Marco Bianchi"],
  ] as const) {
    const { temporaryPassword } = await admin.call("/api/utenti", { method: "POST", json: { email: `${key}@parco.example`, name, role: "operatore" } });
    const c = new Client(instance.base);
    await c.call("/api/auth/login", { method: "POST", json: { email: `${key}@parco.example`, password: temporaryPassword } });
    await c.call("/api/auth/password", { method: "POST", json: { current: temporaryPassword, next: `${key}-password-demo` } });
    rangers[key] = c;
  }
  await admin.call("/api/utenti", { method: "POST", json: { email: "luca@parco.example", name: "Luca Conti", role: "operatore" } });

  for (const ex of EXAMPLES) {
    const when = new Date(Date.now() - Math.random() * 3 * 3600_000);
    const accuracy = ex.accuracy ?? 4 + Math.round(Math.random() * 8);
    const p = await withExif(photos.get(ex.photo)!, ex.lat, ex.lon, accuracy, when);
    const origin = ex.gallery ? "file_upload" : "in_app_camera";
    const location = ex.gallery ? { lat: ex.lat, lon: ex.lon, source: "exif" } : { lat: ex.lat, lon: ex.lon, accuracy, fixTime: when.toISOString(), source: "device_gps" };
    const meta = {
      clientReportId: crypto.randomUUID(),
      category: ex.category,
      description: ex.description,
      consent: true,
      clientCreatedAt: when.toISOString(),
      queued: false,
      photos: [{ index: 0, sha256: p.sha, size: p.bytes.length, origin, capturedAt: when.toISOString(), location }],
    };
    const body = new FormData();
    body.set("meta", JSON.stringify(meta));
    body.set("photo_0", new Blob([p.bytes as BlobPart], { type: "image/jpeg" }), "foto.jpg");
    const client = ex.by === "pubblico" ? new Client(instance.base) : rangers[ex.by]!;
    const receipt = await client.call("/api/segnalazioni", { method: "POST", body });
    if (ex.moderation === "accetta") await admin.call(`/api/segnalazioni/${receipt.reportId}/moderazione`, { method: "POST", json: { decision: "accetta" } });
    if (ex.moderation === "rifiuta") await admin.call(`/api/segnalazioni/${receipt.reportId}/moderazione`, { method: "POST", json: { decision: "rifiuta", reason: "non_pertinente" } });
    if (ex.status && ex.status !== "nuova") await admin.call(`/api/segnalazioni/${receipt.reportId}`, { method: "PATCH", json: { status: ex.status, note: ex.note } });
  }
  return { adminPassword };
}

// ---------------------------------------------------------------------------------------------
// Screenshots

const chrome = () =>
  [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/usr/bin/google-chrome"].find(
    (p) => p && existsSync(p),
  )!;

async function launch(fakeVideo?: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chrome(),
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(fakeVideo ? [`--use-file-for-fake-video-capture=${fakeVideo}`] : []), "--hide-scrollbars"],
  });
}

async function mobile(browser: Browser, base: string, dark = false): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(PHONE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await page.setGeolocation({ latitude: 45.4541, longitude: 11.0212, accuracy: 6 });
  await browser.defaultBrowserContext().overridePermissions(base, ["geolocation", "camera"]);
  return page;
}

async function desktop(browser: Browser, dark = false): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  return page;
}

const settle = (page: Page, ms = 1200) =>
  page.evaluate(async (wait) => {
    await document.fonts.ready;
    // Lazy images below the fold never load: cap the wait.
    const images = Promise.all([...document.images].filter((i) => !i.complete && i.loading !== "lazy").map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r)))));
    await Promise.race([images, new Promise((r) => setTimeout(r, 5000))]);
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((r) => setTimeout(r, wait));
  }, ms);

const shot = async (page: Page, name: string) => {
  await settle(page);
  await save(page, name);
};

/** Screenshots are committed to the repo: quantize them to keep the README light. */
async function save(page: Page, name: string) {
  const path = join(OUT, `${name}.png`) as `${string}.png`;
  await page.screenshot({ path });
  try {
    execFileSync("pngquant", ["--force", "--skip-if-larger", "--quality", "70-95", "--strip", "--output", path, path]);
  } catch {
    console.warn("  pngquant non disponibile: screenshot non compresso");
  }
  console.log(`  ${name}.png`);
}

const clickText = (page: Page, selector: string, text: string) =>
  page.evaluate(
    (sel, t) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(t))!.click(),
    selector,
    text,
  );

async function loginDesk(page: Page, base: string, password: string) {
  await page.goto(`${base}/#/accesso`, { waitUntil: "networkidle0" });
  await page.type('input[autocomplete="username"]', "admin");
  await page.type('input[type="password"]', password);
  await page.click("button[type=submit]");
  await page.waitForFunction(() => location.hash === "#/operatori");
}

async function main() {
  const photos = await fetchPhotos();
  const instance = await startInstance({ port: 8797, version: "1.0", adminName: "Ufficio Ambiente", timestamping: true });
  try {
    console.log(`Istanza di esempio su ${instance.base}`);
    const { adminPassword } = await seed(instance, photos);
    const base = instance.base;

    // A real photo as the fake camera feed, so the camera screen shows a real scene.
    const feed = join(CACHE, "camera.mjpeg");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(CACHE, "discarica1.jpg"), "-vf", "scale=1280:960:force_original_aspect_ratio=increase,crop=1280:960", "-q:v", "3", "-f", "mjpeg", feed]);

    console.log("Screenshot:");
    let browser = await launch(feed);
    try {
      const page = await mobile(browser, base);
      await page.goto(`${base}/#/`, { waitUntil: "networkidle0" });
      await shot(page, "01-home");

      await page.goto(`${base}/#/segnala`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelector(".loc-banner")?.classList.contains("good"));
      await clickText(page, "button", "Scatta foto");
      await page.waitForSelector(".camera-shutter:not([disabled])");
      await settle(page, 2000);
      await save(page, "02-fotocamera");
      await page.click(".camera-shutter");
      await page.waitForFunction(() => document.querySelector(".camera-counter")?.textContent?.includes("9"));
      await clickText(page, ".camera button", "Fine");
      await page.waitForSelector(".photo img");
      await page.click('.chip input[value="rifiuti"]');
      await page.type("textarea", "Mobili e sacchi abbandonati lungo l'argine, vicino alla passerella.");
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, "03-nuova-segnalazione");

      await page.click(".check input");
      await clickText(page, "button[type=submit]", "Invia");
      await page.waitForSelector(".receipt-code");
      await page.waitForFunction(() => document.querySelector(".facts .badge-ok:last-of-type")?.textContent?.includes("apposta"), { timeout: 30000 }).catch(() => undefined);
      await shot(page, "04-ricevuta");

      const receiptHash = await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const req = indexedDB.open("munnezzachain");
            req.onsuccess = () => {
              const get = req.result.transaction("receipts").objectStore("receipts").getAll();
              get.onsuccess = () => resolve((get.result as { photos: { sha256: string }[] }[])[0]!.photos[0]!.sha256);
            };
          }),
      );
      await page.goto(`${base}/#/verifica`, { waitUntil: "networkidle0" });
      await page.type('input[type="text"]', receiptHash);
      await clickText(page, "button[type=submit]", "Cerca");
      await page.waitForSelector(".notice-ok");
      await shot(page, "05-verifica");
    } finally {
      await browser.close();
    }

    browser = await launch();
    try {
      const desk = await desktop(browser);
      await loginDesk(desk, base, adminPassword);
      await desk.waitForSelector(".leaflet-marker-pane .leaflet-interactive, .leaflet-overlay-pane path");
      await settle(desk, 2500);
      await shot(desk, "06-pannello-operatori");

      // The ranger's gallery upload: its photo card shows provenance warnings next to the image.
      const gallery = await desk.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>("a.list-row")].find((a) => a.textContent?.includes("amianto"))!.getAttribute("href")!);
      await desk.goto(`${base}/${gallery}`, { waitUntil: "networkidle0" });
      await desk.waitForSelector(".photo-detail img");
      await desk.evaluate(() => {
        const h = [...document.querySelectorAll("h2")].find((e) => e.textContent === "Foto")!;
        window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 90);
      });
      await settle(desk, 2500);
      await shot(desk, "07-dettaglio-segnalazione");

      await desk.goto(`${base}/#/operatori/moderazione`, { waitUntil: "networkidle0" });
      await desk.waitForSelector('a.list-row[href*="segnalazione"]');
      const pending = await desk.$eval('a.list-row[href*="segnalazione"]', (a) => a.getAttribute("href")!);
      await desk.goto(`${base}/${pending}`, { waitUntil: "networkidle0" });
      await desk.waitForSelector(".moderation-panel");
      await desk.evaluate(() => document.querySelector(".moderation-panel")?.scrollIntoView({ block: "center" }));
      await settle(desk, 2500);
      await shot(desk, "08-moderazione");

      const dark = await desktop(browser, true);
      await dark.goto(`${base}/#/operatori/catena`, { waitUntil: "networkidle0" });
      await clickText(dark, "button", "Verifica completa");
      await dark.waitForSelector(".notice-ok", { timeout: 30000 });
      await dark.waitForFunction(() => !document.querySelector(".toast"), { timeout: 10000 });
      await shot(dark, "09-catena-tema-scuro");
    } finally {
      await browser.close();
    }
  } finally {
    instance.stop();
    build(`dev-${Date.now()}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
