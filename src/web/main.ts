import "./style.css";
import { h, toast } from "./dom.ts";
import { refreshSession, session, onServerVersion } from "./api.ts";
import { route, startRouter, render } from "./router.ts";
import { flushOutbox } from "./sender.ts";
import { appState } from "./app-state.ts";
import { homeView } from "./views/home.ts";
import { newReportView } from "./views/new-report.ts";
import { mineView } from "./views/mine.ts";
import { receiptView } from "./views/receipt.ts";
import { verifyView } from "./views/verify.ts";
import { loginView, passwordView } from "./views/login.ts";
import { opsListView, chainView } from "./views/ops.ts";
import { opsReportView } from "./views/ops-report.ts";
import { usersView } from "./views/users.ts";
import { privacyView } from "./views/privacy.ts";

route("/", homeView);
route("/segnala", newReportView);
route("/mie", mineView);
route("/ricevuta/:id", receiptView);
route("/verifica", verifyView);
route("/accesso", loginView);
route("/password", passwordView);
route("/privacy", privacyView);
route("/operatori", () => opsListView("list"));
route("/operatori/moderazione", () => opsListView("moderation"));
route("/operatori/segnalazione/:id", opsReportView);
route("/operatori/utenti", usersView);
route("/operatori/catena", chainView);

// ---------------------------------------------------------------------------------------------
// Updates. Every build ships a sw.js with a new version string, so the browser always sees a changed
// service worker. The new one waits; we swap it in when nothing is being composed, or on request.

let waiting: ServiceWorker | null = null;
const banner = h(
  "div",
  { class: "update-banner", role: "status", hidden: true },
  h("span", null, "È disponibile una nuova versione dell'app."),
  h("button", { class: "btn btn-small btn-light", type: "button", onclick: () => applyUpdate(true) }, "Aggiorna"),
);

function applyUpdate(userRequested: boolean) {
  if (!waiting) return;
  if (appState.busy && !userRequested) return;
  if (appState.busy && !confirm("Hai foto non ancora inviate su questa pagina. Aggiornando andranno perse. Continuare?")) return;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

function offerUpdate(sw: ServiceWorker) {
  waiting = sw;
  banner.hidden = false;
  // Nothing in progress and the app is in the background: update silently.
  if (!appState.busy && document.visibilityState === "hidden") applyUpdate(false);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const sw = reg.installing;
    sw?.addEventListener("statechange", () => {
      if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(sw);
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const check = () => void reg.update().catch(() => undefined);
  setInterval(check, 30 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
    else if (waiting) applyUpdate(false);
  });
  // The API reports the deployed version: a mismatch means a deploy happened since this page loaded.
  onServerVersion((v) => {
    if (v !== __APP_VERSION__) check();
  });
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const outlet = document.getElementById("app")!;
  const header = document.getElementById("header-user")!;
  document.body.append(banner);
  await refreshSession();
  const paintHeader = () => {
    header.replaceChildren(session.me ? h("a", { href: "#/operatori", class: "header-link" }, session.me.name) : h("a", { href: "#/accesso", class: "header-link" }, "Operatori"));
  };
  paintHeader();
  window.addEventListener("hashchange", paintHeader);
  startRouter(outlet);

  const offline = document.getElementById("offline")!;
  const net = () => {
    offline.hidden = navigator.onLine;
    if (navigator.onLine) void flushOutbox();
  };
  window.addEventListener("online", net);
  window.addEventListener("offline", net);
  net();

  window.addEventListener("outbox-changed", () => {
    if (location.hash === "#/" || location.hash === "") void render();
  });

  registerServiceWorker().catch((e) => console.warn("service worker", e));
  document.getElementById("version")!.textContent = `versione ${__APP_VERSION__}`;
}

main().catch((e) => toast((e as Error).message, "error"));
