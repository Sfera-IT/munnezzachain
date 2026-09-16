/// <reference lib="webworker" />
// Built with a fresh VERSION on every build, so each deploy is a byte-different service worker.

declare const __APP_VERSION__: string;
declare const __PRECACHE__: string[];

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `munnezzachain-${__APP_VERSION__}`;

sw.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(__PRECACHE__)));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("munnezzachain-") && key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  if ((event.data as { type?: string })?.type === "SKIP_WAITING") void sw.skipWaiting();
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // Evidence and sessions never touch the cache.
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match("/index.html", { cacheName: CACHE })) ?? Response.error()),
    );
    return;
  }
  // Hashed build assets and icons: this version's cache first.
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then((hit) => hit ?? fetch(req)),
  );
});
