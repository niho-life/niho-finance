/*
 * The Service Worker of the home-screen app (10 §1.1). It never caches the books: Cache Storage
 * holds 接続がない画面 (`/offline.html`) and nothing else. Only GET page navigations are handled;
 * they always go to the network (with navigation preload), and only a failed connection is
 * answered with `/offline.html`. HTTP errors and IAP's 302 (an opaque redirect) reach the browser
 * as they are. Requests that are not navigations (fetch(), Server Actions, RSC, API calls, images
 * and other static files) are not touched. A file opened as a page (an evidence file in a new tab,
 * an export) is a navigation too and passes through the same way; with navigation preload it is
 * still requested once. Registered by components/pwa/pwa-lifecycle.tsx.
 */

const CACHE_NAME = "niho-finance-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `reload`: the current file, not a copy in the HTTP cache.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Older versions' caches (and anything else) go.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

async function navigate(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    // No connection (fetch rejects only then): the page cannot be read.
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
    return offline ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(navigate(event));
});
