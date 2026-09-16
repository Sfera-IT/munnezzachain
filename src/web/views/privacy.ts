import { h } from "../dom.ts";
import { session } from "../api.ts";

// A template, not legal advice: the data controller must complete and approve it before public launch.
export function privacyView() {
  const contact = session.config?.privacyContact;
  return h(
    "section",
    { class: "stack narrow prose" },
    h("h1", null, "Informativa sul trattamento dei dati"),
    !contact && h("p", { class: "notice notice-warn" }, "Bozza: il titolare del trattamento deve completare questa informativa prima dell'apertura al pubblico."),
    h("h2", null, "Titolare del trattamento"),
    h("p", null, contact ?? "[Denominazione, indirizzo e contatti del titolare; eventuale Responsabile della protezione dei dati]"),
    h("h2", null, "Quali dati raccogliamo"),
    h(
      "ul",
      null,
      h("li", null, "Le foto che scatti, con data, ora e posizione GPS del telefono al momento dello scatto."),
      h("li", null, "La categoria e la descrizione che scrivi."),
      h("li", null, "Il recapito, solo se decidi di lasciarlo."),
      h("li", null, "Informazioni tecniche sulla connessione: paese di provenienza e tipo di browser. L'indirizzo IP non viene salvato nella segnalazione."),
      h(
        "li",
        null,
        "Al momento dell'invio, e per l'accesso degli operatori, una verifica anti-abuso di Cloudflare Turnstile tratta l'indirizzo IP e dati tecnici del browser per distinguere le persone dai programmi automatici.",
      ),
    ),
    h("h2", null, "Perché e su quale base"),
    h("p", null, "[Finalità: accertamento e segnalazione alle autorità competenti di violazioni ambientali. Base giuridica, ad es. art. 6.1.e GDPR — compito di interesse pubblico — o altra base individuata dal titolare.]"),
    h("h2", null, "Chi vede i dati"),
    h(
      "p",
      null,
      "Le segnalazioni del pubblico sono prima esaminate da un amministratore. Quelle non pertinenti o con contenuti illeciti vengono cancellate: rimane solo un'impronta numerica che non permette di ricostruire il contenuto. Quelle accettate sono visibili solo al personale autorizzato e possono essere trasmesse alle autorità competenti.",
    ),
    h("h2", null, "Per quanto tempo"),
    h("p", null, "[Periodo di conservazione delle segnalazioni accettate, coerente con i tempi dei procedimenti. Le foto accettate sono conservate in un archivio non modificabile per garantirne il valore probatorio.]"),
    h("h2", null, "Dove"),
    h("p", null, "Segnalazioni e foto sono conservate su infrastruttura Cloudflare con localizzazione nell'Unione Europea. La verifica anti-abuso Turnstile è un servizio globale di Cloudflare."),
    h("h2", null, "I tuoi diritti"),
    h("p", null, "Puoi chiedere accesso, rettifica, cancellazione o limitazione nei limiti previsti dagli artt. 15-22 GDPR, e proporre reclamo al Garante per la protezione dei dati personali. [Modalità di contatto]"),
    h("h2", null, "Cosa non fotografare"),
    h("p", null, "Inquadra il problema, non le persone. Evita volti, documenti e dati personali di terzi quando non sono indispensabili a documentare la violazione."),
  );
}
