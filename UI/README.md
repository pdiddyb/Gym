# UI

Vanilla JavaScript Progressive Web App. No build step: these files are served as they are.

- `index.html` entry page
- `styles.css` styling
- `app.js` screens (sign-in, home, history, workout, workout completed, exercise data, settings with the default rest length, outlines and backup export/import), the header (one dropdown menu component for the ⋮ and profile buttons; the gear opens Settings and closes it again), the rest timer, routing, Google sign-in redirect, one-time move of old device-only workouts into the account
- `units.js` lb/kg conversion, and the weight field logic for the add-set row: the field keeps the
  weight as typed (or as pre-filled from the previous set) with its unit, and shows it converted
  from that on every unit switch, so switching back and forth never changes the number. Tested
  by `/tests` at the top of the repo.
- `firebase.js` Firebase setup: loads the SDK from Google's CDN, Auth, Firestore with offline persistence, and the workout read/write functions
- `service-worker.js` offline cache for the app's own files only; Firebase scripts and API calls are never cached by it (bump `CACHE_NAME` when changing assets). It always asks the server for the app's files (`cache: 'no-cache'`, a quick "not modified" when unchanged) instead of taking the browser's stored copy, so an upload shows on the second launch after it. Tested by `/tests`.
- `manifest.webmanifest` PWA manifest
- `.htaccess` HTTPS redirect and headers for the cPanel host, including `Cache-Control: no-cache` on HTML, JS, CSS and the manifest (the host's default lets browsers keep JS and CSS for a week)

Data lives in Firestore under `users/{uid}/`:

- `workouts/{workoutId}` the workouts. Each has `startedAt` and `finishedAt` (null while in
  progress); the timer and total time come from those. Workouts are labelled by their start date
  and time; ones made when workouts had titles keep a `name` and show it. Each set is
  `{ id, weight, unit, reps, at }`, where `at` is when it was logged (sets saved before that was
  recorded have none and count as logged when their workout started). A workout in progress
  that has had a rest has `restEndsAt` (when the rest ends, ms) and `restExercise` (the name of
  the exercise it follows); see Rest timer below.
- `outlines/{outlineId}` saved outlines: `{ name, createdAt, exercises: [{ name, sets }] }`, the
  exercise names and set counts of a finished workout, with no weights. A workout can be started
  from one.
- `settings/preferences` weight unit and other choices, including `restSeconds`, the default rest
  timer length (2:00 until changed)
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
  - `rest: { on, seconds }`: the exercise's rest timer, each field written only once the user
    changes it. No `on` means on; no `seconds` means the default from settings.

  None of this changes the workouts themselves.

## Rest timer

Logging a set of an exercise whose rest timer is on starts a rest (or starts it again), saved as
`restEndsAt` on the workout. The countdown is always worked out from that time, so it survives
closing the app, a locked phone and having no signal. While resting, the clock at the top of the
workout reads "REST 02:29" with -15s, +15s and Skip, pinned under the header. When the rest ends
with the app open there is a banner that says "Rest over", a short beep (Web Audio, only once the user has
tapped something, as browsers require) and a vibration where supported (not on iPhone). A rest
that ended while the app was in the background still gets the alert on coming back within a
minute.

For push notifications later: `onRestScheduled(endsAt, exerciseName)` in `app.js` is called when a
rest starts or its end moves on this device, and `onRestCancelled()` when it is skipped or the
workout is finished or deleted. Both are empty for now. The notification should say just
"Rest over", like the banner.

Sign-in is a full-page redirect to Google and back (no popup, no Firebase helper iframe), so it
works in Safari and in an installed iPhone home-screen app without Firebase Hosting. The address
the app is opened from must be listed as an Authorized redirect URI on the OAuth client; see the
top-level README.

Preview locally: `python -m http.server 8000 --directory UI`, then open `http://localhost:8000`
(use port 8000, it is the one registered for sign-in).
