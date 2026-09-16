type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function replace(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "medium" }) : "—";

export const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function hashBlock(label: string, value: string) {
  const code = h("code", { class: "hash" }, value);
  return h(
    "div",
    { class: "hash-row" },
    h("span", { class: "hash-label" }, label),
    code,
    h(
      "button",
      {
        class: "btn-link small",
        type: "button",
        onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          try {
            await navigator.clipboard.writeText(value);
            b.textContent = "Copiato";
          } catch {
            getSelection()?.selectAllChildren(code);
            b.textContent = "Selezionato";
          }
          setTimeout(() => (b.textContent = "Copia"), 1500);
        },
      },
      "Copia",
    ),
  );
}

export function toast(message: string, kind: "ok" | "error" = "ok") {
  const el = h("div", { class: `toast toast-${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add("out"), 3500);
  setTimeout(() => el.remove(), 4000);
}

export function download(filename: string, content: BlobPart, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
