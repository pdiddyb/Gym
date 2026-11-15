// Firebase wiring: Google sign-in (Auth) and per-user storage (Firestore) for workouts,
// settings, outlines and the exercise library.
// The SDK is loaded straight from Google's CDN; there is no build step.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithCredential,
  signOut,
  GoogleAuthProvider,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  getDocsFromServer,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

// Safe to publish: these identify the project, they don't grant access.
// Access is controlled by firestore.rules.
const firebaseConfig = {
  apiKey: 'AIzaSyAQ95KVkNTn0aKpc9XQbs4CZ6KQ7ImEQ8Q',
  authDomain: 'gympwa-3cea6.firebaseapp.com',
  projectId: 'gympwa-3cea6',
  storageBucket: 'gympwa-3cea6.firebasestorage.app',
  messagingSenderId: '376769333504',
  appId: '1:376769333504:web:1a880a2a99550d4b388be5',
};

// The project's "Web client" OAuth ID (Google Cloud console > APIs & Services > Credentials).
// app.js sends the browser to Google with this ID and gets a Google ID token back.
export const GOOGLE_CLIENT_ID = '376769333504-6jfr1d8op2k5lnktld3ushj914olj3np.apps.googleusercontent.com';

const app = initializeApp(firebaseConfig);

// initializeAuth without a popup/redirect resolver: sign-in is done with a Google ID token
// (see app.js), so Firebase never needs its cross-site helper iframe on firebaseapp.com.
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
});

// Offline persistence: reads come from an on-device cache and writes queue up until
// there is a connection again.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const workoutsOf = (uid) => collection(db, 'users', uid, 'workouts');
const workoutRef = (uid, id) => doc(db, 'users', uid, 'workouts', id);
const withoutId = ({ id, ...data }) => data;

// ---------- Auth ----------

export function watchUser(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signInWithGoogleIdToken(idToken) {
  return signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

export function signOutUser() {
  return signOut(auth);
}

// ---------- Workouts: users/{uid}/workouts/{workoutId} ----------

// Calls onData with the full list now and again after every change, on this device or another.
// Works offline from the cache.
export function watchWorkouts(uid, onData, onError) {
  return onSnapshot(
    workoutsOf(uid),
    (snapshot) => onData(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))),
    onError
  );
}

// The promises below resolve only once the server has accepted the write, which can be much
// later when offline. The change is applied on the device straight away, so callers should
// not wait on them before updating the screen.
export function saveWorkout(uid, workout) {
  return setDoc(workoutRef(uid, workout.id), withoutId(workout));
}

export function deleteWorkout(uid, id) {
  return deleteDoc(workoutRef(uid, id));
}

export function saveWorkouts(uid, workouts) {
  const commits = [];
  for (let start = 0; start < workouts.length; start += 400) {
    const batch = writeBatch(db);
    workouts.slice(start, start + 400).forEach((workout) => batch.set(workoutRef(uid, workout.id), withoutId(workout)));
    commits.push(batch.commit());
  }
  return Promise.all(commits);
}

// ---------- Settings: users/{uid}/settings/preferences ----------

const settingsRef = (uid) => doc(db, 'users', uid, 'settings', 'preferences');

// Calls onData with the saved settings ({} if none yet) now and after every change.
export function watchSettings(uid, onData, onError) {
  return onSnapshot(settingsRef(uid), (snapshot) => onData(snapshot.exists() ? snapshot.data() : {}), onError);
}

// Merges the given fields into the saved settings. Like the workout writes, the promise
// resolves only when the server has accepted it.
export function saveSettings(uid, changes) {
  return setDoc(settingsRef(uid), changes, { merge: true });
}

// Ids of the workouts the server has for this user. Rejects when offline.
export async function serverWorkoutIds(uid) {
  const snapshot = await getDocsFromServer(workoutsOf(uid));
  return new Set(snapshot.docs.map((item) => item.id));
}

// Every workout the server has for this user. Rejects when offline.
export async function serverWorkouts(uid) {
  const snapshot = await getDocsFromServer(workoutsOf(uid));
  return snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
}

// ---------- Outlines: users/{uid}/outlines/{outlineId} ----------

const outlineRef = (uid, id) => doc(db, 'users', uid, 'outlines', id);

// Calls onData with every outline now and again after every change. Works offline.
export function watchOutlines(uid, onData, onError) {
  return onSnapshot(
    collection(db, 'users', uid, 'outlines'),
    (snapshot) => onData(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))),
    onError
  );
}

export function saveOutline(uid, outline) {
  return setDoc(outlineRef(uid, outline.id), withoutId(outline));
}

export function deleteOutline(uid, id) {
  return deleteDoc(outlineRef(uid, id));
}

// ---------- Exercise library: users/{uid}/exercises/{exerciseId} ----------

const exercisesOf = (uid) => collection(db, 'users', uid, 'exercises');
const exerciseRef = (uid, id) => doc(db, 'users', uid, 'exercises', id);

// Calls onData with the whole library now and again after every change. Works offline.
export function watchExercises(uid, onData, onError) {
  return onSnapshot(
    exercisesOf(uid),
    (snapshot) => onData(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))),
    onError
  );
}

// Saves the given library entries and deletes the ones whose ids are in removedIds.
export function saveExercises(uid, entries, removedIds = []) {
  const writes = [
    ...entries.map((entry) => (batch) => batch.set(exerciseRef(uid, entry.id), withoutId(entry))),
    ...removedIds.map((id) => (batch) => batch.delete(exerciseRef(uid, id))),
  ];
  const commits = [];
  for (let start = 0; start < writes.length; start += 400) {
    const batch = writeBatch(db);
    writes.slice(start, start + 400).forEach((write) => write(batch));
    commits.push(batch.commit());
  }
  return Promise.all(commits);
}
