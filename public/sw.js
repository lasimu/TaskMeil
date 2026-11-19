// Service worker: makes Taskmeil installable and lets the app shell open
// without a connection. Mail, calendar and task data are never cached here.

const CACHE = "taskmeil-shell-v5";
const SHELL = [
  "/",
  "/styles.css",
  "/config.js",
  "/manifest.webmanifest",
  "/vendor/msal-browser.min.js",
  "/vendor/fonts/inter-tight-latin-wght-normal.woff2",
  "/vendor/fonts/inter-tight-latin-ext-wght-normal.woff2",
  "/js/app.js",
  "/js/auth.js",
  "/js/graph.js",
  "/js/util.js",
  "/js/mail.js",
  "/js/tasks.js",
  "/js/calendar.js",
  "/js/claude.js",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Only our own static files. Sign-in pages always go to the network.
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/auth/")) return;

  // Network first, so a new version is picked up at once; cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
        return cached || (request.mode === "navigate" ? caches.match("/") : Response.error());
      })
  );
});
