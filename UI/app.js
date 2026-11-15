// Gym: workouts are saved to the signed-in user's Google account (Firestore, see firebase.js).
// IndexedDB is only read to move workouts from older, device-only versions into the account.

// ---------- State ----------

let fb = null; // the firebase.js module, once loaded
let user = null; // signed-in Firebase user, or null
let workouts = new Map(); // id -> workout, kept current by a Firestore listener
let workoutsReady = false;
let settings = { unit: 'lb' }; // saved in the account; lb until the user chooses otherwise
let settingsReady = false;
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

// Inline SVG icons, drawn in the current text colour. They are decoration only: the button
// or link around each one carries the label.
const ICONS = {
  // three dots, stacked
  more:
    '<circle cx="12" cy="5" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.9" fill="currentColor" stroke="none"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  // a keyboard with a down arrow under it
  keyboardDown:
    '<rect x="3" y="3.5" width="18" height="11" rx="2"/><path d="M7 7.5h.01M11 7.5h.01M15 7.5h.01M8 11h8"/><path d="M9 18l3 3 3-3"/>',
  backspace: '<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="M17 9.5l-5 5M12 9.5l5 5"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = ICONS[name];
  return svg;
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

// ---------- Weight units ----------
//
// Every set is stored exactly as it was entered: { weight, unit }. Sets saved before units
// existed have no unit and are kilograms. Converting only ever happens on the way to the
// screen; stored values are never rewritten.

const UNITS = ['lb', 'kg'];
const KG_PER_LB = 0.45359237;

const unitOf = (set) => (set.unit === 'lb' ? 'lb' : 'kg');

function convertWeight(weight, from, to) {
  if (from === to) {
    return weight;
  }
  return from === 'lb' ? weight * KG_PER_LB : weight / KG_PER_LB;
}

// One decimal place, without a trailing ".0".
const roundForDisplay = (weight) => String(Math.round(weight * 10) / 10);

// A set's weight as text in the user's current unit. Shown exactly when it was entered in
// that unit, rounded when it has to be converted.
function shownWeight(set) {
  const from = unitOf(set);
  return from === settings.unit ? String(set.weight) : roundForDisplay(convertWeight(set.weight, from, settings.unit));
}

function formatSet(set) {
  return set.weight > 0 ? `${shownWeight(set)} ${settings.unit} × ${set.reps}` : `Bodyweight × ${set.reps}`;
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
            unit: unitOf(set), // no unit (older data and backups) means kg
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

// The round profile button and the small menu under it (name, email, Sign out).
let account = null; // { wrapper, button, menu } while signed in

function setAccountMenu(open) {
  if (account) {
    account.menu.hidden = !open;
    account.button.setAttribute('aria-expanded', String(open));
  }
}

function accountControl() {
  const name = user.displayName || user.email || 'Account';
  // Starts as the user's initial; swapped for their Google photo once it has loaded, so a
  // missing or unreachable photo (for example offline) just leaves the initial.
  const avatar = h('span', { class: 'avatar' }, name.trim().charAt(0).toUpperCase());
  if (user.photoURL) {
    const photo = h('img', { alt: '', referrerpolicy: 'no-referrer' });
    photo.addEventListener('load', () => avatar.replaceChildren(photo));
    photo.src = user.photoURL;
  }

  const menu = h(
    'div',
    { class: 'account-menu', id: 'account-menu', role: 'group', 'aria-label': 'Account', hidden: true },
    h('strong', {}, user.displayName || 'Signed in'),
    user.email && h('span', { class: 'muted' }, user.email),
    h('button', { class: 'btn secondary block sign-out', type: 'button', onclick: signOutNow }, 'Sign out')
  );
  const button = h(
    'button',
    {
      class: 'avatar-btn',
      type: 'button',
      'aria-label': `Account: ${name}`,
      'aria-expanded': 'false',
      'aria-controls': 'account-menu',
      onclick: () => setAccountMenu(menu.hidden),
    },
    avatar
  );
  account = { wrapper: h('span', { class: 'account' }, button, menu), button, menu };
  return account.wrapper;
}

// Tapping anywhere else, or Escape, closes the account menu.
document.addEventListener('pointerdown', (event) => {
  if (account && !account.wrapper.contains(event.target)) {
    setAccountMenu(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && account && !account.menu.hidden) {
    setAccountMenu(false);
    account.button.focus();
  }
});

function renderHeader() {
  account = null;
  if (!fb) {
    authSlot.replaceChildren();
  } else if (user) {
    authSlot.replaceChildren(
      h(
        'a',
        { class: 'icon-btn history-link', href: '#/history', 'aria-label': 'Workout history', title: 'Workout history' },
        icon('more')
      ),
      h('a', { class: 'icon-btn settings-link', href: '#/settings', 'aria-label': 'Settings', title: 'Settings' }, icon('gear')),
      accountControl()
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

// ---------- Home: start a workout, carry on with an unfinished one ----------

function workoutLink(workout) {
  return h(
    'a',
    { class: 'card workout-link', href: `#/workout/${workout.id}` },
    h(
      'div',
      { class: 'row' },
      h('strong', { class: 'grow' }, workout.name),
      !workout.finishedAt && h('span', { class: 'badge' }, 'In progress')
    ),
    h('span', { class: 'muted' }, `${formatDate(workout.startedAt)} · ${summary(workout)}`)
  );
}

const newestFirst = () => [...workouts.values()].sort((a, b) => b.startedAt - a.startedAt);

function renderHome() {
  // Finished workouts live on the History screen (the three-dot button in the header).
  const unfinished = newestFirst().filter((workout) => !workout.finishedAt);

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

  view.replaceChildren(
    h('h2', {}, 'New workout'),
    form,
    ...(unfinished.length ? [h('h2', {}, 'In progress'), ...unfinished.map(workoutLink)] : [])
  );
  if (refocus) {
    nameInput.focus();
  }
}

// ---------- History: every workout, newest first ----------

function renderHistory() {
  const list = newestFirst();
  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← Back'),
    h('h1', {}, 'History'),
    ...(list.length ? list.map(workoutLink) : [h('p', { class: 'muted' }, 'No workouts yet.')])
  );
}

// ---------- In-app number pad (replaces the phone keyboard for weight and reps) ----------
//
// The weight and reps fields have inputmode="none", so the phone's own keyboard never opens.
// They are still ordinary focusable text fields: a physical keyboard types into them as
// usual, and the pad below just edits the value of whichever one is active.

let padField = null; // the field the pad is editing, or null when the pad is closed
let padFresh = false; // true until the first key: the next digit replaces the pre-filled value
let padSuppressed = false; // set while focusing a field from code without opening the pad

const padKey = (label, key, attrs = {}) =>
  h('button', { type: 'button', class: 'pad-key', 'data-key': key, ...attrs }, label);
const padPoint = padKey('.', '.', { 'aria-label': 'Decimal point' });
const padAction = padKey('Next', 'action', { class: 'pad-key pad-action' });
const pad = h(
  'div',
  { id: 'keypad', role: 'group', 'aria-label': 'Number pad' },
  h(
    'div',
    { class: 'pad-keys' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => padKey(digit, digit)),
    padPoint,
    padKey('0', '0'),
    padKey(icon('backspace'), 'back', { 'aria-label': 'Backspace' }),
    padKey(icon('keyboardDown'), 'hide', { class: 'pad-key pad-hide', 'aria-label': 'Hide keypad' }),
    padAction
  )
);
document.body.append(pad);

const isPadField = (element) => element instanceof HTMLInputElement && element.hasAttribute('data-pad');

// Scrolls just enough that the field sits between the header and the pad.
function revealPadField(field) {
  const rect = field.getBoundingClientRect();
  // The header may have scrolled away (it stops sticking on short landscape screens).
  const headerBottom = Math.max(0, document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0);
  const lowest = window.innerHeight - pad.offsetHeight - 12;
  if (rect.bottom > lowest) {
    window.scrollBy(0, rect.bottom - lowest);
  } else if (rect.top < headerBottom + 8) {
    window.scrollBy(0, rect.top - headerBottom - 8);
  }
}

function openPad(field) {
  padField?.classList.remove('pad-active');
  padField = field;
  padFresh = true;
  field.classList.add('pad-active');

  const isWeight = field.name === 'weight';
  padPoint.disabled = !isWeight;
  padAction.textContent = isWeight ? 'Next' : 'Add set';

  pad.classList.add('open');
  // Room at the bottom of the page so the last fields can scroll clear of the pad.
  document.body.style.setProperty('--pad-height', `${pad.offsetHeight}px`);
  document.body.classList.add('pad-open');

  if (document.activeElement !== field) {
    field.focus({ preventScroll: true });
  }
  field.select(); // shows that the next digit replaces the whole value
  revealPadField(field);
}

function closePad() {
  padField?.classList.remove('pad-active');
  padField = null;
  pad.classList.remove('open');
  document.body.classList.remove('pad-open');
}

function focusWithoutPad(field) {
  padSuppressed = true;
  field.focus();
  padSuppressed = false;
}

function pressPadKey(key) {
  const field = padField;
  if (!field?.isConnected) {
    closePad();
    return;
  }
  const isWeight = field.name === 'weight';

  if (key === 'hide') {
    // Just puts the pad away. What has been typed stays in the row, unsaved.
    closePad();
    field.blur();
    return;
  }
  if (key === 'action') {
    if (isWeight) {
      openPad(field.form.elements.reps);
    } else if (field.form.checkValidity()) {
      field.form.requestSubmit(); // same as pressing the form's own "Add set"
    } else {
      // The browser's own "fill out this field" bubble would sit behind the pad, so mark
      // the field instead. The mark clears on the next key.
      field.classList.add('pad-invalid');
      field.setAttribute('aria-invalid', 'true');
    }
    return;
  }
  field.classList.remove('pad-invalid');
  field.removeAttribute('aria-invalid');

  let text;
  if (key === 'back') {
    text = field.value.slice(0, -1);
  } else {
    text = padFresh ? '' : field.value;
    if (key === '.') {
      if (!isWeight || text.includes('.')) {
        return;
      }
      text = `${text || '0'}.`;
    } else {
      text = text === '0' ? key : text + key;
    }
    const [whole, decimals = ''] = text.split('.');
    if (whole.length > (isWeight ? 4 : 3) || decimals.length > 2) {
      return;
    }
  }

  padFresh = false;
  field.value = text;
  // Tapping a key can take focus on some browsers; put the caret back at the end.
  field.focus({ preventScroll: true });
  field.setSelectionRange(text.length, text.length);
}

pad.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in the field
pad.addEventListener('click', (event) => {
  const key = event.target.closest?.('.pad-key');
  if (key && !key.disabled) {
    pressPadKey(key.dataset.key);
  }
});

// Tapping anywhere that isn't the pad or one of its fields closes it.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!padField || pad.contains(event.target) || isPadField(event.target)) {
      return;
    }
    const field = padField;
    closePad();
    field.blur();
  },
  true
);
// So does moving focus somewhere else (for example with Tab), or pressing Escape.
document.addEventListener('focusin', (event) => {
  if (padField && !pad.contains(event.target) && !isPadField(event.target)) {
    closePad();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && padField) {
    closePad();
  }
});

// A weight or reps field wired to the pad. `allowed` strips anything a physical keyboard
// (or paste) puts in that isn't part of a number.
function padInput(attrs, allowed) {
  const input = h('input', {
    type: 'text',
    inputmode: 'none',
    autocomplete: 'off',
    'data-pad': true,
    ...attrs,
    onfocus: () => {
      if (!padSuppressed && padField !== input) {
        openPad(input);
      }
    },
    // A tap on a field that already has focus (pad closed), or the tap that follows the
    // focus above and would otherwise drop the selection.
    onclick: () => {
      if (padField !== input) {
        openPad(input);
      } else if (padFresh) {
        input.select();
      }
    },
    oninput: () => {
      const cleaned = allowed(input.value.replace(',', '.'));
      if (cleaned !== input.value) {
        input.value = cleaned;
      }
      input.classList.remove('pad-invalid');
      input.removeAttribute('aria-invalid');
      if (padField === input) {
        padFresh = false;
      }
    },
  });
  return input;
}

const weightText = (value) => {
  const [whole, ...rest] = value.replace(/[^0-9.]/g, '').split('.');
  return rest.length ? `${whole}.${rest.join('')}` : whole;
};
const repsText = (value) => value.replace(/[^0-9]/g, '');

// ---------- Workout: exercises and sets ----------

// The lb / kg switch, used on the workout screen and in Settings. It changes the saved
// setting: the unit weights are shown in, and the unit new sets are stored with.
function setUnit(unit) {
  const previous = settings.unit;
  if (unit === previous) {
    return;
  }
  // A weight already typed into the open row was typed in the old unit; carry it across.
  rememberOpenSetValues();
  const typed = Number(openSet?.weight);
  if (openSet && openSet.weight !== '' && Number.isFinite(typed)) {
    openSet.weight = roundForDisplay(convertWeight(typed, previous, unit));
    // Put it in the field too: the redraw that follows reads the row's values back from it.
    const field = view.querySelector('form.add-set')?.elements.weight;
    if (field) {
      field.value = openSet.weight;
    }
  }
  settings = { ...settings, unit };
  fb.saveSettings(user.uid, { unit }).catch(reportSaveError);
}

function unitToggle(afterChange) {
  return h(
    'div',
    { class: 'unit-toggle', role: 'group', 'aria-label': 'Weight unit' },
    UNITS.map((unit) =>
      h(
        'button',
        {
          class: 'unit-option',
          type: 'button',
          'aria-pressed': String(settings.unit === unit),
          onclick: () => {
            setUnit(unit);
            afterChange();
          },
        },
        unit
      )
    )
  );
}

// Which exercise has its "add a set" row open, and what has been typed into it so far.
// Only one can be open at a time. This lives in memory only (it is never saved to the
// account), so the row stays open, with its values, when the screen is redrawn after a save.
let openSet = null; // { exerciseId, weight, reps } or null

function rememberOpenSetValues() {
  const form = view.querySelector('form.add-set');
  if (openSet && form?.dataset.exercise === openSet.exerciseId) {
    openSet.weight = form.elements.weight.value;
    openSet.reps = form.elements.reps.value;
  }
}

function renderWorkout(workout, focusSelector, openPadOnFocus = false) {
  rememberOpenSetValues();
  closePad();
  if (openSet && !workout.exercises.some((exercise) => exercise.id === openSet.exerciseId)) {
    openSet = null; // its exercise was removed
  }

  const redraw = (nextFocus, withPad = false) => renderWorkout(workout, nextFocus, withPad);
  const commit = (nextFocus, withPad = false) => {
    saveWorkout(workout);
    redraw(nextFocus, withPad);
  };

  const exerciseCards = workout.exercises.map((exercise) => {
    const last = exercise.sets[exercise.sets.length - 1];
    const card = `.exercise[data-id="${exercise.id}"]`;

    // Closed: just a button. Opening it closes any other exercise's row without saving.
    const openButton = () =>
      h(
        'button',
        {
          class: 'btn secondary block open-set',
          type: 'button',
          onclick: () => {
            openSet = {
              exerciseId: exercise.id,
              weight: last ? shownWeight(last) : '',
              reps: last ? String(last.reps) : '',
            };
            redraw(`${card} input[name="weight"]`, true);
          },
        },
        '+ Add set'
      );

    // Open: the weight/reps row, typed into with the in-app number pad.
    const setRow = () => {
      const weightInput = padInput(
        {
          name: 'weight',
          enterkeyhint: 'next',
          pattern: '[0-9]*[.]?[0-9]*',
          title: 'A number, for example 62.5',
          placeholder: '0',
          value: openSet.weight || null,
          // Enter moves on to reps instead of adding the set.
          onkeydown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              openPad(repsInput);
            }
          },
        },
        weightText
      );
      const repsInput = padInput(
        {
          name: 'reps',
          enterkeyhint: 'done',
          pattern: '0*[1-9][0-9]*',
          title: 'A whole number, 1 or more',
          required: true,
          value: openSet.reps || null,
        },
        repsText
      );

      return h(
        'form',
        {
          class: 'add-set',
          'data-exercise': exercise.id,
          onsubmit: (event) => {
            event.preventDefault();
            const reps = Math.floor(Number(repsInput.value));
            // A weight left exactly as pre-filled is the previous set's weight, so store
            // that set's own value and unit rather than a rounded conversion of it.
            const unchanged = last && weightInput.value !== '' && weightInput.value === shownWeight(last);
            const weight = unchanged ? last.weight : Number(weightInput.value) || 0;
            const unit = unchanged ? unitOf(last) : settings.unit;
            if (!(reps >= 1) || weight < 0) {
              return;
            }
            exercise.sets.push({ id: newId(), weight, unit, reps });
            openSet = null; // back to the "+ Add set" button; the next set is opened by hand
            commit(`${card} .open-set`);
          },
        },
        h('label', {}, `Weight (${settings.unit})`, weightInput),
        h('label', {}, 'Reps', repsInput),
        h('button', { class: 'btn' }, 'Add set'),
        h(
          'button',
          {
            class: 'icon-btn cancel-set',
            type: 'button',
            'aria-label': 'Cancel',
            onclick: () => {
              openSet = null;
              redraw(`${card} .open-set`);
            },
          },
          '×'
        )
      );
    };

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
            class: 'icon-btn destructive',
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
                    class: 'icon-btn destructive',
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
      openSet?.exerciseId === exercise.id ? setRow() : openButton()
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
        commit(`.exercise[data-id="${exercise.id}"] .open-set`);
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
      'div',
      { class: 'row workout-meta' },
      h(
        'p',
        { class: 'muted grow' },
        `${formatDate(workout.startedAt)} · ${workout.finishedAt ? 'Finished' : 'In progress'} · ${summary(workout)}`
      ),
      unitToggle(() => redraw())
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

  // "+ Add set" asks for the pad to open on the weight field; any other focus leaves it closed.
  const focusTarget = focusSelector && view.querySelector(focusSelector);
  if (focusTarget && (openPadOnFocus || !isPadField(focusTarget))) {
    focusTarget.focus();
  } else if (focusTarget) {
    focusWithoutPad(focusTarget);
  }
}

// ---------- Settings: account and backup ----------

const BACKUP_FORMAT = 'gym-workouts';

function exportWorkouts() {
  const backup = {
    format: BACKUP_FORMAT,
    version: 2, // 2 adds a unit on every set, and the unit setting. Version 1 files were all kg.
    exportedAt: new Date().toISOString(),
    settings: { unit: settings.unit },
    workouts: [...workouts.values()].map((workout) => ({
      ...workout,
      exercises: workout.exercises.map((exercise) => ({
        ...exercise,
        sets: exercise.sets.map((set) => ({ ...set, unit: unitOf(set) })),
      })),
    })),
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
    h('h2', {}, 'Units'),
    h(
      'div',
      { class: 'card units' },
      h(
        'div',
        { class: 'row' },
        h('strong', { class: 'grow' }, 'Weight unit'),
        unitToggle(() => renderSettings())
      ),
      h(
        'p',
        { class: 'muted' },
        'Weights are shown in this unit and new sets are saved in it. Sets you already logged keep the unit they were entered in and are converted for display.'
      )
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

// The home and history screens are lists that are safe to redraw when data changes.
const onHomeScreen = () => location.hash !== '#/settings' && !location.hash.startsWith('#/workout/');

function route() {
  closePad();
  setAccountMenu(false);
  openSet = null;
  if (!fb) {
    return;
  }
  if (!user) {
    renderSignedOut();
    return;
  }
  if (!workoutsReady || !settingsReady) {
    renderMessage('Loading your workouts…');
    return;
  }
  if (location.hash === '#/settings') {
    renderSettings();
    window.scrollTo(0, 0);
    return;
  }
  if (location.hash === '#/history') {
    renderHistory();
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
  settings = { unit: 'lb' };
  settingsReady = false;
  renderHeader();
  route();
  if (!user) {
    return;
  }

  signInError = null;
  const uid = user.uid;
  const stopWorkouts = fb.watchWorkouts(
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
  const settingsLoaded = (unit) => {
    const first = !settingsReady;
    settingsReady = true;
    const changed = unit !== settings.unit; // false for the echo of a change made here
    settings = { ...settings, unit };
    if (first || changed) {
      route();
    }
  };
  const stopSettings = fb.watchSettings(
    uid,
    (saved) => settingsLoaded(saved.unit === 'kg' ? 'kg' : 'lb'), // nothing saved yet means lb
    (error) => {
      console.error(error);
      settingsLoaded(settings.unit); // carry on with what we have
    }
  );
  stopWatching = () => {
    stopWorkouts();
    stopSettings();
  };
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
