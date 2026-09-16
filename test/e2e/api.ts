// API end-to-end tests against the local instance started by test/e2e/run.ts. They write real reports.
import { buildExifSegment, replaceExif, readExif } from "../../src/shared/exif.ts";
import { sha256Hex } from "../../src/shared/bytes.ts";
import { ok, section } from "./assert.ts";
import { TURNSTILE_DUMMY_TOKEN } from "./instance.ts";

type Json = Record<string, any>;

// A real 1x1 JPEG; EXIF is added the way the PWA writes it.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

class Client {
  cookie = "";
  readonly base: string;
  readonly anonymous: boolean;

  constructor(base: string, anonymous = false) {
    this.base = base;
    this.anonymous = anonymous;
  }

  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers: Record<string, string> = { origin: this.base, ...(init.headers as Record<string, string>) };
    if (!this.anonymous && this.cookie) headers.cookie = this.cookie;
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(this.base + path, { ...init, headers, body });
    const set = res.headers.get("set-cookie");
    if (set && !this.anonymous) this.cookie = set.split(";")[0]!;
    return res;
  }

  async json(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await this.call(path, init);
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }

  async login(login: string, password: string, turnstileToken: string | null = TURNSTILE_DUMMY_TOKEN) {
    return this.json("/api/auth/login", { method: "POST", json: { email: login, password, turnstileToken } });
  }
}

async function photo(seed: string, gps = { lat: 45.4599, lon: 10.9796 }) {
  const now = new Date().toISOString();
  const bytes = replaceExif(
    new Uint8Array(TINY_JPEG),
    buildExifSegment({ software: `munnezzachain PWA ${seed}`, dateTimeOriginal: "2026:09:16 13:14:51", offsetTimeOriginal: "+02:00", gps: { ...gps, accuracy: 6, time: now } }),
  );
  return { bytes, sha: await sha256Hex(bytes), at: now };
}

interface SubmitOptions {
  origin?: "in_app_camera" | "file_upload";
  clientReportId?: string;
  description?: string;
  consent?: boolean;
  file?: Uint8Array;
  declaredSha?: string;
  turnstileToken?: string | null;
}

async function submit(client: Client, seed: string, o: SubmitOptions = {}) {
  const p = await photo(seed);
  const origin = o.origin ?? "in_app_camera";
  const clientReportId = o.clientReportId ?? crypto.randomUUID();
  const location = origin === "in_app_camera" ? { lat: 45.4599, lon: 10.9796, accuracy: 6, fixTime: p.at, source: "device_gps" } : { lat: 45.4599, lon: 10.9796, source: "exif" };
  const file = o.file ?? p.bytes;
  const meta = {
    clientReportId,
    category: "rifiuti",
    description: o.description ?? `Prova automatica ${seed}`,
    consent: o.consent ?? true,
    clientCreatedAt: p.at,
    queued: false,
    photos: [{ index: 0, sha256: o.declaredSha ?? p.sha, size: file.length, origin, capturedAt: p.at, location }],
    ...(o.turnstileToken === null ? {} : { turnstileToken: o.turnstileToken ?? TURNSTILE_DUMMY_TOKEN }),
  };
  const body = new FormData();
  body.set("meta", JSON.stringify(meta));
  body.set("photo_0", new Blob([file as BlobPart], { type: "image/jpeg" }), "foto.jpg");
  const res = await client.call("/api/segnalazioni", { method: "POST", body });
  return { status: res.status, data: (await res.json()) as Json, photo: p, clientReportId };
}

/** Returns the admin's new password (the test changes the temporary one). */
export async function runApiTests(base: string, adminLogin: string, adminPassword: string): Promise<string> {
  const pub = new Client(base, true);
  const admin = new Client(base);

  section("API: invio pubblico");
  {
    const p = await photo("manomessa");
    const altered = Uint8Array.from([...p.bytes.slice(0, -3), 0x00, 0xff, 0xd9]);
    const r = await submit(pub, "manomessa", { file: altered, declaredSha: p.sha });
    ok(r.status === 422 && /impronta/.test(r.data.error), "foto alterata in transito rifiutata");
  }
  {
    const notImage = new TextEncoder().encode("questo non è un jpeg, è testo qualunque");
    const r = await submit(pub, "testo", { file: notImage, declaredSha: await sha256Hex(notImage) });
    ok(r.status === 422 && /immagine/.test(r.data.error), "file che non è un'immagine rifiutato");
  }
  ok((await submit(pub, "senza-consenso", { consent: false })).status === 422, "senza presa visione dell'informativa il pubblico non può inviare");
  ok((await submit(pub, "galleria", { origin: "file_upload" })).status === 422, "il pubblico non può caricare dalla galleria");

  {
    const r = await submit(pub, "senza-turnstile", { turnstileToken: null });
    ok(r.status === 403 && r.data.code === "turnstile", "senza verifica anti-spam l'invio pubblico è rifiutato");
  }
  const first = await submit(pub, "uno", { description: "=HYPERLINK(\"http://evil.example\")" });
  ok(first.status === 201 && first.data.moderation === "in_attesa", `segnalazione pubblica in quarantena (${first.data.reportId}, anello ${first.data.seq})`);
  ok(readExif(first.photo.bytes)?.gps, "la foto inviata contiene il GPS nell'EXIF");

  const resend = new FormData();
  {
    const p = first.photo;
    resend.set(
      "meta",
      JSON.stringify({
        clientReportId: first.clientReportId,
        category: "rifiuti",
        description: "reinvio dopo rete caduta",
        consent: true,
        clientCreatedAt: p.at,
        queued: true,
        turnstileToken: TURNSTILE_DUMMY_TOKEN,
        photos: [{ index: 0, sha256: p.sha, size: p.bytes.length, origin: "in_app_camera", capturedAt: p.at, location: { lat: 45.4599, lon: 10.9796, accuracy: 6, fixTime: p.at, source: "device_gps" } }],
      }),
    );
    resend.set("photo_0", new Blob([p.bytes as BlobPart], { type: "image/jpeg" }), "foto.jpg");
  }
  const again = await pub.call("/api/segnalazioni", { method: "POST", body: resend });
  const againData = (await again.json()) as Json;
  ok(again.status === 200 && againData.duplicate && againData.reportId === first.data.reportId, "reinvio della stessa segnalazione: stessa ricevuta, nessun doppione");
  ok((await submit(pub, "conflitto", { clientReportId: first.clientReportId })).status === 409, "stesso identificativo con foto diverse: conflitto");

  const verify = (await pub.json(`/api/verifica/${first.photo.sha}`)).data;
  ok(verify.found && verify.kind === "foto_originale" && verify.moderation === "in_attesa", "la verifica pubblica trova la foto");
  ok(verify.description === undefined && verify.lat === undefined, "la verifica pubblica non espone testo né posizione");
  ok((await pub.json(`/api/verifica/${"0".repeat(64)}`)).data.found === false, "impronta sconosciuta: non trovata");
  ok((await pub.json("/api/verifica/nonunhash")).status === 400, "impronta malformata rifiutata");

  section("API: accesso e permessi");
  ok((await pub.call("/api/segnalazioni")).status === 401, "elenco protetto senza accesso");
  {
    const r = await admin.login(adminLogin, adminPassword, null);
    ok(r.status === 403 && r.data.code === "turnstile" && !admin.cookie, "senza verifica anti-spam il login è rifiutato anche con la password giusta");
  }
  ok((await admin.login(adminLogin, "password-sbagliata")).status === 401, "password errata rifiutata");
  ok((await admin.login(adminLogin, adminPassword)).status === 200, "login amministratore");
  ok((await admin.call("/api/segnalazioni")).status === 403, "con password provvisoria i dati restano bloccati");
  ok((await admin.json("/api/auth/password", { method: "POST", json: { current: adminPassword, next: "corta" } })).status === 400, "password nuova troppo corta rifiutata");
  const newPassword = `nuova-password-${Date.now()}`;
  ok((await admin.json("/api/auth/password", { method: "POST", json: { current: adminPassword, next: newPassword } })).status === 200, "cambio password");

  const evil = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: admin.cookie, origin: "https://evil.example" } });
  ok(evil.status === 403, "richiesta da un'altra origine rifiutata");

  const created = await admin.json("/api/utenti", { method: "POST", json: { email: "ranger@example.test", name: "Ranger Prova", role: "operatore" } });
  ok(created.status === 201 && created.data.temporaryPassword.length >= 12, "l'admin crea un operatore con password provvisoria");
  ok((await admin.json("/api/utenti", { method: "POST", json: { email: "ranger@example.test", name: "Doppio", role: "operatore" } })).status === 409, "email duplicata rifiutata");

  const ranger = new Client(base);
  await ranger.login("ranger@example.test", created.data.temporaryPassword);
  const rangerPassword = `ranger-password-${Date.now()}`;
  await ranger.json("/api/auth/password", { method: "POST", json: { current: created.data.temporaryPassword, next: rangerPassword } });
  ok((await ranger.call("/api/segnalazioni")).status === 200, "l'operatore accede dopo aver cambiato la password");
  ok((await ranger.call(`/api/segnalazioni/${first.data.reportId}`)).status === 404, "l'operatore non vede le segnalazioni in quarantena");
  ok((await ranger.json(`/api/segnalazioni/${first.data.reportId}/moderazione`, { method: "POST", json: { decision: "accetta" } })).status === 403, "l'operatore non può moderare");
  ok((await ranger.call("/api/utenti")).status === 403, "l'operatore non gestisce gli utenti");
  ok((await ranger.call("/api/export/catena/verifica")).status === 403, "l'operatore non lancia la verifica della catena");

  section("API: moderazione");
  const queue = (await admin.json("/api/segnalazioni?moderation=in_attesa")).data;
  ok(queue.reports.some((r: Json) => r.id === first.data.reportId) && queue.pendingModeration >= 1, "la segnalazione è in coda di moderazione");
  ok((await admin.json(`/api/segnalazioni/${first.data.reportId}`, { method: "PATCH", json: { status: "inviata" } })).status === 409, "non si lavora una segnalazione non ancora moderata");
  ok((await admin.json(`/api/segnalazioni/${first.data.reportId}/moderazione`, { method: "POST", json: { decision: "accetta" } })).status === 200, "accettata");
  ok((await admin.json(`/api/segnalazioni/${first.data.reportId}/moderazione`, { method: "POST", json: { decision: "rifiuta", reason: "altro" } })).status === 409, "una decisione di moderazione non si ribalta");

  const served = new Uint8Array(await (await ranger.call(`/api/segnalazioni/${first.data.reportId}/photos/0/originale`)).arrayBuffer());
  ok((await sha256Hex(served)) === first.photo.sha, "dopo l'accettazione l'originale è identico byte per byte e visibile all'operatore");

  const detail = (await ranger.json(`/api/segnalazioni/${first.data.reportId}`)).data;
  ok(detail.photos[0].flags.every((f: Json) => f.level !== "warn"), "nessun avviso su foto scattata in app con GPS preciso");
  ok(detail.report.user_agent === null, "l'operatore non vede il browser di chi ha segnalato");
  ok(detail.history.some((h: Json) => h.action === "moderazione_accettata"), "il registro riporta la moderazione");

  const zipRes = await ranger.call(`/api/segnalazioni/${first.data.reportId}/pacchetto.zip`);
  const zip = new Uint8Array(await zipRes.arrayBuffer());
  const names = new TextDecoder().decode(zip);
  ok(zipRes.status === 200 && zip[0] === 0x50 && zip[1] === 0x4b, "pacchetto probatorio ZIP");
  ok(["originali/foto-1.jpg", "manifest.json", "catena.json", "SHA256SUMS", "LEGGIMI.txt", "registro-accessi.json"].every((n) => names.includes(n)), "il pacchetto contiene originali, manifest, catena, impronte e istruzioni");

  ok((await ranger.json(`/api/segnalazioni/${first.data.reportId}`, { method: "PATCH", json: { status: "inviata", note: "prot. 123" } })).status === 200, "l'operatore cambia lo stato");
  ok((await ranger.json(`/api/segnalazioni/${first.data.reportId}`, { method: "PATCH", json: { status: "boh" } })).status === 400, "stato sconosciuto rifiutato");

  section("API: rifiuto");
  const second = await submit(pub, "due", { description: "contenuto da rimuovere" });
  ok(second.status === 201, "seconda segnalazione pubblica");
  ok((await admin.json(`/api/segnalazioni/${second.data.reportId}/moderazione`, { method: "POST", json: { decision: "rifiuta" } })).status === 400, "rifiuto senza motivo non accettato");
  ok((await admin.json(`/api/segnalazioni/${second.data.reportId}/moderazione`, { method: "POST", json: { decision: "rifiuta", reason: "illecito" } })).status === 200, "rifiutata");
  const rejected = (await admin.json(`/api/segnalazioni/${second.data.reportId}`)).data;
  ok(rejected.report.description === "" && rejected.report.lat === null && rejected.photos[0].removed && rejected.photos[0].location === null, "testo, posizione e foto rimossi");
  ok(rejected.photos[0].sha256 === second.photo.sha, "l'impronta della foto rifiutata resta");
  ok((await admin.call(`/api/segnalazioni/${second.data.reportId}/photos/0/originale`)).status === 404, "la foto rifiutata non è più scaricabile");
  const verifyRejected = (await pub.json(`/api/verifica/${second.photo.sha}`)).data;
  ok(verifyRejected.found && verifyRejected.moderation === "rifiutata", "la verifica pubblica riporta la rimozione");

  section("API: canale operatori");
  const fromGallery = await submit(ranger, "galleria-operatore", { origin: "file_upload" });
  ok(fromGallery.status === 201 && fromGallery.data.moderation === "accettata", "segnalazione di un operatore da galleria accettata senza quarantena");
  ok(fromGallery.data.photos[0].flags.includes("UPLOAD_NOT_CAMERA"), "segnata come caricata da galleria");

  section("API: catena ed export");
  const chain = (await admin.json("/api/export/catena/verifica?completa=1")).data;
  ok(chain.ok && chain.length === 3 && chain.next === null, `catena integra, verifica completa su ${chain.length} anelli`);
  const head = (await pub.json("/api/verifica/testa")).data;
  ok(head.length === 3 && head.head === chain.head, "la testa pubblica coincide con la verifica interna");

  const geo = (await ranger.json("/api/export/segnalazioni.geojson")).data;
  ok(geo.features.length === 2 && geo.features.every((f: Json) => f.properties.id !== second.data.reportId), "il GeoJSON contiene solo le accettate");
  const csv = await (await ranger.call("/api/export/segnalazioni.csv")).text();
  ok(csv.includes("'=HYPERLINK") && !/;=HYPERLINK/.test(csv), "il CSV neutralizza le formule dei fogli di calcolo");

  section("API: robustezza");
  {
    const race = await submit(pub, "gara", { description: "accettazione e rifiuto insieme" });
    const [acc, rej] = await Promise.all([
      admin.json(`/api/segnalazioni/${race.data.reportId}/moderazione`, { method: "POST", json: { decision: "accetta" } }),
      admin.json(`/api/segnalazioni/${race.data.reportId}/moderazione`, { method: "POST", json: { decision: "rifiuta", reason: "altro" } }),
    ]);
    ok([acc.status, rej.status].sort().join() === "200,409", `accettazione e rifiuto contemporanei: vince uno solo (${acc.status}, ${rej.status})`);
    const after = (await admin.json(`/api/segnalazioni/${race.data.reportId}`)).data;
    const photo = await admin.call(`/api/segnalazioni/${race.data.reportId}/photos/0/originale`);
    ok(
      acc.status === 200 ? after.report.moderation === "accettata" && photo.status === 200 : after.report.moderation === "rifiutata" && photo.status === 404,
      "lo stato finale è coerente con la decisione che ha vinto",
    );
  }
  ok((await admin.json("/api/utenti", { method: "POST", body: "{non json", headers: { "content-type": "application/json" } })).status === 400, "un corpo JSON malformato è un errore 400, non 500");
  {
    // Locally wrangler buffers the body before the Worker runs; in production the header is checked first.
    const oversize = new Uint8Array(62 * 1024 * 1024);
    const res = await pub.call("/api/segnalazioni", { method: "POST", body: oversize, headers: { "content-type": "multipart/form-data; boundary=x" } });
    ok(res.status === 413, `una segnalazione oltre il limite di dimensione è rifiutata senza leggerla (${res.status})`);
  }

  section("API: utenti");
  const users = (await admin.json("/api/utenti")).data.users as Json[];
  const rangerId = users.find((u) => u.email === "ranger@example.test")!.id;
  ok((await admin.json(`/api/utenti/${rangerId}`, { method: "PATCH", json: { active: false } })).status === 200, "operatore disattivato");
  ok((await ranger.call("/api/segnalazioni")).status === 401, "la sessione dell'operatore disattivato è chiusa");
  ok((await ranger.login("ranger@example.test", rangerPassword)).status === 401, "l'operatore disattivato non può rientrare");

  return newPassword;
}

/** Runs last: it exhausts the login limiter for this address. */
export async function runRateLimitTest(base: string) {
  section("API: limite ai tentativi di accesso");
  const c = new Client(base, true);
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) limited = (await c.login("nessuno@example.test", "x")).status === 429;
  ok(limited, "dopo troppi tentativi di login la risposta è 429");
}
