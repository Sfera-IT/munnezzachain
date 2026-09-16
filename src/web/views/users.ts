import { h, fmtDate, replace, toast } from "../dom.ts";
import { api, isAdmin, session } from "../api.ts";
import { opsNav, requireOperatorView } from "./ops.ts";

interface User {
  id: string;
  email: string;
  name: string;
  role: "operatore" | "admin";
  active: number;
  must_change_password: number;
  created_at: string;
}

function showPassword(email: string, password: string) {
  const dialog = h(
    "dialog",
    { class: "modal" },
    h("h2", null, "Password provvisoria"),
    h("p", null, `Comunica a ${email} questa password per un canale sicuro. Non verrà mostrata di nuovo; al primo accesso dovrà cambiarla.`),
    h("code", { class: "hash big" }, password),
    h("div", { class: "row end" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => dialog.close() }, "Fatto")),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export async function usersView() {
  if (!requireOperatorView() || !isAdmin()) return h("div");
  const list = h("div", { class: "stack" });

  const load = async () => {
    const { users } = await api<{ users: User[] }>("/utenti");
    replace(
      list,
      users.map((u) =>
        h(
          "div",
          { class: `list-row ${u.active ? "" : "inactive"}` },
          h(
            "div",
            { class: "grow" },
            h("strong", null, u.name),
            " ",
            h("span", { class: "badge badge-neutral" }, u.role),
            !u.active && h("span", { class: "badge badge-bad" }, "disattivato"),
            u.must_change_password === 1 && u.active === 1 && h("span", { class: "badge badge-warn" }, "password provvisoria"),
            h("div", { class: "small muted" }, `${u.email} · creato il ${fmtDate(u.created_at)}`),
          ),
          u.id !== session.me!.id &&
            h(
              "div",
              { class: "col" },
              h(
                "button",
                {
                  class: "btn btn-small",
                  type: "button",
                  onclick: async () => {
                    if (!confirm(`Generare una nuova password provvisoria per ${u.email}?`)) return;
                    const r = await api<{ temporaryPassword: string }>(`/utenti/${u.id}`, { method: "PATCH", json: { resetPassword: true } });
                    showPassword(u.email, r.temporaryPassword);
                    void load();
                  },
                },
                "Reimposta password",
              ),
              h(
                "button",
                {
                  class: "btn-link small",
                  type: "button",
                  onclick: async () => {
                    await api(`/utenti/${u.id}`, { method: "PATCH", json: { active: !u.active } });
                    toast(u.active ? "Utente disattivato" : "Utente riattivato");
                    void load();
                  },
                },
                u.active ? "Disattiva" : "Riattiva",
              ),
            ),
        ),
      ),
    );
  };

  const email = h("input", { type: "email", required: true, placeholder: "email", "aria-label": "Email" });
  const name = h("input", { type: "text", required: true, placeholder: "Nome e cognome", "aria-label": "Nome e cognome" });
  const role = h("select", { "aria-label": "Ruolo" }, h("option", { value: "operatore" }, "Operatore"), h("option", { value: "admin" }, "Amministratore"));
  await load();

  return h(
    "section",
    { class: "stack wide" },
    h("h1", null, "Utenti"),
    opsNav("users"),
    h(
      "form",
      {
        class: "card row wrap",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            const r = await api<{ temporaryPassword: string }>("/utenti", { method: "POST", json: { email: email.value, name: name.value, role: role.value } });
            showPassword(email.value, r.temporaryPassword);
            email.value = "";
            name.value = "";
            void load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        },
      },
      name,
      email,
      role,
      h("button", { class: "btn btn-primary", type: "submit" }, "Crea utente"),
    ),
    h("p", { class: "small muted" }, "Operatore: vede e lavora le segnalazioni accettate, invia segnalazioni con caricamento da galleria. Amministratore: in più modera il pubblico, gestisce utenti e verifica la catena."),
    list,
  );
}
