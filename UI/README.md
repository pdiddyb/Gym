# UI

Vanilla JavaScript Progressive Web App. No build step: these files are served as they are.

- `index.html` entry page
- `styles.css` styling
- `app.js` screens (sign-in, workout list, workout, settings with backup export/import), routing, Google sign-in redirect, one-time move of old device-only workouts into the account
- `firebase.js` Firebase setup: loads the SDK from Google's CDN, Auth, Firestore with offline persistence, and the workout read/write functions
- `service-worker.js` offline cache for the app's own files only; Firebase scripts and API calls are never cached by it (bump `CACHE_NAME` when changing assets)
- `manifest.webmanifest` PWA manifest
- `.htaccess` HTTPS redirect and headers for the cPanel host

Data lives in Firestore under `users/{uid}/`:

- `workouts/{workoutId}` the workouts
- `settings/preferences` weight unit and other choices
- `exercises/{exerciseId}` the exercise library: one entry per exercise that is in any workout,
  with its last and heaviest set. It is worked out from the workouts (and kept up to date as
  sets are saved or deleted), and feeds the "Add exercise" suggestions and the Last/Max line
  on each exercise card.

Sign-in is a full-page redirect to Google and back (no popup, no Firebase helper iframe), so it
works in Safari and in an installed iPhone home-screen app without Firebase Hosting. The address
the app is opened from must be listed as an Authorized redirect URI on the OAuth client; see the
top-level README.

Preview locally: `python -m http.server 8000 --directory UI`, then open `http://localhost:8000`
(use port 8000, it is the one registered for sign-in).
