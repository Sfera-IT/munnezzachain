import { h } from "../dom.ts";
import { api, refreshSession, session, type Me } from "../api.ts";
import { navigate } from "../router.ts";
import { turnstileToken } from "../turnstile.ts";

export function loginView() {
  const email = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", spellcheck: false, required: true });
  const password = h("input", { type: "password", autocomplete: "current-password", required: true });
  const error = h("div", { class: "form-error", role: "alert" });
  const btn = h("button", { class: "btn btn-primary", type: "submit" }, "Accedi");
  return h(
    "section",
    { class: "narrow stack" },
    h("h1", null, "Area operatori"),
    h(
      "form",
      {
        class: "card stack",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = "";
          btn.disabled = true;
          try {
            const token = await turnstileToken("login");
            const { user } = await api<{ user: Me }>("/auth/login", { method: "POST", json: { email: email.value, password: password.value, turnstileToken: token ?? undefined } });
            await refreshSession();
            navigate(user.mustChangePassword ? "#/password" : "#/operatori");
          } catch (err) {
            error.textContent = (err as Error).message;
          } finally {
            btn.disabled = false;
          }
        },
      },
      h("label", { class: "field" }, h("span", null, "Email o nome utente"), email),
      h("label", { class: "field" }, h("span", null, "Password"), password),
      error,
      btn,
    ),
    h("p", { class: "small muted" }, "Gli account sono creati dall'amministratore. Chi vuole solo segnalare non ha bisogno di accedere."),
  );
}

export function passwordView() {
  if (!session.me) {
    navigate("#/accesso");
    return h("div");
  }
  const current = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: 12, required: true });
  const again = h("input", { type: "password", autocomplete: "new-password", required: true });
  const error = h("div", { class: "form-error", role: "alert" });
  return h(
    "section",
    { class: "narrow stack" },
    h("h1", null, "Cambia password"),
    session.me.mustChangePassword && h("p", { class: "notice notice-warn" }, "Stai usando una password provvisoria. Scegline una tua per continuare."),
    h(
      "form",
      {
        class: "card stack",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = "";
          if (next.value !== again.value) {
            error.textContent = "Le due password non coincidono";
            return;
          }
          try {
            await api("/auth/password", { method: "POST", json: { current: current.value, next: next.value } });
            await refreshSession();
            navigate("#/operatori");
          } catch (err) {
            error.textContent = (err as Error).message;
          }
        },
      },
      h("label", { class: "field" }, h("span", null, "Password attuale"), current),
      h("label", { class: "field" }, h("span", null, "Nuova password (almeno 12 caratteri)"), next),
      h("label", { class: "field" }, h("span", null, "Ripeti la nuova password"), again),
      error,
      h("button", { class: "btn btn-primary", type: "submit" }, "Salva"),
    ),
  );
}
