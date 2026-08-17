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
const CACHE = "relayone-v13";
const SHELL = [
  "./",
  "index.html",
  "app.html",
  "login.html",
  "register.html",
  "offline.html",
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
    // Force revalidation with the server so a normal reload always gets the
    // latest code (GitHub Pages caches assets ~10 min; without this the browser
    // would serve stale scripts and updates wouldn't show until Ctrl+Shift+R).
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        // Cache good same-origin responses for offline use.
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        // Offline. Serve the last-cached copy of this exact request if we have
        // it; otherwise, for a page navigation, show our branded offline screen
        // (never the browser's raw error page).
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          return (await caches.match("offline.html")) || (await caches.match("index.html"));
        }
        return Response.error();
      })
  );
});

/* ==========================================================================
   Web Push — show notifications when the tab/app is closed, and focus the
   right chat when one is clicked.
   ========================================================================== */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "RelayOne", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "RelayOne";
  const options = {
    body: data.body || "",
    icon: "assets/icons/icon-192.png",
    badge: "assets/icons/icon-192.png",
    tag: data.tag || undefined, // collapse repeat notifications from one chat
    renotify: Boolean(data.tag),
    data: { url: data.url || "app.html", chatId: data.chatId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "app.html", self.registration.scope).href;
  const chatId = event.notification.data?.chatId || null;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an already-open RelayOne tab and tell it which chat to open.
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          if (chatId) client.postMessage({ type: "open-chat", chatId });
          return;
        }
      }
      // Otherwise open a fresh window at the chat.
      await self.clients.openWindow(targetUrl);
    })()
  );
});
