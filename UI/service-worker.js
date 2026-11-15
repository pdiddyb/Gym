const CACHE_NAME = 'gym-pwa-v4';

// Only the app's own files listed here are ever cached or served from the cache.
// Everything else is left to the browser and goes to the network untouched: the Firebase
// SDK scripts on www.gstatic.com, and all Firebase Auth, Firestore and Google sign-in calls.
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
];
const PRECACHE_PATHS = new Set(ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  // Not calling respondWith() means the service worker stays out of the way entirely.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return; // Firebase CDN scripts and every Firebase/Google API call.
  }
  if (!PRECACHE_PATHS.has(requestUrl.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
