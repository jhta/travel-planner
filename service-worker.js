'use strict';

const CACHE_NAME = 'tp-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet-polylinedecorator@1.6.0/dist/leaflet.polylineDecorator.min.js',
  'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js',
];

const RUNTIME_BYPASS_HOSTS = [
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'nominatim.openstreetmap.org',
  'en.wikipedia.org',
  'www.wikidata.org',
  'query.wikidata.org',
  'upload.wikimedia.org',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] precache failed', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (RUNTIME_BYPASS_HOSTS.some((h) => url.host === h || url.host.endsWith('.' + h))) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && (url.origin === self.location.origin || SHELL.includes(req.url))) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
