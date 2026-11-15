// Gym: workouts are saved to the signed-in user's Google account (Firestore, see firebase.js).
// IndexedDB is only read to move workouts from older, device-only versions into the account.

// ---------- State ----------

let fb = null; // the firebase.js module, once loaded
let user = null; // signed-in Firebase user, or null
let workouts = new Map(); // id -> workout, kept current by a Firestore listener
let workoutsReady = false;
let stopWatching = null;
let signInError = null;
let localCount = 0; // workouts still in this device's old IndexedDB store

// Ask the browser not to evict this site's data (sign-in and offline cache) when space runs low.
navigator.storage?.persist?.().catch(() => {});

// ---------- Small helpers ----------

const view = document.getElementById('view');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false && value != null) {
      el.setAttribute(key, value);
    }
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatSet(set) {
  return set.weight > 0 ? `${set.weight} kg × ${set.reps}` : `Bodyweight × ${set.reps}`;
}

function summary(workout) {
  const sets = workout.exercises.reduce((total, exercise) => total + exercise.sets.length, 0);
  return `${plural(workout.exercises.length, 'exercise')} · ${plural(sets, 'set')}`;
}

// A dismissible message above the page, for things that happen in the background.
const notice = h('div', { id: 'notice', role: 'status', hidden: true });
view.before(notice);

function notify(text, isError = false) {
  notice.className = isError ? 'error' : '';
  notice.replaceChildren(
    h('span', {}, text),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => (notice.hidden = true) }, '×')
  );
  notice.hidden = false;
}

function renderMessage(text) {
  view.replaceChildren(h('p', { class: 'muted' }, text));
}

// ---------- Workout data in the account ----------

function reportSaveError(error) {
  console.error(error);
  notify(
    error?.code === 'permission-denied'
      ? "Your account refused that change, so it wasn't saved. The Firestore security rules may not be published yet."
      : "Couldn't save that change to your account.",
    true
  );
}

// These update the screen's copy straight away. Firestore stores the change on the device
// and uploads it when there is a connection, so nothing here waits for the network.
function saveWorkout(workout) {
  workouts.set(workout.id, workout);
  fb.saveWorkout(user.uid, workout).catch(reportSaveError);
}

function deleteWorkout(id) {
  workouts.delete(id);
  fb.deleteWorkout(user.uid, id).catch(reportSaveError);
}

function saveWorkouts(list) {
  list.forEach((workout) => workouts.set(workout.id, workout));
  fb.saveWorkouts(user.uid, list).catch(reportSaveError);
}

// Returns a clean workout object, or throws if the input isn't one.
function cleanWorkout(item) {
  const text60 = (value) => String(value).trim().slice(0, 60);
  const timestamp = (value) => (Number.isFinite(value) && value > 0 ? value : null);

  // The id becomes the Firestore document id, so keep it to simple characters.
  if (!item || typeof item.id !== 'string' || !/^[\w-]{1,128}$/.test(item.id)) {
    throw new Error('Workout is missing a usable id');
  }
  if (typeof item.name !== 'string' || !text60(item.name)) {
    throw new Error('Workout is missing a name');
  }
  const exercises = Array.isArray(item.exercises) ? item.exercises : [];
  return {
    id: item.id,
    name: text60(item.name),
    startedAt: timestamp(item.startedAt) ?? Date.now(),
    finishedAt: timestamp(item.finishedAt),
    exercises: exercises
      .filter((exercise) => exercise && typeof exercise.name === 'string' && text60(exercise.name))
      .map((exercise) => ({
        id: typeof exercise.id === 'string' && exercise.id ? exercise.id : newId(),
        name: text60(exercise.name),
        sets: (Array.isArray(exercise.sets) ? exercise.sets : [])
          .filter((set) => set && Number.isFinite(set.reps) && set.reps >= 1)
          .map((set) => ({
            id: typeof set.id === 'string' && set.id ? set.id : newId(),
            weight: Number.isFinite(set.weight) && set.weight > 0 ? set.weight : 0,
            reps: Math.floor(set.reps),
          })),
      })),
  };
}

// ---------- Old device-only storage (IndexedDB), kept only for migration ----------

let localDb;

function withLocalStore(mode, action) {
  localDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('gym', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workouts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return localDb.then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('workouts', mode);
        const request = action(tx.objectStore('workouts'));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

async function listLocalWorkouts() {
  const usable = [];
  for (const item of await withLocalStore('readonly', (store) => store.getAll())) {
    try {
      usable.push(cleanWorkout(item));
    } catch {
      // Not something this app wrote; leave it where it is.
    }
  }
  return usable;
}

const deleteLocalWorkouts = (ids) =>
  withLocalStore('readwrite', (store) => {
    ids.forEach((id) => store.delete(id));
  });

// Moves this device's old workouts into the account. Workouts keep their ids, and one that
// already exists in the account is left as the account has it, so running this on several
// devices (or twice) can't create duplicates or overwrite newer edits. The device copy is
// removed only after the server has confirmed the upload; if anything fails (for example no
// connection) nothing is removed and it runs again on the next launch.
async function migrateLocalWorkouts(uid) {
  try {
    const local = await listLocalWorkouts();
    if (!local.length) {
      return;
    }
    const existing = await fb.serverWorkoutIds(uid);
    const missing = local.filter((workout) => !existing.has(workout.id));
    await fb.saveWorkouts(uid, missing);
    await deleteLocalWorkouts(local.map((workout) => workout.id));
    localCount = 0;
    if (missing.length) {
      notify(`Moved ${plural(missing.length, 'workout')} from this device into your account.`);
    }
  } catch (error) {
    console.warn('Moving device workouts to the account will be retried next time.', error);
  }
}

// ---------- Google sign-in ----------
//
// Sign-in is a plain full-page trip to Google and back to this site:
//   1. send the browser to accounts.google.com with our client id and a one-time nonce
//   2. Google sends it back to this page with an ID token in the URL fragment
//   3. hand that token to Firebase Auth (signInWithCredential)
// Nothing here uses a popup or a hidden cross-site iframe, which is what breaks Firebase's
// own signInWithRedirect/signInWithPopup in Safari and in installed iPhone PWAs when the
// site is not on Firebase Hosting.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SIGNIN_KEY = 'gym.signin';

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Must match an "Authorized redirect URI" on the OAuth client exactly.
function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function startGoogleSignIn() {
  const pending = { state: randomToken(), nonce: randomToken() };
  try {
    localStorage.setItem(SIGNIN_KEY, JSON.stringify(pending));
  } catch {
    // Without storage the answer can't be verified on return; sign-in will report that.
  }
  const params = new URLSearchParams({
    client_id: fb.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce: pending.nonce,
    state: pending.state,
    prompt: 'select_account',
  });
  location.assign(`${GOOGLE_AUTH_URL}?${params}`);
}

// If Google just sent the browser back here, returns its answer and tidies the address bar.
function takeGoogleResponse() {
  const fragment = location.hash.slice(1);
  if (!/(^|&)(id_token|error)=/.test(fragment)) {
    return null;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  return new URLSearchParams(fragment);
}

function tokenPayload(idToken) {
  const base64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
}

async function finishGoogleSignIn(response) {
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(SIGNIN_KEY));
    localStorage.removeItem(SIGNIN_KEY);
  } catch {
    // Handled below as "no pending sign-in".
  }

  try {
    if (response.get('error')) {
      if (response.get('error') !== 'access_denied') {
        throw new Error(`Google said: ${response.get('error')}`);
      }
      return; // The user cancelled.
    }
    const idToken = response.get('id_token');
    // Only accept an answer to a sign-in this device started.
    if (!pending || response.get('state') !== pending.state || tokenPayload(idToken).nonce !== pending.nonce) {
      throw new Error("The answer from Google didn't match a sign-in started here");
    }
    await fb.signInWithGoogleIdToken(idToken);
  } catch (error) {
    console.error(error);
    signInError = `Sign-in didn't complete (${error?.code ?? error?.message ?? 'unknown error'}). Please try again.`;
  }
}

async function signOutNow() {
  await fb.signOutUser();
  location.hash = '#/';
}

// ---------- Header ----------

const authSlot = h('span', { id: 'auth', class: 'row' });
(document.getElementById('header-actions') ?? document.querySelector('.bar')).append(authSlot);

function renderHeader() {
  if (!fb) {
    authSlot.replaceChildren();
  } else if (user) {
    authSlot.replaceChildren(
      h('a', { class: 'btn small secondary settings-link', href: '#/settings' }, 'Settings'),
      h('button', { class: 'btn small secondary sign-out', type: 'button', onclick: signOutNow }, 'Sign out')
    );
  } else {
    authSlot.replaceChildren(h('button', { class: 'btn small sign-in', type: 'button', onclick: startGoogleSignIn }, 'Sign in'));
  }
}

// ---------- Signed out ----------

function renderSignedOut() {
  view.replaceChildren(
    h(
      'div',
      { class: 'card signin' },
      h('h1', {}, 'Sign in to log workouts'),
      h(
        'p',
        { class: 'muted' },
        'Workouts are saved to your Google account, so they are on every device you sign in on and are still there if this one is lost or reset.'
      ),
      h('button', { class: 'btn block google', type: 'button', onclick: startGoogleSignIn }, 'Sign in with Google'),
      localCount > 0 &&
        h(
          'p',
          { class: 'muted local-note' },
          `${plural(localCount, 'workout')} already on this device will be moved into your account when you sign in.`
        ),
      signInError && h('p', { class: 'error', role: 'alert' }, signInError)
    )
  );
}

// ---------- Home: start a workout, see past ones ----------

function renderHome() {
  const list = [...workouts.values()].sort((a, b) => b.startedAt - a.startedAt);

  // The list can refresh while a name is being typed (a change arriving from another device).
  const previous = view.querySelector('.new-workout input');
  const nameInput = h('input', {
    name: 'name',
    placeholder: 'e.g. Push day',
    'aria-label': 'Workout name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
  });
  nameInput.value = previous?.value ?? '';
  const refocus = previous && document.activeElement === previous;

  const form = h(
    'form',
    {
      class: 'card new-workout',
      onsubmit: (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) {
          return;
        }
        const workout = { id: newId(), name, startedAt: Date.now(), finishedAt: null, exercises: [] };
        nameInput.value = '';
        saveWorkout(workout);
        location.hash = `#/workout/${workout.id}`;
      },
    },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput), h('button', { class: 'btn' }, 'Start'))
  );

  const historyItems = list.length
    ? list.map((workout) =>
        h(
          'a',
          { class: 'card workout-link', href: `#/workout/${workout.id}` },
          h(
            'div',
            { class: 'row' },
            h('strong', { class: 'grow' }, workout.name),
            !workout.finishedAt && h('span', { class: 'badge' }, 'In progress')
          ),
          h('span', { class: 'muted' }, `${formatDate(workout.startedAt)} · ${summary(workout)}`)
        )
      )
    : [h('p', { class: 'muted' }, 'No workouts yet. Name one above to start logging.')];

  view.replaceChildren(h('h2', {}, 'New workout'), form, h('h2', {}, 'History'), ...historyItems);
  if (refocus) {
    nameInput.focus();
  }
}

// ---------- Workout: exercises and sets ----------

function renderWorkout(workout, focusSelector) {
  const commit = (nextFocus) => {
    saveWorkout(workout);
    renderWorkout(workout, nextFocus);
  };

  const exerciseCards = workout.exercises.map((exercise) => {
    const last = exercise.sets[exercise.sets.length - 1];
    const weightInput = h('input', {
      name: 'weight',
      type: 'number',
      inputmode: 'decimal',
      enterkeyhint: 'next',
      min: '0',
      step: 'any',
      placeholder: '0',
      value: last ? String(last.weight) : null,
      // Enter moves on to reps instead of adding the set.
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          goToReps();
        }
      },
      // The phone keypads have no Enter key; their Done button just closes the keyboard,
      // which arrives here as losing focus to nothing. Treat that like Enter. Tapping
      // another field or button (relatedTarget set) is left alone, as is switching apps.
      onblur: (event) => {
        if (weightInput.value !== '' && !event.relatedTarget && document.hasFocus() && repsInput.isConnected) {
          goToReps();
        }
      },
    });
    // Focus reps with its text selected, so typing replaces the pre-filled value.
    const goToReps = () => {
      repsInput.focus();
      repsInput.select();
    };
    const repsInput = h('input', {
      name: 'reps',
      type: 'number',
      inputmode: 'numeric',
      enterkeyhint: 'done',
      min: '1',
      step: '1',
      required: true,
      value: last ? String(last.reps) : null,
    });

    return h(
      'section',
      { class: 'card exercise', 'data-id': exercise.id },
      h(
        'div',
        { class: 'row' },
        h('h3', { class: 'grow' }, exercise.name),
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            'aria-label': `Remove ${exercise.name}`,
            onclick: () => {
              if (exercise.sets.length && !confirm(`Remove ${exercise.name} and its sets?`)) {
                return;
              }
              workout.exercises = workout.exercises.filter((item) => item !== exercise);
              commit();
            },
          },
          '×'
        )
      ),
      exercise.sets.length
        ? h(
            'ol',
            { class: 'sets' },
            exercise.sets.map((set, index) =>
              h(
                'li',
                {},
                h('span', { class: 'set-n' }, String(index + 1)),
                h('span', { class: 'set-v' }, formatSet(set)),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    'aria-label': `Remove set ${index + 1}`,
                    onclick: () => {
                      exercise.sets = exercise.sets.filter((item) => item !== set);
                      commit();
                    },
                  },
                  '×'
                )
              )
            )
          )
        : h('p', { class: 'muted' }, 'No sets yet.'),
      h(
        'form',
        {
          class: 'add-set',
          onsubmit: (event) => {
            event.preventDefault();
            const weight = Number(weightInput.value) || 0;
            const reps = Math.floor(Number(repsInput.value));
            if (!(reps >= 1) || weight < 0) {
              return;
            }
            exercise.sets.push({ id: newId(), weight, reps });
            commit(`.exercise[data-id="${exercise.id}"] input[name="reps"]`);
          },
        },
        h('label', {}, 'Weight (kg)', weightInput),
        h('label', {}, 'Reps', repsInput),
        h('button', { class: 'btn' }, 'Add set')
      )
    );
  });

  const exerciseInput = h('input', {
    name: 'exercise',
    placeholder: 'e.g. Bench press',
    'aria-label': 'Exercise name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
  });

  const addExercise = h(
    'form',
    {
      class: 'card add-exercise',
      onsubmit: (event) => {
        event.preventDefault();
        const name = exerciseInput.value.trim();
        if (!name) {
          return;
        }
        const exercise = { id: newId(), name, sets: [] };
        workout.exercises.push(exercise);
        commit(`.exercise[data-id="${exercise.id}"] input[name="weight"]`);
      },
    },
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }, exerciseInput),
      h('button', { class: 'btn secondary' }, 'Add exercise')
    )
  );

  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← All workouts'),
    h('h1', {}, workout.name),
    h(
      'p',
      { class: 'muted' },
      `${formatDate(workout.startedAt)} · ${workout.finishedAt ? 'Finished' : 'In progress'} · ${summary(workout)}`
    ),
    ...exerciseCards,
    addExercise,
    h(
      'div',
      { class: 'actions' },
      !workout.finishedAt &&
        h(
          'button',
          {
            class: 'btn block finish',
            type: 'button',
            onclick: () => {
              workout.finishedAt = Date.now();
              saveWorkout(workout);
              location.hash = '#/';
            },
          },
          'Finish workout'
        ),
      h(
        'button',
        {
          class: 'btn danger block',
          type: 'button',
          onclick: () => {
            if (!confirm(`Delete "${workout.name}"? This can't be undone.`)) {
              return;
            }
            deleteWorkout(workout.id);
            location.hash = '#/';
          },
        },
        'Delete workout'
      )
    )
  );

  if (focusSelector) {
    view.querySelector(focusSelector)?.focus();
  }
}

// ---------- Settings: account and backup ----------

const BACKUP_FORMAT = 'gym-workouts';

function exportWorkouts() {
  const backup = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    workouts: [...workouts.values()],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: `gym-workouts-${backup.exportedAt.slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return backup.workouts.length;
}

// Returns clean workout objects, or throws if the file isn't a backup.
function parseBackup(text) {
  const data = JSON.parse(text);
  const items = Array.isArray(data) ? data : data?.workouts;
  if (!Array.isArray(items)) {
    throw new Error('No workouts list in file');
  }
  return items.map(cleanWorkout);
}

// Merges the file into the account: a workout with the same id is replaced, the rest are kept.
async function importWorkouts(file) {
  const list = parseBackup(await file.text());
  saveWorkouts(list);
  return list.length;
}

function renderSettings(backupMessage) {
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) {
        return;
      }
      try {
        renderSettings({ text: `Imported ${plural(await importWorkouts(file), 'workout')}.` });
      } catch (error) {
        console.error(error);
        renderSettings({ text: "Couldn't import that file. It doesn't look like a Gym export.", error: true });
      }
    },
  });

  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← All workouts'),
    h('h1', {}, 'Settings'),
    h('h2', {}, 'Account'),
    h(
      'div',
      { class: 'card account' },
      h('strong', {}, user.displayName || 'Signed in'),
      h('p', { class: 'muted' }, user.email || ''),
      h(
        'p',
        { class: 'muted' },
        'Workouts are saved to this Google account and kept in step across your devices. Anything logged without signal is uploaded when you are back online.'
      ),
      h('button', { class: 'btn secondary block', type: 'button', onclick: signOutNow }, 'Sign out')
    ),
    h('h2', {}, 'Backup'),
    h(
      'div',
      { class: 'card backup' },
      h('p', { class: 'muted' }, 'Download a copy of all your workouts as a file, or load one back in.'),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn secondary grow export',
            type: 'button',
            disabled: workouts.size === 0,
            onclick: () => renderSettings({ text: `Exported ${plural(exportWorkouts(), 'workout')}.` }),
          },
          'Export'
        ),
        h('button', { class: 'btn secondary grow import', type: 'button', onclick: () => fileInput.click() }, 'Import'),
        fileInput
      ),
      backupMessage &&
        h('p', { class: backupMessage.error ? 'error status' : 'muted status', role: 'status' }, backupMessage.text)
    )
  );
}

// ---------- Routing ----------

const onHomeScreen = () => location.hash !== '#/settings' && !location.hash.startsWith('#/workout/');

function route() {
  if (!fb) {
    return;
  }
  if (!user) {
    renderSignedOut();
    return;
  }
  if (!workoutsReady) {
    renderMessage('Loading your workouts…');
    return;
  }
  if (location.hash === '#/settings') {
    renderSettings();
    window.scrollTo(0, 0);
    return;
  }
  const match = location.hash.match(/^#\/workout\/(.+)$/);
  if (match) {
    const workout = workouts.get(decodeURIComponent(match[1]));
    if (workout) {
      renderWorkout(workout);
      window.scrollTo(0, 0);
      return;
    }
    history.replaceState(null, '', '#/');
  }
  renderHome();
}

function onUserChanged(nextUser) {
  user = nextUser;
  stopWatching?.();
  stopWatching = null;
  workouts = new Map();
  workoutsReady = false;
  renderHeader();
  route();
  if (!user) {
    return;
  }

  signInError = null;
  const uid = user.uid;
  stopWatching = fb.watchWorkouts(
    uid,
    (list) => {
      workouts = new Map(list.map((workout) => [workout.id, workout]));
      const first = !workoutsReady;
      workoutsReady = true;
      // Don't redraw a workout or the settings page under the user's fingers.
      if (first || onHomeScreen()) {
        route();
      }
    },
    (error) => {
      console.error(error);
      view.replaceChildren(
        h(
          'p',
          { class: 'error' },
          error?.code === 'permission-denied'
            ? "Your account wouldn't let this app read your workouts. The Firestore security rules may not be published yet."
            : "Couldn't load your workouts. Check your connection and reopen the app."
        )
      );
    }
  );
  migrateLocalWorkouts(uid);
}

async function start() {
  renderMessage('Loading…');
  const googleResponse = takeGoogleResponse();

  listLocalWorkouts()
    .then((list) => {
      localCount = list.length;
      if (fb && !user && localCount) {
        route();
      }
    })
    .catch(() => {});

  try {
    fb = await import('./firebase.js');
  } catch (error) {
    console.error(error);
    view.replaceChildren(
      h('p', { class: 'error' }, "Couldn't load the sign-in and sync code from Google. Connect to the internet, then try again."),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again')
    );
    return;
  }

  if (googleResponse) {
    await finishGoogleSignIn(googleResponse);
  }
  window.addEventListener('hashchange', route);
  fb.watchUser(onUserChanged);
}

start();

// ---------- Install prompt and service worker ----------

let deferredPrompt;
const installButton = document.getElementById('install');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installButton.hidden = false;
});

installButton?.addEventListener('click', async () => {
  if (!deferredPrompt) {
    return;
  }

  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js');
  });
}
