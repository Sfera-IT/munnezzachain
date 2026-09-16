// IndexedDB: the outbox of reports not yet accepted by the server, and the receipts of those that were.
// Photos stay on the device until the server has confirmed their hashes.

import type { SubmitMeta } from "../shared/model.ts";

export interface OutboxItem {
  clientReportId: string;
  meta: SubmitMeta;
  photos: Blob[];
  thumbs: Blob[];
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** A 4xx answer: retrying the same bytes cannot succeed. */
  rejected?: boolean;
}

export interface StoredReceipt {
  reportId: string;
  receivedAt: string;
  moderation: "in_attesa" | "accettata";
  seq: number;
  prevHash: string;
  entryHash: string;
  manifestSha256: string;
  photos: { index: number; sha256: string; flags: string[] }[];
  tsaStatus: string;
  category: string;
  description: string;
  thumb?: Blob;
}

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("munnezzachain", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("outbox", { keyPath: "clientReportId" });
      req.result.createObjectStore("receipts", { keyPath: "reportId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transazione annullata"));
  });
}

export const outbox = {
  put: (item: OutboxItem) => run("outbox", "readwrite", (s) => s.put(item)),
  get: (id: string) => run<OutboxItem | undefined>("outbox", "readonly", (s) => s.get(id)),
  all: () => run<OutboxItem[]>("outbox", "readonly", (s) => s.getAll()),
  delete: (id: string) => run("outbox", "readwrite", (s) => s.delete(id)),
};

export const receipts = {
  put: (r: StoredReceipt) => run("receipts", "readwrite", (s) => s.put(r)),
  get: (id: string) => run<StoredReceipt | undefined>("receipts", "readonly", (s) => s.get(id)),
  all: async () => (await run<StoredReceipt[]>("receipts", "readonly", (s) => s.getAll())).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
};

/** Asks the browser not to evict the outbox under storage pressure. */
export async function persistStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* best effort */
  }
}
