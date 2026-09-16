import { h } from "../dom.ts";
import { isOperator, session } from "../api.ts";
import { outbox } from "../store.ts";

export async function homeView() {
  const pending = (await outbox.all()).filter((i) => !i.rejected).length;
  return h(
    "section",
    { class: "home" },
    h(
      "div",
      { class: "hero" },
      h("h1", null, "Segnala un problema ambientale"),
      h(
        "p",
        { class: "lead" },
        "Rifiuti abbandonati, scarichi nei fiumi, fumi, terreni contaminati. Scatta le foto da qui: posizione e ora vengono registrate e sigillate al momento dello scatto.",
      ),
      h("a", { class: "btn btn-primary btn-xl", href: "#/segnala" }, "📷 Nuova segnalazione"),
      pending > 0 && h("a", { class: "notice notice-warn", href: "#/mie" }, `${pending} segnalazione${pending > 1 ? "i" : ""} in attesa di invio`),
    ),
    h(
      "div",
      { class: "cards" },
      h("a", { class: "card link-card", href: "#/mie" }, h("h3", null, "Le mie segnalazioni"), h("p", null, "Ricevute e invii in coda su questo telefono.")),
      h("a", { class: "card link-card", href: "#/verifica" }, h("h3", null, "Verifica una foto"), h("p", null, "Controlla se un file è registrato e non è stato alterato.")),
      isOperator()
        ? h("a", { class: "card link-card", href: "#/operatori" }, h("h3", null, "Pannello operatori"), h("p", null, `Accesso come ${session.me!.name}.`))
        : h("a", { class: "card link-card", href: "#/accesso" }, h("h3", null, "Area operatori"), h("p", null, "Ranger e personale dell'ufficio.")),
    ),
    h(
      "details",
      { class: "card how" },
      h("summary", null, "Come vengono protette le foto"),
      h(
        "ol",
        null,
        h("li", null, "La foto viene scattata dentro l'app: data, ora e posizione GPS del telefono vengono scritte nel file in quel momento."),
        h("li", null, "Il telefono calcola l'impronta digitale (SHA-256) del file prima dell'invio. Il server la ricalcola: se un solo byte è cambiato, la foto viene rifiutata."),
        h("li", null, "Ogni segnalazione è un anello di una catena di impronte: modificarne una a posteriori romperebbe tutte le successive."),
        h("li", null, "L'anello riceve una marca temporale da un ente terzo, che attesta quando è stato registrato."),
        h("li", null, "Le segnalazioni del pubblico vengono controllate da un amministratore prima di essere usate."),
      ),
    ),
  );
}
