const STATIC_CACHE = "tuma-static-rollback-sep20-v3";
const RUNTIME_CACHE = "tuma-runtime-rollback-sep20-v3";
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

// A logged-out user's cached responses shouldn't leak to whoever logs in
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

// Media that never changes once it exists — a sent chat photo/voice note,
// a profile photo. Cache-first: view it once, never pay for it again.
function isImmutableApiMedia(url) {
  return /^\/v1\/chat\/media\//.test(url.pathname) || /^\/v1\/(users|riders)\/[^/]+\/photo$/.test(url.pathname);
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

// Serves the last-known response instantly (so a page renders real data
// the moment it opens, even on a slow or dead connection), while a fresh
// copy is fetched in the background to update the cache for next time —
// the standard "stale while revalidate" tradeoff: a screen may be a few
// seconds out of date, never blank.
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

  // A mutation (POST/PUT/DELETE — funding an order, sending a message,
  // claiming a job) always goes straight to the network, exactly as
  // before. Only reads are ever served from a cache.
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

  // A page navigation — try the network first (so a signed-in user always
  // sees the real, current page when there's connectivity), and only fall
  // back to a cached copy or the offline page when there truly isn't one,
  // so a dead connection shows Tuma's own offline screen instead of the
  // browser's generic error page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        return cached || (await caches.match(OFFLINE_URL));
      }),
    );
  }
});

// A push arrives as an opaque encrypted blob the browser has already
// decrypted for us by the time this fires — showNotification() is what
// actually produces the popup + system notification sound on the phone.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to the defaults below.
  }
  const title = data.title || "Tuma";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "You have a new message",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "tuma-chat",
      data: { url: data.url || "/" },
    }),
  );
});

// Tapping the notification should land on the actual conversation, reusing
// an already-open tab rather than stacking a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          if ("navigate" in client) {
            try {
              await client.navigate(targetUrl);
            } catch {
              // Some browsers refuse cross-origin navigate; focusing is still useful.
            }
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })(),
  );
});
