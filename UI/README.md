# UI

Vanilla JavaScript Progressive Web App. No build step: these files are served as they are.

- `index.html` entry page
- `styles.css` styling
- `app.js` screens (sign-in, home, history, workout, workout completed, exercise data, settings with outlines and backup export/import), the header (one dropdown menu component for the ⋮ and profile buttons; the gear opens Settings and closes it again), routing, Google sign-in redirect, one-time move of old device-only workouts into the account
- `firebase.js` Firebase setup: loads the SDK from Google's CDN, Auth, Firestore with offline persistence, and the workout read/write functions
- `service-worker.js` offline cache for the app's own files only; Firebase scripts and API calls are never cached by it (bump `CACHE_NAME` when changing assets)
- `manifest.webmanifest` PWA manifest
- `.htaccess` HTTPS redirect and headers for the cPanel host

Data lives in Firestore under `users/{uid}/`:

- `workouts/{workoutId}` the workouts. Each has `startedAt` and `finishedAt` (null while in
  progress); the timer and total time come from those. Workouts are labelled by their start date
  and time; ones made when workouts had titles keep a `name` and show it. Each set is
  `{ id, weight, unit, reps, at }`, where `at` is when it was logged (sets saved before that was
  recorded have none and count as logged when their workout started).
- `outlines/{outlineId}` saved outlines: `{ name, createdAt, exercises: [{ name, sets }] }`, the
  exercise names and set counts of a finished workout, with no weights. A workout can be started
  from one.
- `settings/preferences` weight unit and other choices
- `exercises/{exerciseId}` the exercise library: one entry per exercise that is in any workout,
  with its last and heaviest set. It is worked out from the workouts (and kept up to date as
  sets are saved or deleted), and feeds the "Add exercise" suggestions, the Last/Max line on
  each exercise card and the Exercise data screen. Hand edits made there are kept in two
  fields that the automatic updates and the one-time rebuild never write:
  - `manual: { max, last }`, each `{ at, set }` (or null when not edited): an edited Max or Last
    set, or `set: null` for a cleared one, made at time `at`. Only sets logged after `at` count
    towards that stat: a better set replaces an edited Max, the next set replaces an edited
    Last. The record built from an edited set has `edited: true`. An exercise taken out of
    every workout keeps its entry while it has an edited set.
  - `hidden: true`: removed from the suggestions and the Exercise data list until the exercise
    is used in a workout again.

  None of this changes the workouts themselves.

Sign-in is a full-page redirect to Google and back (no popup, no Firebase helper iframe), so it
works in Safari and in an installed iPhone home-screen app without Firebase Hosting. The address
the app is opened from must be listed as an Authorized redirect URI on the OAuth client; see the
top-level README.

Preview locally: `python -m http.server 8000 --directory UI`, then open `http://localhost:8000`
(use port 8000, it is the one registered for sign-in).
