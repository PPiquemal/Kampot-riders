const CACHE_VERSION = "kr-v7";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const TILE_CACHE = `${CACHE_VERSION}-osm-tiles`;
const TILE_CACHE_LIMIT = 250;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./map.js",
  "./gps.js",
  "./storage.js",
  "./gpx.js",
  "./manifest.webmanifest",
  "./assets/logo.svg",
  "./assets/icon-192.svg",
  "./assets/icon-512.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Noto+Sans+Khmer:wght@400;700&display=swap"
];

function isOsmTileRequest(url) {
  return url.origin === "https://tile.openstreetmap.org"
    || url.origin === "https://a.tile.openstreetmap.org"
    || url.origin === "https://b.tile.openstreetmap.org"
    || url.origin === "https://c.tile.openstreetmap.org"
    || url.origin === "https://tile-cyclosm.openstreetmap.fr";
}

function isGoogleTileRequest(url) {
  return url.origin === "https://tile.googleapis.com";
}

function isStaticRequest(requestUrl) {
  return APP_SHELL.includes(requestUrl)
    || requestUrl.includes("unpkg.com/leaflet")
    || requestUrl.includes("fonts.googleapis.com")
    || requestUrl.includes("fonts.gstatic.com");
}

async function pruneCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key !== STATIC_CACHE && key !== TILE_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (isGoogleTileRequest(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isOsmTileRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            cache.put(event.request, response.clone());
            pruneCache(TILE_CACHE, TILE_CACHE_LIMIT);
          }
          return response;
        })
        .catch(() => cached || new Response("", { status: 503, statusText: "Tile unavailable" }));
      return cached || networkFetch;
    })());
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(caches.match("./index.html").then(cached => cached || fetch(event.request)));
    return;
  }

  if (isStaticRequest(url.href) || url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return cached || new Response("", { status: 503, statusText: "Asset unavailable" });
      }
    })());
  }
});
