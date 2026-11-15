const CACHE_NAME = 'gym-pwa-v9';

// The app's own files. Served from the cache straight away and refreshed in the background.
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

// The Firebase SDK scripts, so the app still starts with no signal. These URLs contain the
// version and their contents never change, so a cached copy is always correct.
// Keep this list identical to the imports at the top of firebase.js (and bump CACHE_NAME
// when the version changes).
const FIREBASE_SDK = new Set([
  'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js',
]);

// Nothing else is ever cached or answered by this service worker. In particular every
// Firebase Auth, Firestore and Google sign-in request goes to the network untouched.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all([
        cache.addAll(ASSETS),
        // Best effort: if Google's CDN can't be reached right now, the scripts are cached
        // the first time the page loads them instead.
        cache.addAll([...FIREBASE_SDK]).catch(() => {}),
      ])
    )
  );
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

function storeInCache(request, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  // Not calling respondWith() means the service worker stays out of the way entirely.
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  // Firebase SDK scripts: cached copy if there is one, otherwise fetch and keep it.
  if (FIREBASE_SDK.has(requestUrl.href)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => storeInCache(event.request, response)))
    );
    return;
  }

  // Any other site (all Firebase and Google API calls), or a path that isn't an app file.
  if (requestUrl.origin !== self.location.origin || !PRECACHE_PATHS.has(requestUrl.pathname)) {
    return;
  }

  // App files: cached copy now, fresh copy fetched in the background for next time.
  // Looked up and stored by path alone, so "/?anything" reuses the one entry for "/".
  const cacheKey = requestUrl.origin + requestUrl.pathname;
  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => storeInCache(cacheKey, response))
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
