const CACHE_NAME = 'gym-pwa-v1';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest'];
const PRECACHE_PATHS = new Set(ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || !PRECACHE_PATHS.has(requestUrl.pathname)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
