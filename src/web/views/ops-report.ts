import type * as Leaflet from "leaflet";
import { CATEGORIES, STATUSES, type Category, type Status } from "../../shared/model.ts";
import type { ExifInfo } from "../../shared/exif.ts";
import { h, fmtDate, fmtBytes, hashBlock, replace, toast } from "../dom.ts";
import { api, isAdmin, session } from "../api.ts";
import { navigate } from "../router.ts";
import { opsNav, requireOperatorView } from "./ops.ts";

interface Detail {
  report: {
    id: string;
    received_at: string;
    channel: string;
    submitter_name: string | null;
    category: Category;
    description: string;
    contact: string | null;
    lat: number | null;
    lon: number | null;
    warn_count: number;
    manifest_sha256: string;
    country: string | null;
    user_agent: string | null;
    moderation: "in_attesa" | "accettata" | "rifiutata";
    moderated_at: string | null;
    rejection_reason: string | null;
    status: Status;
    status_note: string | null;
    status_updated_at: string | null;
  };
  photos: {
    index: number;
    sha256: string;
    size: number;
    mime: string;
    origin: string;
    capturedAt: string;
    location: { lat: number; lon: number; accuracy: number | null; source: string } | null;
    exif: ExifInfo | null;
    flags: { code: string; level: "info" | "warn"; detail?: string; label: string }[];
    hasDerived: boolean;
    derivedSha256: string | null;
    removed: boolean;
  }[];
  chain: {
    seq: number;
    prevHash: string;
    entryHash: string;
    manifestSha256: string;
    receivedAt: string;
    preimage: string;
    tsa: { status: string; genTime: string | null; error: string | null; attempts: number };
  } | null;
  history: { at: string; action: string; detail: Record<string, unknown> | null; user_name: string | null }[];
}

const ORIGIN = { in_app_camera: "Scattata nell'app", native_camera: "Fotocamera del telefono", file_upload: "Caricata da galleria" } as Record<string, string>;
const SOURCE = { device_gps: "GPS del telefono", exif: "metadati EXIF del file", manual: "indicata a mano" } as Record<string, string>;
const ACTIONS: Record<string, string> = {
  segnalazione_ricevuta: "Ricevuta",
  consultazione: "Consultata",
  download_foto: "Foto scaricata",
  export_pacchetto: "Pacchetto esportato",
  cambio_stato: "Stato cambiato",
  moderazione_accettata: "Accettata in moderazione",
  moderazione_rifiutata: "Rifiutata in moderazione",
};

export async function opsReportView(id: string) {
  if (!requireOperatorView()) return h("div");
  const d = await api<Detail>(`/segnalazioni/${encodeURIComponent(id)}`);
  const r = d.report;
  const pending = r.moderation === "in_attesa";
  const base = `/api/segnalazioni/${encodeURIComponent(r.id)}/photos`;

  const { createMap, dot, accuracyCircle, colorFor, L } = await import("../map.ts");
  const mapEl = h("div", { class: "map map-detail" });

  const photoCards = d.photos.map((p) => {
    const img = h("img", { src: `${base}/${p.index}/originale`, alt: `Foto ${p.index + 1}`, loading: "lazy", class: pending ? "blurred" : "" });
    const reveal = pending && h("button", { class: "reveal", type: "button", onclick: (e: Event) => { img.classList.remove("blurred"); (e.currentTarget as HTMLElement).remove(); } }, "Mostra immagine");
    const warns = p.flags.filter((f) => f.level === "warn");
    return h(
      "article",
      { class: "card photo-detail" },
      p.removed
        ? h("div", { class: "removed" }, "Contenuto rimosso in moderazione")
        : h("div", { class: "photo-frame" }, pending ? img : h("a", { href: `${base}/${p.index}/originale`, target: "_blank", rel: "noopener" }, img), reveal),
      h(
        "div",
        { class: "stack" },
        h("div", { class: "row between" }, h("h3", null, `Foto ${p.index + 1}`), h("span", { class: `badge ${warns.length ? "badge-warn" : "badge-ok"}` }, warns.length ? `${warns.length} avvisi` : "nessun avviso")),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "Provenienza"),
          h("dd", null, ORIGIN[p.origin] ?? p.origin),
          h("dt", null, "Scatto (orologio del telefono)"),
          h("dd", null, fmtDate(p.capturedAt)),
          h("dt", null, "Posizione"),
          h(
            "dd",
            null,
            p.location
              ? `${p.location.lat.toFixed(6)}, ${p.location.lon.toFixed(6)}${p.location.accuracy ? ` ±${Math.round(p.location.accuracy)} m` : ""} — ${SOURCE[p.location.source] ?? p.location.source}`
              : "assente",
          ),
          p.exif?.make && [h("dt", null, "Dispositivo (EXIF)"), h("dd", null, [p.exif.make, p.exif.model].filter(Boolean).join(" "))],
          p.exif?.software && [h("dt", null, "Software (EXIF)"), h("dd", null, p.exif.software)],
          p.exif?.dateTimeOriginal && [h("dt", null, "Data scatto (EXIF)"), h("dd", null, `${p.exif.dateTimeOriginal} ${p.exif.offsetTimeOriginal ?? ""}`)],
          h("dt", null, "File"),
          h("dd", null, `${p.mime} · ${fmtBytes(p.size)}`),
        ),
        p.flags.length > 0 &&
          h("ul", { class: "flags" }, p.flags.map((f) => h("li", { class: `flag flag-${f.level}` }, f.label, f.detail ? ` (${f.detail})` : ""))),
        hashBlock("SHA-256", p.sha256),
        !p.removed &&
          !pending &&
          h(
            "div",
            { class: "row wrap" },
            h("a", { class: "btn btn-small", href: `${base}/${p.index}/originale?download=1` }, "Scarica originale"),
            p.hasDerived && h("a", { class: "btn btn-small", href: `${base}/${p.index}/gps?download=1`, title: "Copia con la posizione scritta nei metadati, per le mappe" }, "Scarica copia con GPS"),
          ),
      ),
    );
  });

  // --- moderation or status panel
  let actionPanel: HTMLElement | null = null;
  if (pending && isAdmin()) {
    const reason = h(
      "select",
      { "aria-label": "Motivo del rifiuto" },
      h("option", { value: "" }, "Motivo del rifiuto…"),
      Object.entries(session.config?.rejectionReasons ?? {}).map(([k, v]) => h("option", { value: k }, v)),
    );
    const note = h("input", { type: "text", placeholder: "Nota interna (facoltativa)", "aria-label": "Nota interna", maxlength: 500 });
    const decide = async (decision: "accetta" | "rifiuta") => {
      if (decision === "rifiuta" && !reason.value) {
        toast("Scegli il motivo del rifiuto", "error");
        return;
      }
      const msg =
        decision === "accetta"
          ? "Accettare? Foto e dati passeranno nell'archivio probatorio non cancellabile."
          : "Rifiutare? Foto, testo e posizione verranno cancellati definitivamente. Resterà solo l'impronta nella catena.";
      if (!confirm(msg)) return;
      try {
        await api(`/segnalazioni/${r.id}/moderazione`, { method: "POST", json: { decision, reason: reason.value || undefined, note: note.value || undefined } });
        toast(decision === "accetta" ? "Segnalazione accettata" : "Segnalazione rifiutata e contenuto eliminato");
        navigate("#/operatori/moderazione");
      } catch (e) {
        toast((e as Error).message, "error");
      }
    };
    actionPanel = h(
      "section",
      { class: "card stack moderation-panel" },
      h("h2", null, "Moderazione"),
      h("p", { class: "small" }, "Accetta solo se le foto documentano un problema ambientale e non contengono materiale illecito. Volti e targhe non sono di per sé motivo di rifiuto: l'accesso resta limitato agli operatori."),
      h("div", { class: "row wrap" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => decide("accetta") }, "Accetta")),
      h("div", { class: "row wrap" }, reason, note, h("button", { class: "btn btn-danger", type: "button", onclick: () => decide("rifiuta") }, "Rifiuta ed elimina")),
    );
  } else if (r.moderation === "accettata") {
    const status = h("select", null, Object.entries(STATUSES).map(([k, v]) => h("option", { value: k, selected: k === r.status }, v)));
    const note = h("textarea", { rows: 2, placeholder: "Nota (es. numero di protocollo del portale)", maxlength: 2000 }, r.status_note ?? "");
    actionPanel = h(
      "section",
      { class: "card stack" },
      h("h2", null, "Lavorazione"),
      h("label", { class: "field" }, h("span", null, "Stato"), status),
      h("label", { class: "field" }, h("span", null, "Nota"), note),
      h(
        "div",
        { class: "row wrap" },
        h(
          "button",
          {
            class: "btn btn-primary",
            type: "button",
            onclick: async () => {
              try {
                await api(`/segnalazioni/${r.id}`, { method: "PATCH", json: { status: status.value, note: note.value } });
                toast("Stato aggiornato");
                navigate(`#/operatori/segnalazione/${r.id}`);
              } catch (e) {
                toast((e as Error).message, "error");
              }
            },
          },
          "Salva",
        ),
        h("a", { class: "btn", href: `/api/segnalazioni/${r.id}/pacchetto.zip` }, "⬇ Pacchetto probatorio (ZIP)"),
        h("button", { class: "btn", type: "button", onclick: () => print() }, "🖨 Stampa scheda"),
      ),
    );
  }

  const c = d.chain;
  const view = h(
    "section",
    { class: "stack wide report-detail" },
    h("a", { class: "btn-link no-print", href: pending ? "#/operatori/moderazione" : "#/operatori" }, "← Torna all'elenco"),
    h("div", { class: "row between wrap" }, h("h1", null, `${CATEGORIES[r.category]} — ${r.id}`), h("span", { class: `badge ${r.moderation === "accettata" ? `status-${r.status}` : r.moderation === "rifiutata" ? "badge-bad" : "badge-neutral"}` }, r.moderation === "accettata" ? STATUSES[r.status] : r.moderation === "rifiutata" ? "Rifiutata" : "Da moderare")),
    h("div", { class: "no-print" }, opsNav(pending ? "moderation" : "list")),
    r.moderation === "rifiutata" && h("div", { class: "notice notice-bad" }, `Rifiutata il ${fmtDate(r.moderated_at)}: ${session.config?.rejectionReasons[r.rejection_reason ?? ""] ?? r.rejection_reason}. Il contenuto è stato eliminato.`),
    h(
      "div",
      { class: "split" },
      h(
        "section",
        { class: "card stack" },
        h("h2", null, "Segnalazione"),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "Ricevuta dal server"),
          h("dd", null, fmtDate(r.received_at)),
          h("dt", null, "Canale"),
          h("dd", null, r.channel === "operatore" ? `Operatore: ${r.submitter_name ?? "—"}` : "Pubblico"),
          r.contact && [h("dt", null, "Recapito"), h("dd", null, r.contact)],
          r.country && [h("dt", null, "Paese di connessione"), h("dd", null, r.country)],
          r.user_agent && [h("dt", null, "Browser"), h("dd", { class: "small" }, r.user_agent)],
        ),
        h("h3", null, "Descrizione"),
        h("p", { class: "prewrap" }, r.description || "—"),
      ),
      h("section", { class: "card" }, mapEl),
    ),
    actionPanel,
    h("h2", null, "Foto"),
    h("div", { class: "stack" }, photoCards),
    c &&
      h(
        "section",
        { class: "card stack" },
        h("h2", null, "Catena e marca temporale"),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "Anello"),
          h("dd", null, `n. ${c.seq}`),
          h("dt", null, "Marca temporale"),
          h("dd", null, c.tsa.status === "granted" ? `apposta il ${fmtDate(c.tsa.genTime)}` : c.tsa.status === "error" ? `errore: ${c.tsa.error} (tentativi: ${c.tsa.attempts}, si riprova in automatico)` : c.tsa.status === "disabled" ? "non configurata" : "in attesa"),
        ),
        hashBlock("Anello", c.entryHash),
        hashBlock("Precedente", c.prevHash),
        hashBlock("Manifest", c.manifestSha256),
        h("details", null, h("summary", null, "Stringa su cui è calcolato l'anello"), h("pre", { class: "code" }, c.preimage)),
      ),
    h(
      "section",
      { class: "card stack" },
      h("h2", null, "Registro"),
      h(
        "ol",
        { class: "timeline" },
        d.history.map((e) =>
          h(
            "li",
            null,
            h("span", { class: "small muted" }, fmtDate(e.at)),
            " ",
            h("strong", null, ACTIONS[e.action] ?? e.action),
            e.user_name ? ` — ${e.user_name}` : "",
            e.detail && e.action === "cambio_stato" ? ` (${STATUSES[e.detail.a as Status] ?? e.detail.a}${e.detail.nota ? `: ${e.detail.nota}` : ""})` : "",
          ),
        ),
      ),
    ),
  );

  // Leaflet measures its container, so build the map once the view is in the document.
  let map: Leaflet.Map | null = null;
  requestAnimationFrame(() => {
    const pts: [number, number][] = [];
    for (const p of d.photos) if (p.location) pts.push([p.location.lat, p.location.lon]);
    if (!pts.length) {
      replace(mapEl, h("p", { class: "empty" }, "Nessuna posizione disponibile"));
      return;
    }
    map = createMap(mapEl);
    for (const p of d.photos) {
      if (!p.location) continue;
      if (p.location.accuracy) accuracyCircle(p.location.lat, p.location.lon, p.location.accuracy).addTo(map);
      dot(p.location.lat, p.location.lon, colorFor(p.flags.filter((f) => f.level === "warn").length)).bindTooltip(`Foto ${p.index + 1}`).addTo(map);
    }
    map.fitBounds(L.latLngBounds(pts).pad(0.5), { maxZoom: 17 });
  });

  return { el: view, cleanup: () => map?.remove() };
}
