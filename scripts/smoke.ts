// End-to-end check against a running instance (local by default). It creates real reports: never point it
// at production. Usage: node scripts/smoke.ts [baseUrl] <adminEmail> <adminPassword>
import { buildExifSegment, replaceExif, readExif } from "../src/shared/exif.ts";
import { sha256Hex } from "../src/shared/bytes.ts";

const [base = "http://localhost:8787", email, password] = process.argv.slice(2);
if (/workers\.dev|https:/.test(base) && !process.env.SMOKE_ALLOW_REMOTE) throw new Error("rifiuto di scrivere dati di prova su un'istanza remota");

let cookie = "";
async function call(path: string, init: RequestInit = {}, anonymous = false) {
  const res = await fetch(base + path, { ...init, headers: { ...(init.headers as object), ...(anonymous ? {} : { cookie }), origin: base } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  return res;
}
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FALLITO: ${msg}`);
  console.log(`✓ ${msg}`);
};

// A real 1x1 JPEG, then EXIF as the PWA writes it.
const tiny = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
async function photo(lat: number, lon: number, seed: string) {
  const now = new Date();
  const jpeg = replaceExif(
    new Uint8Array(tiny),
    buildExifSegment({ software: `munnezzachain PWA ${seed}`, dateTimeOriginal: "2026:09:16 13:14:51", offsetTimeOriginal: "+02:00", gps: { lat, lon, accuracy: 6, time: now.toISOString() } }),
  );
  return { bytes: jpeg, sha: await sha256Hex(jpeg), at: now.toISOString() };
}

async function submit(seed: string, tamper = false, clientReportId = crypto.randomUUID()) {
  const p = await photo(45.4599, 10.9796, seed);
  const meta = {
    clientReportId,
    category: "rifiuti",
    description: `Prova automatica ${seed}`,
    consent: true,
    clientCreatedAt: p.at,
    queued: false,
    photos: [{ index: 0, sha256: p.sha, size: p.bytes.length, origin: "in_app_camera", capturedAt: p.at, location: { lat: 45.4599, lon: 10.9796, accuracy: 6, fixTime: p.at, source: "device_gps" } }],
  };
  const body = new FormData();
  body.set("meta", JSON.stringify(meta));
  const bytes = tamper ? Uint8Array.from([...p.bytes.slice(0, -3), 0x00, 0xff, 0xd9]) : p.bytes;
  body.set("photo_0", new Blob([bytes], { type: "image/jpeg" }), "foto.jpg");
  // Public reports: no session cookie, or the server rightly treats them as an operator's.
  const res = await call("/api/segnalazioni", { method: "POST", body }, true);
  return { res, data: (await res.json()) as Record<string, any>, p, clientReportId };
}


// --- public submission
const tampered = await submit("manomessa", true);
ok(tampered.res.status === 422, `foto alterata in transito rifiutata (${tampered.data.error})`);

const first = await submit("uno");
ok(first.res.status === 201 && first.data.moderation === "in_attesa", `segnalazione pubblica in quarantena: ${first.data.reportId}, anello ${first.data.seq}`);
ok(readExif(first.p.bytes)?.gps, "la foto contiene il GPS scritto dall'app");

const again = await submit("uno-bis", false, first.clientReportId);
ok(again.res.status === 409, "stesso id client con foto diverse → conflitto");

const verifyPending = await (await call(`/api/verifica/${first.p.sha}`)).json();
ok(verifyPending.found && verifyPending.moderation === "in_attesa", "la verifica pubblica trova la foto in attesa");

// --- operator access
ok((await call("/api/segnalazioni")).status === 401, "elenco protetto senza accesso");
let login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
ok(login.status === 200, "login amministratore");
ok((await call("/api/segnalazioni")).status === 403, "con password provvisoria l'accesso ai dati è bloccato");
const newPassword = `nuova-password-${Date.now()}`;
ok((await call("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: password, next: newPassword }) })).status === 200, "cambio password");
console.log(`  (nuova password admin locale: ${newPassword})`);

const crossOrigin = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
ok(crossOrigin.status === 403, "richiesta da altra origine rifiutata");

const queue = await (await call("/api/segnalazioni?moderation=in_attesa")).json();
ok(queue.reports.some((r: any) => r.id === first.data.reportId), "la segnalazione è in coda di moderazione");

ok((await call(`/api/segnalazioni/${first.data.reportId}/moderazione`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accetta" }) })).status === 200, "moderazione: accettata");
const photoRes = await call(`/api/segnalazioni/${first.data.reportId}/photos/0/originale`);
const served = new Uint8Array(await photoRes.arrayBuffer());
ok((await sha256Hex(served)) === first.p.sha, "l'originale spostato nell'archivio è identico byte per byte");

const detail = await (await call(`/api/segnalazioni/${first.data.reportId}`)).json();
ok(detail.photos[0].flags.filter((f: any) => f.level === "warn").length === 0, "nessun avviso su foto scattata in app con GPS preciso");

const zip = await call(`/api/segnalazioni/${first.data.reportId}/pacchetto.zip`);
const zipBytes = new Uint8Array(await zip.arrayBuffer());
ok(zip.status === 200 && zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, `pacchetto ZIP (${zipBytes.length} byte)`);

ok((await call(`/api/segnalazioni/${first.data.reportId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "inviata", note: "prot. 123" }) })).status === 200, "cambio stato");

// --- rejection
const second = await submit("due");
ok(second.res.status === 201, `seconda segnalazione: ${second.data.reportId}`);
ok((await call(`/api/segnalazioni/${second.data.reportId}/moderazione`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "rifiuta", reason: "non_pertinente" }) })).status === 200, "moderazione: rifiutata");
const rejected = await (await call(`/api/segnalazioni/${second.data.reportId}`)).json();
ok(rejected.report.description === "" && rejected.photos[0].removed, "contenuto rimosso, restano le impronte");
ok((await call(`/api/segnalazioni/${second.data.reportId}/photos/0/originale`)).status === 404, "la foto rifiutata non è più scaricabile");
ok((await call(`/api/segnalazioni/${second.data.reportId}/moderazione`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accetta" }) })).status === 409, "una decisione di moderazione non si ribalta");

// --- operator submission skips quarantine
{
  const p = await photo(45.46, 10.98, "operatore");
  const body = new FormData();
  body.set("meta", JSON.stringify({ clientReportId: crypto.randomUUID(), category: "acqua", description: "Prova operatore da galleria", consent: true, clientCreatedAt: p.at, queued: false, photos: [{ index: 0, sha256: p.sha, size: p.bytes.length, origin: "file_upload", capturedAt: p.at, location: { lat: 45.46, lon: 10.98, source: "exif" } }] }));
  body.set("photo_0", new Blob([p.bytes], { type: "image/jpeg" }), "foto.jpg");
  const res = await call("/api/segnalazioni", { method: "POST", body });
  const data = (await res.json()) as Record<string, any>;
  ok(res.status === 201 && data.moderation === "accettata", "segnalazione di un operatore accettata senza quarantena");
}
{
  const p = await photo(45.46, 10.98, "pubblico-galleria");
  const body = new FormData();
  body.set("meta", JSON.stringify({ clientReportId: crypto.randomUUID(), category: "acqua", description: "Tentativo da galleria", consent: true, clientCreatedAt: p.at, queued: false, photos: [{ index: 0, sha256: p.sha, size: p.bytes.length, origin: "file_upload", capturedAt: p.at, location: { lat: 45.46, lon: 10.98, source: "exif" } }] }));
  body.set("photo_0", new Blob([p.bytes], { type: "image/jpeg" }), "foto.jpg");
  const res = await call("/api/segnalazioni", { method: "POST", body }, true);
  ok(res.status === 422, "il pubblico non può caricare dalla galleria");
}

// --- chain
const chain = await (await call("/api/export/catena/verifica?completa=1")).json();
ok(chain.ok, `catena integra con verifica completa (${chain.length} anelli)`);

const geo = await (await call("/api/export/segnalazioni.geojson")).json();
ok(geo.features.every((f: any) => f.properties.id !== second.data.reportId), "il GeoJSON esclude le segnalazioni rifiutate");

console.log("\nTutti i controlli superati.");
