/*
 * Keeps the app working where it is used.
 *
 * A tuning happens in somebody's front room, and front rooms have thick walls
 * and no signal. An app that needs the network to start is an app that does not
 * start, so everything it needs is stored on the phone the first time it loads
 * and served from there afterwards.
 *
 * Served from the cache first and refreshed in the background, rather than the
 * other way round. Network-first would mean waiting out a timeout on every
 * launch in exactly the places this is meant to be used; the cost is that a new
 * version appears on the launch after the one that downloaded it, which for a
 * tool with one user is no cost at all.
 */
const CACHE = "beats-v2";

const SHELL = [
  "./",
  "index.html",
  "app.js",
  "capture.js",
  "dsp.js",
  "listen.js",
  "intervals.js",
  "manifest.json",
  "icon.svg",
  "apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
