import { api, ApiError, isOperator } from "./api.ts";
import { turnstileToken } from "./turnstile.ts";
import { outbox, receipts, type OutboxItem, type StoredReceipt } from "./store.ts";

export type SendResult = { ok: true; receipt: StoredReceipt } | { ok: false; retryable: boolean; message: string };

let flushing: Promise<void> | null = null;

export async function send(item: OutboxItem): Promise<SendResult> {
  // Anything not sent on the first try is flagged as queued, so reviewers know capture and upload were apart.
  const meta = { ...item.meta, queued: item.meta.queued || item.attempts > 0 || !navigator.onLine };
  // The server asks for it from anyone who is not an active operator, including a user still on a temporary password.
  if (!isOperator()) {
    try {
      const token = await turnstileToken("segnalazione");
      if (token) meta.turnstileToken = token;
    } catch (e) {
      // A widget that did not load (weak signal) or a failed challenge: the report stays queued for another try.
      return fail(item, true, (e as Error).message);
    }
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
    const retryable = err.status === 0 || err.status === 429 || err.status >= 500 || err.code === "turnstile";
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
