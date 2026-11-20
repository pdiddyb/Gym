# Gym

Progressive web app to log gym workouts. Workouts are saved to the signed-in user's Google
account with Firebase (Auth + Firestore) and work offline.

Live at https://gym.pwb-llc.com (static files on cPanel hosting).

## Project structure

- `/UI` - the app: plain HTML/CSS/JavaScript, no build step. Upload the contents of this folder to the web root.
- `firestore.rules` - Firestore security rules (each user can only read and write `users/{their uid}/...`). Published by pasting into the Firebase console, not by uploading to the web host.
- `/tests` - tests for the app's plain logic (lb/kg weight fields). Run `node --test tests/` with Node 22.12 or later; nothing to install. Not uploaded.
- `/SQL` - MySQL scripts left over from the removed PHP API. No longer used.

## Firebase setup

Firebase project `gympwa-3cea6`. The web config and the Google OAuth client ID are in `UI/firebase.js`; both are safe to be public.

- Firebase console > Authentication: Google sign-in enabled.
- Firebase console > Firestore Database > Rules: contents of `firestore.rules`, published.
- Google Cloud console > APIs & Services > Credentials > the "Web client" OAuth client > Authorized redirect URIs must include every address the app is opened from, with the trailing slash:
  - `https://gym.pwb-llc.com/`
  - `http://localhost:8000/` (local preview)
