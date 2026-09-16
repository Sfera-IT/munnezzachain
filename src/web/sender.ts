import { api, ApiError, session } from "./api.ts";
import { outbox, receipts, type OutboxItem, type StoredReceipt } from "./store.ts";

let turnstileLoaded: Promise<void> | null = null;

async function turnstileToken(siteKey: string): Promise<string> {
  type TS = { render(el: HTMLElement, o: Record<string, unknown>): string; execute(id: string): void; remove(id: string): void };
  turnstileLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("verifica anti-spam non caricata"));
    document.head.append(s);
  });
  await turnstileLoaded;
  const ts = (window as unknown as { turnstile: TS }).turnstile;
  const holder = document.createElement("div");
  holder.className = "turnstile-holder";
  document.body.append(holder);
  try {
    return await new Promise<string>((resolve, reject) => {
      const id = ts.render(holder, {
        sitekey: siteKey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (t: string) => resolve(t),
        "error-callback": () => reject(new Error("verifica anti-spam non superata")),
      });
      ts.execute(id);
    });
  } finally {
    holder.remove();
  }
}

export type SendResult = { ok: true; receipt: StoredReceipt } | { ok: false; retryable: boolean; message: string };

let flushing: Promise<void> | null = null;

export async function send(item: OutboxItem): Promise<SendResult> {
  // Anything not sent on the first try is flagged as queued, so reviewers know capture and upload were apart.
  const meta = { ...item.meta, queued: item.meta.queued || item.attempts > 0 || !navigator.onLine };
  try {
    if (session.config?.turnstileSiteKey && !session.me) meta.turnstileToken = await turnstileToken(session.config.turnstileSiteKey);
  } catch (e) {
    return fail(item, false, (e as Error).message);
  }
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  item.photos.forEach((p, i) => form.set(`photo_${i}`, p, `foto-${i + 1}.jpg`));
  try {
    const r = await api<Omit<StoredReceipt, "category" | "description" | "thumb">>("/segnalazioni", { method: "POST", body: form });
    const receipt: StoredReceipt = { ...r, category: item.meta.category, description: item.meta.description, thumb: item.thumbs[0] };
    await receipts.put(receipt);
    await outbox.delete(item.clientReportId);
    return { ok: true, receipt };
  } catch (e) {
    const err = e as ApiError;
    const retryable = err.status === 0 || err.status === 429 || err.status >= 500;
    return fail(item, retryable, err.message);
  }
}

async function fail(item: OutboxItem, retryable: boolean, message: string): Promise<SendResult> {
  await outbox.put({ ...item, attempts: item.attempts + 1, lastError: message, rejected: !retryable });
  return { ok: false, retryable, message };
}

/** Sends everything still waiting that can plausibly succeed. Safe to call repeatedly. */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  // The flag is cleared in a .finally attached after assignment: clearing it inside the async body would run
  // synchronously on an early return and leave a stale promise that blocks every later flush.
  flushing = (async () => {
    if (!navigator.onLine) return;
    for (const item of await outbox.all()) {
      if (item.rejected) continue;
      const r = await send(item);
      if (!r.ok && r.retryable) break;
    }
  })().finally(() => {
    flushing = null;
    window.dispatchEvent(new Event("outbox-changed"));
  });
  return flushing;
}
