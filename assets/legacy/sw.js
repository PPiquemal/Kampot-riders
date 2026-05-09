// sw.js — Kampot Riders PWA — updated: 2026-04-21 (iOS GPS fix)
const CACHE_VERSION = 'kr-v3';
const STATIC_CACHE = CACHE_VERSION + '-static';
const TILES_CACHE = CACHE_VERSION + '-tiles';

const STATIC_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Noto+Sans+Khmer:wght@400;700&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Map tiles — cache-first with network fallback, long TTL
  if (url.includes('tile-cyclosm') || url.includes('openstreetmap') || url.includes('tile.')) {
    e.respondWith(
      caches.open(TILES_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }
  // Static assets (Leaflet, fonts) — cache-first
  if (STATIC_ASSETS.some(a => url.startsWith(a)) || url.includes('fonts.g') || url.includes('unpkg.com')) {
    e.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
        })
      )
    );
    return;
  }
  // Default — network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
