# UI

Vanilla JavaScript Progressive Web App shell.

- `index.html` entry page
- `styles.css` styling
- `app.js` workout logging (stored in IndexedDB on the device), routing and install prompt handling
- `service-worker.js` offline cache (bump `CACHE_NAME` when changing assets)
- `manifest.webmanifest` PWA manifest

Preview locally: `python -m http.server 8000 --directory UI`, then open `http://localhost:8000`.
