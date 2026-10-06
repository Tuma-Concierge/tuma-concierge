const STATIC_CACHE = "tuma-admin-static-rollback-sep20-v3";
const RUNTIME_CACHE = "tuma-admin-runtime-rollback-sep20-v3";
const OFFLINE_URL = "/offline.html";
const STATIC_ASSETS = ["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// A logged-out admin's cached responses shouldn't leak to whoever logs in
// next on the same device — the app asks for this on every logout (see
// lib/auth-context.tsx).
self.addEventListener("message", (event) => {
  if (event.data === "clear-runtime-cache") {
    event.waitUntil(caches.delete(RUNTIME_CACHE));
  }
});

// Next.js build output under /_next/static/ is content-hashed — the same
// URL never changes, so it's safe to cache forever. This is the single
// biggest saving on a repeat visit: zero JS/CSS re-downloaded.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/") || STATIC_ASSETS.includes(url.pathname);
}

// Media that never changes once it exists — a rider's profile photo or ID
// document, a customer's photo. Cache-first: view it once, never pay for
// it again.
function isImmutableApiMedia(url) {
  return (
    /^\/v1\/(users|riders)\/[^/]+\/photo$/.test(url.pathname) ||
    /^\/v1\/admin\/riders\/[^/]+\/id-document$/.test(url.pathname)
  );
}

function isApiGet(url) {
  return url.pathname.startsWith("/v1/");
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Serves the last-known response instantly, while a fresh copy is fetched
// in the background to update the cache for next time — a screen may be a
// few seconds out of date, never blank.
async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        caches.open(cacheName).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const network = await networkPromise;
  return network || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // A mutation (POST/PUT/DELETE) always goes straight to the network,
  // exactly as before. Only reads are ever served from a cache.
  if (request.method !== "GET") return;

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (isImmutableApiMedia(url)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  if (isApiGet(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }

  // A page navigation — try the network first, and only fall back to a
  // cached copy or the offline page when there truly isn't one.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        return cached || (await caches.match(OFFLINE_URL));
      }),
    );
  }
});
