import type * as Leaflet from "leaflet";
import { CATEGORIES, MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_REPORT_BYTES, type Category, type PhotoMeta, type SubmitMeta } from "../../shared/model.ts";
import { h, replace, toast, fmtBytes } from "../dom.ts";
import { isOperator, session } from "../api.ts";
import { LocationTracker, openCamera, pickFiles, fromFile, supportsInAppCamera, type CapturedPhoto } from "../capture.ts";
import { outbox, persistStorage } from "../store.ts";
import { send } from "../sender.ts";
import { appState } from "../app-state.ts";
import { navigate } from "../router.ts";

const ORIGIN_LABEL = {
  in_app_camera: "Scattata nell'app",
  native_camera: "Fotocamera del telefono",
  file_upload: "Da galleria",
} as const;

export function newReportView() {
  const operator = isOperator();
  const tracker = new LocationTracker();
  tracker.start();
  const photos: CapturedPhoto[] = [];
  const urls = new Map<CapturedPhoto, string>();

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (photos.length) e.preventDefault();
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  const sync = () => (appState.busy = photos.length > 0);

  // --- location banner
  const locBanner = h("div", { class: "loc-banner" });
  tracker.subscribe((s) => {
    const fix = tracker.freshFix();
    if (fix) {
      const acc = Math.round(fix.coords.accuracy);
      locBanner.className = `loc-banner ${acc <= 30 ? "good" : acc <= 100 ? "fair" : "poor"}`;
      locBanner.textContent = `📍 Posizione rilevata, precisione ±${acc} m${acc > 100 ? " — spostati all'aperto per migliorarla" : ""}`;
    } else if (s.kind === "denied") {
      locBanner.className = "loc-banner poor";
      replace(
        locBanner,
        "⚠ La posizione è bloccata. ",
        operator ? "Le foto verranno inviate senza GPS." : "Senza posizione la segnalazione non può essere inviata.",
        " Consenti la posizione nelle impostazioni del browser per questo sito e ricarica la pagina.",
      );
    } else if (s.kind === "unavailable") {
      locBanner.className = "loc-banner poor";
      locBanner.textContent = `⚠ ${s.message}`;
    } else {
      locBanner.className = "loc-banner";
      locBanner.textContent = "Rilevo la posizione… Il browser potrebbe chiederti il permesso.";
    }
  });

  // --- photos
  const grid = h("div", { class: "photo-grid" });
  const counter = h("span", { class: "muted" });
  const renderPhotos = () => {
    counter.textContent = `${photos.length}/${MAX_PHOTOS}`;
    replace(
      grid,
      photos.length === 0 && h("p", { class: "empty" }, "Nessuna foto. Scatta almeno una foto del problema."),
      photos.map((p, i) => {
        if (!urls.has(p)) urls.set(p, URL.createObjectURL(p.thumb));
        const loc = p.location;
        return h(
          "figure",
          { class: "photo" },
          h("img", { src: urls.get(p), alt: `Foto ${i + 1}` }),
          h(
            "figcaption",
            null,
            h(
              "span",
              { class: `badge ${loc ? (loc.source === "manual" ? "badge-warn" : "badge-ok") : "badge-bad"}` },
              loc ? (loc.source === "manual" ? "📍 manuale" : `📍 ±${Math.round(loc.accuracy ?? 0)} m`) : "senza posizione",
            ),
            h("span", { class: "small muted" }, `${ORIGIN_LABEL[p.origin]} · ${fmtBytes(p.size)}`),
            p.origin === "file_upload" &&
              !loc &&
              h("button", { class: "btn-link small", type: "button", onclick: () => placeOnMap(p) }, "Indica sulla mappa"),
          ),
          h(
            "button",
            {
              class: "photo-remove",
              type: "button",
              "aria-label": `Rimuovi foto ${i + 1}`,
              onclick: () => {
                URL.revokeObjectURL(urls.get(p)!);
                urls.delete(p);
                photos.splice(photos.indexOf(p), 1);
                renderPhotos();
                sync();
              },
            },
            "×",
          ),
        );
      }),
    );
  };

  const addPhoto = (p: CapturedPhoto) => {
    if (photos.length >= MAX_PHOTOS) return;
    if (photos.some((x) => x.sha256 === p.sha256)) {
      toast("Questa foto è già stata aggiunta", "error");
      return;
    }
    // The server refuses these anyway; saying so now keeps an unsendable report out of the outbox.
    if (p.size > MAX_PHOTO_BYTES) {
      toast(`La foto supera i ${MAX_PHOTO_BYTES / 1048576} MB`, "error");
      return;
    }
    if (photos.reduce((n, x) => n + x.size, p.size) > MAX_REPORT_BYTES) {
      toast(`Spazio esaurito: una segnalazione può contenere al massimo ${MAX_REPORT_BYTES / 1048576} MB di foto. Inviala e aprine un'altra.`, "error");
      return;
    }
    photos.push(p);
    renderPhotos();
    sync();
  };

  const shoot = async () => {
    if (supportsInAppCamera()) {
      await openCamera(tracker, { requireLocation: !operator, onShot: addPhoto, remaining: () => MAX_PHOTOS - photos.length });
      return;
    }
    // Fallback: the phone's camera app. Bytes are taken as-is; freshness is checked server-side.
    if (!operator && !tracker.freshFix()) {
      toast("Attendi che la posizione sia rilevata", "error");
      return;
    }
    const files = await pickFiles({ capture: true, multiple: false });
    for (const f of files) addPhoto(await fromFile(f, "native_camera", tracker));
  };

  const upload = async () => {
    const files = await pickFiles({ capture: false, multiple: true });
    for (const f of files.slice(0, MAX_PHOTOS - photos.length)) {
      try {
        addPhoto(await fromFile(f, "file_upload", tracker));
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, "error");
      }
    }
  };

  async function placeOnMap(p: CapturedPhoto) {
    const { createMap, L } = await import("../map.ts");
    const mapEl = h("div", { class: "map map-modal" });
    const confirmBtn = h("button", { class: "btn btn-primary", type: "button", disabled: true }, "Usa questa posizione");
    let chosen: { lat: number; lon: number } | null = null;
    const dialog = h(
      "dialog",
      { class: "modal" },
      h("h2", null, "Dove è stata scattata la foto?"),
      h("p", { class: "small muted" }, "Tocca la mappa nel punto esatto. La posizione sarà registrata come indicata a mano, con meno valore di un GPS."),
      mapEl,
      h("div", { class: "row end" }, h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Annulla"), confirmBtn),
    );
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
    const fix = tracker.freshFix();
    const map = createMap(mapEl, fix ? [fix.coords.latitude, fix.coords.longitude] : undefined, fix ? 16 : 6);
    let marker: Leaflet.Marker | null = null;
    map.on("click", (e: Leaflet.LeafletMouseEvent) => {
      chosen = { lat: e.latlng.lat, lon: e.latlng.lng };
      marker ??= L.marker(e.latlng).addTo(map);
      marker.setLatLng(e.latlng);
      confirmBtn.disabled = false;
    });
    confirmBtn.onclick = () => {
      if (!chosen) return;
      p.location = { lat: chosen.lat, lon: chosen.lon, source: "manual" };
      dialog.close();
      renderPhotos();
    };
  }

  // --- details
  let category: Category | null = null;
  const chips = h(
    "div",
    { class: "chips", role: "radiogroup", "aria-label": "Categoria" },
    Object.entries(CATEGORIES).map(([key, label]) =>
      h(
        "label",
        { class: "chip" },
        h("input", { type: "radio", name: "category", value: key, onchange: () => (category = key as Category) }),
        h("span", null, label),
      ),
    ),
  );
  const description = h("textarea", {
    rows: 4,
    maxlength: 4000,
    placeholder: "Cosa hai visto? Da quanto tempo c'è? Indicazioni utili per trovare il punto.",
    required: true,
  });
  const contact = h("input", { type: "text", maxlength: 200, autocomplete: "email", placeholder: "Email o telefono (facoltativo)" });
  const consent = h("input", { type: "checkbox" });
  const errorBox = h("div", { class: "form-error", role: "alert" });
  const submitBtn = h("button", { class: "btn btn-primary btn-xl", type: "submit" }, "Invia segnalazione");

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        errorBox.textContent = "";
        const problems: string[] = [];
        if (photos.length === 0) problems.push("aggiungi almeno una foto");
        if (!operator && photos.some((p) => !p.location)) problems.push("tutte le foto devono avere la posizione");
        if (!category) problems.push("scegli una categoria");
        if (description.value.trim().length < 5) problems.push("descrivi brevemente il problema");
        if (!operator && !consent.checked) problems.push("conferma di aver letto l'informativa privacy");
        if (problems.length) {
          errorBox.textContent = `Per inviare: ${problems.join("; ")}.`;
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = "Invio in corso…";
        await persistStorage();
        const clientReportId = crypto.randomUUID();
        const meta: SubmitMeta = {
          clientReportId,
          category: category!,
          description: description.value.trim(),
          consent: operator ? true : consent.checked,
          clientCreatedAt: new Date().toISOString(),
          queued: false,
          photos: photos.map(
            (p, index): PhotoMeta => ({
              index,
              sha256: p.sha256,
              size: p.size,
              origin: p.origin,
              capturedAt: p.capturedAt,
              ...(p.fileLastModified ? { fileLastModified: p.fileLastModified } : {}),
              ...(p.location ? { location: p.location } : {}),
            }),
          ),
        };
        if (!operator && contact.value.trim()) meta.contact = contact.value.trim();
        const item = { clientReportId, meta, photos: photos.map((p) => p.blob), thumbs: photos.map((p) => p.thumb), createdAt: meta.clientCreatedAt, attempts: 0 };
        // The outbox is written before the network is touched: closing the app mid-upload loses nothing.
        await outbox.put(item);
        photos.length = 0;
        sync();
        const result = navigator.onLine ? await send(item) : { ok: false as const, retryable: true, message: "offline" };
        if (result.ok) {
          navigate(`#/ricevuta/${result.receipt.reportId}`);
        } else if (result.retryable) {
          toast("Nessuna connessione: la segnalazione è salvata e partirà da sola appena torna la rete.");
          navigate("#/mie");
        } else {
          toast(result.message, "error");
          navigate("#/mie");
        }
      },
    },
    h(
      "section",
      { class: "card stack" },
      h("div", { class: "row between" }, h("h2", null, "1. Foto"), counter),
      locBanner,
      grid,
      h(
        "div",
        { class: "row wrap" },
        h("button", { class: "btn btn-primary", type: "button", onclick: shoot }, "📷 Scatta foto"),
        operator && h("button", { class: "btn", type: "button", onclick: upload }, "🖼 Carica dalla galleria"),
      ),
      operator
        ? h("p", { class: "small muted" }, "Le foto caricate dalla galleria hanno meno valore probatorio: la loro posizione dipende dai metadati del file, spesso rimossi da app di messaggistica e posta.")
        : h("p", { class: "small muted" }, "Per garantire che le foto siano autentiche, si possono solo scattare sul posto con questa app."),
    ),
    h("section", { class: "card stack" }, h("h2", null, "2. Che cosa hai trovato"), chips),
    h(
      "section",
      { class: "card stack" },
      h("h2", null, "3. Descrizione"),
      description,
      !operator &&
        h(
          "div",
          { class: "stack" },
          h("label", { class: "field" }, h("span", null, "Recapito, se vuoi essere ricontattato"), contact),
          h(
            "label",
            { class: "check" },
            consent,
            h("span", null, "Ho letto l'", h("a", { href: "#/privacy", target: "_blank" }, "informativa sul trattamento dei dati"), " e confermo di non fotografare volti o documenti di persone se non strettamente necessario."),
          ),
        ),
    ),
    errorBox,
    submitBtn,
  );

  renderPhotos();
  const view = h("section", { class: "stack" }, h("h1", null, operator ? `Nuova segnalazione — ${session.me!.name}` : "Nuova segnalazione"), form);
  return {
    el: view,
    cleanup: () => {
      tracker.stop();
      window.removeEventListener("beforeunload", onBeforeUnload);
      urls.forEach((u) => URL.revokeObjectURL(u));
      appState.busy = false;
    },
  };
}
