import type * as Leaflet from "leaflet";
import { CATEGORIES, STATUSES, type Category, type Status } from "../../shared/model.ts";
import { h, fmtDate, replace, toast } from "../dom.ts";
import { api, isAdmin, isOperator, refreshSession, session } from "../api.ts";
import { navigate } from "../router.ts";

interface Row {
  id: string;
  received_at: string;
  channel: string;
  category: Category;
  description: string;
  lat: number | null;
  lon: number | null;
  location_source: string | null;
  warn_count: number;
  moderation: "in_attesa" | "accettata" | "rifiutata";
  status: Status;
  rejection_reason: string | null;
  submitter_name: string | null;
  photo_count: number;
}

export function requireOperatorView(): boolean {
  if (!session.me) {
    navigate("#/accesso");
    return false;
  }
  if (session.me.mustChangePassword) {
    navigate("#/password");
    return false;
  }
  return true;
}

export function opsNav(active: string) {
  const link = (href: string, label: string, key: string) => h("a", { href, class: `tab ${active === key ? "active" : ""}` }, label);
  return h(
    "nav",
    { class: "tabs", "aria-label": "Sezioni operatori" },
    link("#/operatori", "Segnalazioni", "list"),
    isAdmin() && link("#/operatori/moderazione", "Da moderare", "moderation"),
    isAdmin() && link("#/operatori/utenti", "Utenti", "users"),
    isAdmin() && link("#/operatori/catena", "Catena", "chain"),
    h(
      "button",
      {
        class: "tab btn-link",
        type: "button",
        onclick: async () => {
          await api("/auth/logout", { method: "POST" });
          await refreshSession();
          navigate("#/");
        },
      },
      "Esci",
    ),
  );
}

export async function opsListView(mode: "list" | "moderation") {
  if (!requireOperatorView() || (mode === "moderation" && !isAdmin())) return h("div");
  const moderation = mode === "moderation";
  const params = new URLSearchParams(moderation ? { moderation: "in_attesa" } : {});
  const status = h(
    "select",
    { "aria-label": "Stato" },
    h("option", { value: "" }, "Tutti gli stati"),
    Object.entries(STATUSES).map(([k, v]) => h("option", { value: k }, v)),
  );
  const category = h(
    "select",
    { "aria-label": "Categoria" },
    h("option", { value: "" }, "Tutte le categorie"),
    Object.entries(CATEGORIES).map(([k, v]) => h("option", { value: k }, v)),
  );
  const q = h("input", { type: "search", placeholder: "Codice o testo", "aria-label": "Cerca" });
  const listEl = h("div", { class: "stack" });
  const mapEl = h("div", { class: "map map-ops" });
  const count = h("span", { class: "muted" });

  const { createMap, dot, colorFor, L } = await import("../map.ts");
  let map: Leaflet.Map | null = null;
  let layer: Leaflet.LayerGroup | null = null;

  const load = async () => {
    const p = new URLSearchParams(params);
    if (status.value) p.set("status", status.value);
    if (category.value) p.set("category", category.value);
    if (q.value.trim()) p.set("q", q.value.trim());
    const { reports } = await api<{ reports: Row[]; pendingModeration?: number }>(`/segnalazioni?${p}`);
    count.textContent = `${reports.length} segnalazion${reports.length === 1 ? "e" : "i"}`;
    replace(
      listEl,
      reports.length === 0 && h("p", { class: "empty" }, moderation ? "Nessuna segnalazione da moderare." : "Nessuna segnalazione con questi filtri."),
      reports.map((r) =>
        h(
          "a",
          { class: "list-row", href: `#/operatori/segnalazione/${r.id}` },
          h("span", { class: "dot", style: `background:${colorFor(r.warn_count)}`, title: `${r.warn_count} avvisi` }),
          h(
            "div",
            { class: "grow" },
            h("strong", null, CATEGORIES[r.category]),
            h("div", { class: "small muted" }, `${r.id} · ${fmtDate(r.received_at)} · ${r.photo_count} foto · ${r.channel === "operatore" ? `operatore ${r.submitter_name ?? ""}` : "pubblico"}`),
            h("div", { class: "small clamp" }, moderation ? "Testo nascosto fino all'apertura" : r.description),
          ),
          moderation ? h("span", { class: "badge badge-neutral" }, "Da moderare") : h("span", { class: `badge status-${r.status}` }, STATUSES[r.status]),
        ),
      ),
    );
    if (!moderation) {
      map ??= createMap(mapEl);
      layer?.remove();
      layer = L.layerGroup().addTo(map);
      const pts: [number, number][] = [];
      for (const r of reports) {
        if (r.lat === null || r.lon === null) continue;
        pts.push([r.lat, r.lon]);
        dot(r.lat, r.lon, colorFor(r.warn_count))
          .bindPopup(`<strong>${CATEGORIES[r.category]}</strong><br>${r.id}<br><a href="#/operatori/segnalazione/${r.id}">Apri</a>`)
          .addTo(layer);
      }
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
    }
  };

  for (const el of [status, category]) el.addEventListener("change", () => void load());
  let t: ReturnType<typeof setTimeout>;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => void load(), 300);
  });

  // Leaflet measures its container, so the first load waits until the view is in the document.
  requestAnimationFrame(() => void load().catch((e: Error) => toast(e.message, "error")));

  return {
    el: h(
      "section",
      { class: "stack wide" },
      h("div", { class: "row between wrap" }, h("h1", null, moderation ? "Da moderare" : "Segnalazioni"), h("a", { class: "btn btn-primary", href: "#/segnala" }, "📷 Nuova")),
      opsNav(mode),
      moderation &&
        h(
          "div",
          { class: "notice notice-warn" },
          "Le segnalazioni del pubblico restano in quarantena finché non le accetti. Le immagini sono sfocate: aprile una alla volta. ",
          "Se trovi materiale illecito, rifiutalo senza scaricarlo e segui la procedura interna di segnalazione alle autorità.",
        ),
      !moderation &&
        h(
          "div",
          { class: "row wrap" },
          status,
          category,
          q,
          h("span", { class: "grow" }),
          h("a", { class: "btn btn-small", href: "/api/export/segnalazioni.geojson" }, "GeoJSON"),
          h("a", { class: "btn btn-small", href: "/api/export/segnalazioni.csv" }, "CSV"),
        ),
      count,
      h("div", { class: moderation ? "" : "split" }, !moderation && mapEl, listEl),
    ),
    cleanup: () => map?.remove(),
  };
}

export async function chainView() {
  if (!requireOperatorView() || !isAdmin()) return h("div");
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const head = await api<{ length: number; head: string | null; lastReceivedAt: string | null }>("/verifica/testa");
  const run = async (deep: boolean) => {
    replace(out, h("p", { class: "muted" }, deep ? "Ricalcolo catena, manifest e foto: può richiedere tempo…" : "Ricalcolo la catena…"));
    try {
      type Batch = { ok: boolean; length: number; head: string; problems: { seq: number; reportId: string; problem: string }[]; next: number | null };
      // A deep check comes back in batches: each request re-hashes a bounded number of files.
      const r: Batch = { ok: true, length: 0, head: "", problems: [], next: 1 };
      while (r.next !== null) {
        const b = await api<Batch>(`/export/catena/verifica${deep ? `?completa=1&da=${r.next}` : ""}`);
        r.length += b.length;
        r.problems.push(...b.problems);
        r.ok &&= b.ok;
        r.next = b.next;
        if (b.next !== null) replace(out, h("p", { class: "muted" }, `Ricalcolo catena, manifest e foto: ${r.length} anelli verificati…`));
      }
      replace(
        out,
        h(
          "div",
          { class: `card notice ${r.ok ? "notice-ok" : "notice-bad"}` },
          h("strong", null, r.ok ? `Catena integra: ${r.length} anelli verificati.` : `${r.problems.length} problemi trovati su ${r.length} anelli.`),
          r.problems.length > 0 &&
            h("ul", null, r.problems.map((p) => h("li", null, h("a", { href: `#/operatori/segnalazione/${p.reportId}` }, `Anello ${p.seq}`), `: ${p.problem}`))),
        ),
      );
      toast(r.ok ? "Verifica completata" : "Verifica: problemi rilevati", r.ok ? "ok" : "error");
    } catch (e) {
      replace(out, h("div", { class: "card notice notice-bad" }, (e as Error).message));
    }
  };
  return h(
    "section",
    { class: "stack wide" },
    h("h1", null, "Catena delle segnalazioni"),
    opsNav("chain"),
    h(
      "div",
      { class: "card stack" },
      h("dl", { class: "facts" }, h("dt", null, "Anelli"), h("dd", null, String(head.length)), h("dt", null, "Ultimo anello"), h("dd", null, fmtDate(head.lastReceivedAt))),
      head.head && h("code", { class: "hash" }, head.head),
      h(
        "p",
        { class: "small muted" },
        "Pubblicare periodicamente l'impronta dell'ultimo anello in un luogo esterno (sito istituzionale, PEC a sé stessi, registro protocollo) rende evidente qualsiasi riscrittura della catena anteriore a quella data.",
      ),
      h("div", { class: "row wrap" }, h("button", { class: "btn", type: "button", onclick: () => run(false) }, "Verifica catena"), h("button", { class: "btn", type: "button", onclick: () => run(true) }, "Verifica completa (anche file)")),
    ),
    out,
  );
}

export { isOperator };
