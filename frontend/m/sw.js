// Service worker of the mobile app: keeps the app shell so it opens fast and offline.
// Data (/api/m/*) is never cached: it is private and must be fresh.
const CACHE = "pv-m-shell-1";
const SHELL = ["./", "m.css", "m.js", "mock.js", "manifest.webmanifest", "icon.svg", "../i18n.js", "../lang/en.js",
  "../vendor/leaflet/leaflet.css", "../vendor/leaflet/leaflet.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first (fresh after an update), the cached copy when the network is down.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match("./"))));
});
