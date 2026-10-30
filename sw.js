// Cache hors ligne : l'appli elle-même, puis les couvertures déjà vues.
const APP = "gestio-app-v5";
const IMG = "gestio-covers-v2";
const IMG_MAX = 150; // nombre de couvertures gardées hors ligne (les plus anciennes sortent)
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // Seulement nos anciens caches : d'autres applis peuvent partager l'adresse github.io.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("gestio-") && ![APP, IMG].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
async function trim(c) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - IMG_MAX; i++) await c.delete(keys[i]);
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error("timeout")), ms))]);
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Couvertures et polices : cache d'abord.
  if (req.destination === "image" || url.host.includes("fonts.g")) {
    e.respondWith(caches.open(IMG).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || (res.type === "opaque" && req.destination === "image")) c.put(req, res.clone()).then(() => trim(c)); // jamais les erreurs ; nombre plafonné car Chrome compte large les images d'autres sites
        return res;
      } catch { return Response.error(); }
    }));
    return;
  }
  // Fichiers de l'appli : réseau d'abord (3 s maximum) pour avoir les mises à jour, cache si hors ligne ou trop lent.
  if (url.origin === location.origin) {
    e.respondWith(withTimeout(fetch(req, { cache: "no-cache" }), 3000)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
  }
});
