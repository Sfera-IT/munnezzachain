import { CATEGORIES, type Category } from "../../shared/model.ts";
import { h, fmtDate, replace, toast } from "../dom.ts";
import { outbox, receipts } from "../store.ts";
import { flushOutbox, send } from "../sender.ts";

export async function mineView() {
  const body = h("div", { class: "stack" });
  const urls: string[] = [];
  const img = (b?: Blob) => {
    if (!b) return h("div", { class: "thumb thumb-empty" });
    const u = URL.createObjectURL(b);
    urls.push(u);
    return h("img", { class: "thumb", src: u, alt: "" });
  };

  const draw = async () => {
    const [queue, done] = await Promise.all([outbox.all(), receipts.all()]);
    replace(
      body,
      queue.length > 0 &&
        h(
          "section",
          { class: "card stack" },
          h("h2", null, "Da inviare"),
          queue.map((item) =>
            h(
              "div",
              { class: "list-row" },
              img(item.thumbs[0]),
              h(
                "div",
                { class: "grow" },
                h("strong", null, CATEGORIES[item.meta.category as Category]),
                h("div", { class: "small muted" }, `${fmtDate(item.createdAt)} · ${item.photos.length} foto`),
                item.lastError && h("div", { class: `small ${item.rejected ? "text-bad" : "text-warn"}` }, item.rejected ? `Rifiutata: ${item.lastError}` : `Ultimo tentativo: ${item.lastError}`),
              ),
              h(
                "div",
                { class: "col" },
                !item.rejected &&
                  h(
                    "button",
                    {
                      class: "btn btn-small",
                      type: "button",
                      onclick: async (e: Event) => {
                        (e.currentTarget as HTMLButtonElement).disabled = true;
                        const r = await send(item);
                        toast(r.ok ? "Segnalazione inviata" : r.message, r.ok ? "ok" : "error");
                        void draw();
                      },
                    },
                    "Invia ora",
                  ),
                h(
                  "button",
                  {
                    class: "btn-link small text-bad",
                    type: "button",
                    onclick: async () => {
                      if (!confirm("Eliminare questa segnalazione dal telefono? Le foto non inviate andranno perse.")) return;
                      await outbox.delete(item.clientReportId);
                      void draw();
                    },
                  },
                  "Elimina",
                ),
              ),
            ),
          ),
        ),
      h(
        "section",
        { class: "card stack" },
        h("h2", null, "Inviate"),
        done.length === 0
          ? h("p", { class: "empty" }, "Nessuna segnalazione inviata da questo telefono.")
          : done.map((r) =>
              h(
                "a",
                { class: "list-row", href: `#/ricevuta/${r.reportId}` },
                img(r.thumb),
                h(
                  "div",
                  { class: "grow" },
                  h("strong", null, CATEGORIES[r.category as Category] ?? r.category),
                  h("div", { class: "small muted" }, `${fmtDate(r.receivedAt)} · codice ${r.reportId}`),
                ),
                h("span", { class: `badge ${r.moderation === "accettata" ? "badge-ok" : "badge-neutral"}` }, r.moderation === "accettata" ? "Registrata" : "In verifica"),
              ),
            ),
      ),
    );
  };

  const onChange = () => void draw();
  window.addEventListener("outbox-changed", onChange);
  await draw();
  void flushOutbox();
  return {
    el: h("section", { class: "stack" }, h("h1", null, "Le mie segnalazioni"), h("p", { class: "muted" }, "Questo elenco resta solo su questo telefono."), body),
    cleanup: () => {
      window.removeEventListener("outbox-changed", onChange);
      urls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
