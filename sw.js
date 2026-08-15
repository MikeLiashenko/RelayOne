/**
 * RelayOne service worker.
 *
 * Strategy: network-first for same-origin GET requests, falling back to cache
 * when offline. Network-first (not cache-first) matters here because the app's
 * JS/CSS filenames aren't content-hashed — a cache-first worker would pin users
 * to stale code after a deploy. The cache exists only so the shell still opens
 * offline.
 *
 * Cross-origin requests (the API on onrender.com, Google Fonts) are left
 * untouched — they always go straight to the network. Non-GET requests
 * (messages, uploads) are never cached.
 */
const CACHE = "relayone-v1";
const SHELL = [
  "./",
  "index.html",
  "app.html",
  "login.html",
  "register.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache mutations
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API + fonts: network only

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache good same-origin responses for offline use.
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((cached) => cached || caches.match("index.html"))
      )
  );
});
