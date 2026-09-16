import { CATEGORIES, type Category } from "../../shared/model.ts";
import { h, fmtDate, hashBlock, download } from "../dom.ts";
import { api } from "../api.ts";
import { receipts } from "../store.ts";

interface VerifyResult {
  found: boolean;
  moderation?: string;
  timestamp?: { status: string; genTime: string | null };
}

export async function receiptView(id: string) {
  const r = await receipts.get(id);
  if (!r) throw new Error("Ricevuta non presente su questo telefono.");
  const tsa = h("span", { class: "badge badge-neutral" }, "verifica in corso…");
  const moderation = h("span", { class: "badge badge-neutral" }, r.moderation === "accettata" ? "Registrata" : "In verifica");

  let tries = 0;
  const check = async () => {
    try {
      const v = await api<VerifyResult>(`/verifica/${r.entryHash}`);
      if (!v.found) return;
      const ts = v.timestamp!;
      if (ts.status === "pending" && tries++ < 6) setTimeout(() => void check(), 3000);
      tsa.className = `badge ${ts.status === "granted" ? "badge-ok" : ts.status === "error" ? "badge-warn" : "badge-neutral"}`;
      tsa.textContent = ts.status === "granted" ? `apposta il ${fmtDate(ts.genTime)}` : ts.status === "disabled" ? "non prevista" : "in attesa, riprova più tardi";
      moderation.className = `badge ${v.moderation === "accettata" ? "badge-ok" : v.moderation === "rifiutata" ? "badge-bad" : "badge-neutral"}`;
      moderation.textContent = v.moderation === "accettata" ? "Accettata" : v.moderation === "rifiutata" ? "Non accettata" : "In verifica";
    } catch {
      tsa.textContent = "non verificabile ora (offline?)";
    }
  };
  void check();

  const { thumb: _thumb, ...exportable } = r;
  return h(
    "section",
    { class: "stack" },
    h("div", { class: "success-mark", "aria-hidden": "true" }, "✓"),
    h("h1", null, "Segnalazione registrata"),
    h("p", { class: "lead" }, "Grazie. Conserva il codice: identifica la segnalazione e permette di verificarla."),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "receipt-code" }, r.reportId),
      h(
        "dl",
        { class: "facts" },
        h("dt", null, "Ricevuta dal server"),
        h("dd", null, fmtDate(r.receivedAt)),
        h("dt", null, "Categoria"),
        h("dd", null, CATEGORIES[r.category as Category] ?? r.category),
        h("dt", null, "Stato"),
        h("dd", null, moderation),
        h("dt", null, "Posizione nella catena"),
        h("dd", null, `anello n. ${r.seq}`),
        h("dt", null, "Marca temporale"),
        h("dd", null, tsa),
      ),
    ),
    h(
      "details",
      { class: "card" },
      h("summary", null, "Impronte digitali (per verifiche tecniche)"),
      h(
        "div",
        { class: "stack" },
        r.photos.map((p) => hashBlock(`Foto ${p.index + 1}`, p.sha256)),
        hashBlock("Manifest", r.manifestSha256),
        hashBlock("Anello", r.entryHash),
        hashBlock("Anello precedente", r.prevHash),
      ),
    ),
    h(
      "div",
      { class: "row wrap" },
      h("button", { class: "btn", type: "button", onclick: () => download(`ricevuta-${r.reportId}.json`, JSON.stringify(exportable, null, 2)) }, "Scarica ricevuta"),
      h("a", { class: "btn btn-primary", href: "#/segnala" }, "Nuova segnalazione"),
      h("a", { class: "btn-link", href: "#/" }, "Torna all'inizio"),
    ),
  );
}
