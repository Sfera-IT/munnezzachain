import { sha256Hex, isSha256Hex } from "../../shared/bytes.ts";
import { h, fmtDate, hashBlock, replace } from "../dom.ts";
import { api } from "../api.ts";

interface Result {
  found: boolean;
  kind?: "voce_catena" | "manifest" | "foto_originale" | "copia_con_gps";
  reportId?: string;
  moderation?: string;
  receivedAt?: string;
  seq?: number;
  prevHash?: string;
  entryHash?: string;
  manifestSha256?: string;
  preimage?: string;
  timestamp?: { status: string; genTime: string | null };
}

const KIND = {
  voce_catena: "un anello della catena",
  manifest: "il manifest di una segnalazione",
  foto_originale: "una foto originale, identica byte per byte",
  copia_con_gps: "una copia con GPS generata dal sistema",
};

export function verifyView() {
  const out = h("div", { class: "stack", "aria-live": "polite" });

  const lookup = async (hash: string, label: string) => {
    replace(out, h("p", { class: "muted" }, `Cerco ${label}…`));
    try {
      const r = await api<Result>(`/verifica/${hash}`);
      if (!r.found) {
        replace(
          out,
          h(
            "div",
            { class: "card notice notice-bad" },
            h("strong", null, "Non registrato."),
            " Nessuna segnalazione contiene questo file. Se è una foto, potrebbe essere stata modificata, ricompressa o inviata tramite un'app che altera i file.",
            hashBlock("Impronta cercata", hash),
          ),
        );
        return;
      }
      replace(
        out,
        h(
          "div",
          { class: "card stack notice notice-ok" },
          h("strong", null, `Registrato: è ${KIND[r.kind!]}.`),
          r.moderation === "rifiutata" && h("p", null, "La segnalazione non è stata accettata in moderazione e il suo contenuto è stato rimosso. Resta registrata solo l'impronta."),
          h(
            "dl",
            { class: "facts" },
            h("dt", null, "Segnalazione"),
            h("dd", null, r.reportId),
            h("dt", null, "Ricevuta il"),
            h("dd", null, fmtDate(r.receivedAt)),
            h("dt", null, "Anello"),
            h("dd", null, `n. ${r.seq}`),
            h("dt", null, "Marca temporale"),
            h(
              "dd",
              null,
              r.timestamp!.status === "granted"
                ? h("span", null, fmtDate(r.timestamp!.genTime), " · ", h("a", { href: `/api/verifica/${r.entryHash}/marca-temporale.tsr` }, "scarica .tsr"))
                : "non ancora apposta",
            ),
          ),
          h(
            "details",
            null,
            h("summary", null, "Verifica indipendente"),
            h("p", { class: "small" }, "L'impronta dell'anello è lo SHA-256 di questa stringa esatta:"),
            h("pre", { class: "code" }, r.preimage),
            hashBlock("Impronta anello", r.entryHash!),
            hashBlock("Anello precedente", r.prevHash!),
            hashBlock("Manifest", r.manifestSha256!),
          ),
        ),
      );
    } catch (e) {
      replace(out, h("div", { class: "card notice notice-bad" }, (e as Error).message));
    }
  };

  const fileInput = h("input", {
    type: "file",
    class: "visually-hidden",
    onchange: async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      replace(out, h("p", { class: "muted" }, "Calcolo l'impronta sul tuo dispositivo…"));
      const hash = await sha256Hex(await f.arrayBuffer());
      await lookup(hash, f.name);
    },
  });
  const drop = h(
    "label",
    { class: "dropzone" },
    fileInput,
    h("strong", null, "Scegli o trascina un file"),
    h("span", { class: "small muted" }, "Il file non viene caricato: l'impronta si calcola qui sul dispositivo."),
  );
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files[0];
    if (f) await lookup(await sha256Hex(await f.arrayBuffer()), f.name);
  });

  const hashInput = h("input", { type: "text", placeholder: "oppure incolla un'impronta SHA-256", spellcheck: false, autocapitalize: "off" });
  return h(
    "section",
    { class: "stack" },
    h("h1", null, "Verifica"),
    h("p", { class: "lead" }, "Controlla se una foto, un manifest o un anello della catena è registrato, e quando."),
    drop,
    h(
      "form",
      {
        class: "row",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const v = hashInput.value.trim().toLowerCase();
          if (!isSha256Hex(v)) {
            replace(out, h("div", { class: "card notice notice-bad" }, "Un'impronta SHA-256 ha 64 caratteri esadecimali."));
            return;
          }
          void lookup(v, "l'impronta");
        },
      },
      hashInput,
      h("button", { class: "btn", type: "submit" }, "Cerca"),
    ),
    out,
  );
}
