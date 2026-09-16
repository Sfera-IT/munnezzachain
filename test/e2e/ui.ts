// Browser end-to-end tests: a real Chromium with a fake camera and a fixed GPS position.
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ok, section, sleep } from "./assert.ts";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("Nessun Chrome/Chromium trovato: imposta CHROME_PATH");
  return found;
}

const NETWORK_NOISE = /net::ERR_|Failed to load resource|tile\.openstreetmap|static\.cloudflareinsights/;

async function openPage(browser: Browser, base: string, errors: string[], mobile: boolean): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
  await page.setGeolocation({ latitude: 45.4599, longitude: 10.9796, accuracy: 8 });
  page.on("pageerror", (e) => errors.push(`eccezione: ${(e as Error).message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !NETWORK_NOISE.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${base}/#/`, { waitUntil: "networkidle0" });
  return page;
}

async function go(page: Page, base: string, hash: string, selector: string) {
  await page.goto(`${base}/${hash}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(selector, { timeout: 15000 });
}

const clickText = (page: Page, selector: string, text: string) =>
  page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(t));
      if (!el) throw new Error(`non trovato: ${sel} "${t}"`);
      el.click();
    },
    selector,
    text,
  );

async function axe(page: Page, label: string) {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { exclude: [[".leaflet-container"]] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } },
    );
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  });
  ok(violations.length === 0, `accessibilità WCAG 2.2 AA senza violazioni gravi: ${label}${violations.length ? `\n      ${violations.join("\n      ")}` : ""}`);
}

async function shootAndFill(page: Page, description: string) {
  await page.waitForFunction(() => document.querySelector(".loc-banner")?.classList.contains("good"), { timeout: 20000 });
  await clickText(page, "button", "Scatta foto");
  await page.waitForSelector(".camera-shutter:not([disabled])", { timeout: 20000 });
  await sleep(500);
  await page.click(".camera-shutter");
  await page.waitForFunction(() => document.querySelector(".camera-counter")?.textContent?.includes("9"), { timeout: 20000 });
  await clickText(page, ".camera button", "Fine");
  await page.waitForSelector(".photo img");
  await page.click('.chip input[value="rifiuti"]');
  await page.type("textarea", description);
  const consent = await page.$(".check input");
  if (consent) await consent.click();
}

export async function runUiTests(base: string, adminLogin: string, adminPassword: string, rebuild: (version: string) => void) {
  const errors: string[] = [];
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-first-run", ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : [])],
  });
  try {
    await browser.defaultBrowserContext().overridePermissions(base, ["geolocation", "camera"]);
    const page = await openPage(browser, base, errors, true);

    section("UI: pagine pubbliche");
    await page.waitForSelector(".hero h1");
    {
      // A fresh profile, counting every document load in the tab from the very first one.
      const context = await browser.createBrowserContext();
      const fresh = await context.newPage();
      await fresh.evaluateOnNewDocument(() => sessionStorage.setItem("caricamenti", String(Number(sessionStorage.getItem("caricamenti") ?? 0) + 1)));
      await fresh.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
      await fresh.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15000 });
      await sleep(1500);
      const loads = await fresh.evaluate(() => sessionStorage.getItem("caricamenti"));
      await context.close();
      ok(loads === "1", `alla prima visita il service worker prende il controllo senza ricaricare la pagina (caricamenti: ${loads})`);
    }
    ok(await page.$eval('link[rel="manifest"]', (l) => Boolean(l.getAttribute("href"))), "la home si carica ed espone il manifest PWA");
    await axe(page, "home");
    await go(page, base, "#/verifica", ".dropzone");
    await axe(page, "verifica");
    await go(page, base, "#/privacy", ".prose");
    await axe(page, "privacy");
    await go(page, base, "#/accesso", "form");
    await axe(page, "accesso");

    section("UI: segnalazione con fotocamera e GPS");
    await go(page, base, "#/segnala", ".loc-banner");
    await shootAndFill(page, "Sacchi di rifiuti abbandonati vicino al ponte.");
    ok(await page.$eval(".photo .badge", (b) => b.textContent?.includes("±8 m")), "la foto riporta la posizione del GPS con la precisione");
    await axe(page, "nuova segnalazione");
    await clickText(page, "button[type=submit]", "Invia");
    await page.waitForFunction(() => location.hash.startsWith("#/ricevuta/"), { timeout: 20000 });
    const code = await page.$eval(".receipt-code", (e) => e.textContent ?? "");
    ok(/^\d{8}-[0-9A-Z]{8}$/.test(code), `ricevuta con codice ${code}`);
    await axe(page, "ricevuta");

    section("UI: invio senza rete e ripresa");
    await go(page, base, "#/segnala", ".loc-banner");
    await shootAndFill(page, "Scarico nel torrente, segnalato senza campo.");
    await page.setOfflineMode(true);
    await clickText(page, "button[type=submit]", "Invia");
    await page.waitForFunction(() => location.hash === "#/mie", { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll("h2")].some((h) => h.textContent === "Da inviare"), { timeout: 15000 });
    ok(true, "offline la segnalazione resta in coda sul telefono");
    await page.setOfflineMode(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => ![...document.querySelectorAll("h2")].some((h) => h.textContent === "Da inviare"), { timeout: 20000 });
    const sent = await page.$$eval('a.list-row[href^="#/ricevuta/"]', (rows) => rows.length);
    ok(sent === 2, "tornata la rete, la coda parte da sola e compaiono due ricevute");
    await axe(page, "le mie segnalazioni");
    const photoHash = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const req = indexedDB.open("munnezzachain");
          req.onsuccess = () => {
            const get = req.result.transaction("receipts").objectStore("receipts").getAll();
            get.onsuccess = () => resolve((get.result as { photos: { sha256: string }[] }[])[0]!.photos[0]!.sha256);
            get.onerror = () => reject(get.error);
          };
        }),
    );

    section("UI: verifica pubblica");
    await go(page, base, "#/verifica", ".dropzone");
    await page.type('input[type="text"]', photoHash);
    await clickText(page, "button[type=submit]", "Cerca");
    await page.waitForSelector(".notice-ok", { timeout: 10000 });
    ok(await page.$eval(".notice-ok", (e) => e.textContent?.includes("foto originale")), "un'impronta registrata risulta come foto originale");
    const input = await page.$('input[type="file"]');
    await input!.uploadFile(new URL("../fixtures/exif/no-exif.jpg", import.meta.url).pathname);
    await page.waitForSelector(".notice-bad", { timeout: 10000 });
    ok(await page.$eval(".notice-bad", (e) => e.textContent?.includes("Non registrato")), "un file mai inviato risulta non registrato");

    section("UI: moderazione e pannello operatori");
    const desk = await openPage(browser, base, errors, false);
    await go(desk, base, "#/accesso", "form");
    await desk.type('input[autocomplete="username"]', adminLogin);
    await desk.type('input[type="password"]', adminPassword);
    await desk.click("button[type=submit]");
    await desk.waitForFunction(() => location.hash === "#/operatori", { timeout: 15000 });
    ok(true, "login amministratore dall'interfaccia");
    await go(desk, base, "#/operatori/moderazione", ".list-row");
    const pending = await desk.$$eval('a.list-row[href*="segnalazione"]', (rows) => rows.map((r) => r.getAttribute("href")!));
    ok(pending.length >= 2, `coda di moderazione con ${pending.length} segnalazioni`);
    await axe(desk, "coda di moderazione");
    await go(desk, base, pending[0]!, ".moderation-panel");
    ok(await desk.$eval(".photo-frame img", (i) => i.classList.contains("blurred")), "in moderazione l'immagine è sfocata");
    await desk.waitForFunction(() => (document.querySelector(".photo-frame img") as HTMLImageElement | null)?.complete, { timeout: 15000 });
    await desk.click(".reveal");
    ok(await desk.$eval(".photo-frame img", (i) => !i.classList.contains("blurred")), "si mostra solo su richiesta");
    await axe(desk, "dettaglio in moderazione");
    await clickText(desk, ".moderation-panel button", "Accetta");
    await desk.waitForFunction(() => location.hash === "#/operatori/moderazione", { timeout: 15000 });
    ok(true, "accettata dall'interfaccia");
    await go(desk, base, pending[0]!, ".photo-detail");
    ok(Boolean(await desk.$('a[href$="pacchetto.zip"]')), "dopo l'accettazione è disponibile il pacchetto probatorio");
    await axe(desk, "dettaglio segnalazione");
    await go(desk, base, "#/operatori", ".leaflet-container");
    await axe(desk, "elenco operatori");
    await go(desk, base, "#/operatori/utenti", ".list-row");
    await axe(desk, "utenti");
    await go(desk, base, "#/operatori/catena", ".facts");
    await clickText(desk, "button", "Verifica catena");
    await desk.waitForSelector(".notice-ok", { timeout: 15000 });
    ok(await desk.$eval(".notice-ok", (e) => e.textContent?.includes("Catena integra")), "verifica della catena dall'interfaccia");

    section("UI: app installata senza rete");
    await desk.close();
    await page.bringToFront();
    await go(page, base, "#/", ".hero");
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active && navigator.serviceWorker.controller), { timeout: 15000 });
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".hero h1", { timeout: 15000 });
    ok(await page.$eval("#offline", (e) => !(e as HTMLElement).hidden), "senza rete l'app si apre dalla cache e segnala di essere offline");
    await page.setOfflineMode(false);

    const version = () => page.$eval('meta[name="app-version"]', (m) => m.getAttribute("content"));
    const cacheNames = () => page.evaluate(async () => (await window.caches.keys()).filter((k) => k.startsWith("munnezzachain-")));
    const publish = async (v: string) => {
      rebuild(v);
      // wrangler dev picks up rebuilt assets asynchronously: wait until the new service worker is served.
      for (let i = 0; i < 60; i++) {
        if ((await (await fetch(`${base}/sw.js`, { cache: "no-store" })).text()).includes(v)) return;
        await sleep(500);
      }
      throw new Error(`il service worker ${v} non viene servito`);
    };

    section("UI: aggiornamento della PWA in primo piano");
    await page.reload({ waitUntil: "networkidle0" });
    const before = await version();
    await publish("e2e-2");
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await page.waitForSelector(".update-banner:not([hidden])", { timeout: 30000 });
    ok(true, "con l'app in uso, una nuova build fa comparire l'avviso invece di ricaricare");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 }), page.click(".update-banner button")]);
    const caches2 = await cacheNames();
    ok(before === "e2e-1" && (await version()) === "e2e-2" && caches2.length === 1 && caches2[0] === "munnezzachain-e2e-2", "toccando Aggiorna gira la nuova versione e la cache vecchia è eliminata");

    section("UI: aggiornamento della PWA in background");
    await publish("e2e-3");
    // A second tab in front puts the app in the background, as when the phone switches app.
    const other = await browser.newPage();
    await other.bringToFront();
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await page.waitForFunction(() => document.querySelector('meta[name="app-version"]')?.getAttribute("content") === "e2e-3", { timeout: 30000, polling: 500 });
    ok(true, "in background e senza lavoro in corso l'app si aggiorna da sola");
    await other.close();

    section("UI: errori JavaScript");
    ok(errors.length === 0, `nessun errore JavaScript durante i test${errors.length ? `\n      ${errors.join("\n      ")}` : ""}`);
  } finally {
    await browser.close();
  }
}
