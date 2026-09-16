import { session } from "./api.ts";

type Turnstile = { render(el: HTMLElement, o: Record<string, unknown>): string; execute(id: string): void; remove(id: string): void };

let loaded: Promise<Turnstile> | null = null;

function load(): Promise<Turnstile> {
  loaded ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = () => resolve((window as unknown as { turnstile: Turnstile }).turnstile);
    s.onerror = () => {
      // Let a later attempt try again once the connection is back.
      loaded = null;
      s.remove();
      reject(new Error("verifica anti-spam non caricata: controlla la connessione"));
    };
    document.head.append(s);
  });
  return loaded;
}

/**
 * A fresh single-use Cloudflare Turnstile token, or null when the service has no site key configured. The widget
 * stays invisible unless Cloudflare wants a human to click; tokens expire in minutes, so ask right before sending.
 */
export async function turnstileToken(action: string): Promise<string | null> {
  const siteKey = session.config?.turnstileSiteKey;
  if (!siteKey) return null;
  const ts = await load();
  const holder = document.createElement("div");
  holder.className = "turnstile-holder";
  document.body.append(holder);
  let id: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      id = ts.render(holder, {
        sitekey: siteKey,
        action,
        execution: "execute",
        appearance: "interaction-only",
        language: "it",
        callback: (t: string) => resolve(t),
        "error-callback": () => reject(new Error("verifica anti-spam non superata")),
        "timeout-callback": () => reject(new Error("verifica anti-spam scaduta")),
      });
      ts.execute(id);
    });
  } finally {
    if (id) ts.remove(id);
    holder.remove();
  }
}
