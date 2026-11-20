// Gym: workouts are saved to the signed-in user's Google account (Firestore, see firebase.js).
// IndexedDB is only read to move workouts from older, device-only versions into the account.

// ---------- State ----------

let fb = null; // the firebase.js module, once loaded
let user = null; // signed-in Firebase user, or null
let workouts = new Map(); // id -> workout, kept current by a Firestore listener
let workoutsReady = false;
// Saved in the account. unit: lb until the user chooses otherwise. setHint: whether exercise
// cards show the last set or the heaviest set ('last' or 'max'). restSeconds: the rest timer
// length for exercises that haven't been given their own.
const DEFAULT_SETTINGS = { unit: 'lb', setHint: 'last', restSeconds: 120 };
let settings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
let library = new Map(); // exercise key -> library entry, kept current by a Firestore listener
let libraryReady = false;
let outlines = new Map(); // id -> outline, kept current by a Firestore listener
let outlinesReady = false;
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
  // two arrows pointing opposite ways
  swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 12l4 4-4 4"/><path d="M21 16H7"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
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

function formatDateTime(timestamp) {
  return `${formatDate(timestamp)}, ${new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

// Workouts are known by when they started. Ones made while workouts still had titles keep
// showing their title.
const workoutLabel = (workout) => workout.name || formatDateTime(workout.startedAt);

const two = (value) => String(value).padStart(2, '0');

// A running clock: "12:34", or "1:02:03" from an hour up.
function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
}

// A length of time in words: "45 min", "1 h 12 min", or "40 sec" under a minute.
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} sec`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const workoutDuration = (workout) => formatDuration(workout.finishedAt - workout.startedAt);

// A rest timer length: "2m 30s", or "45s" under a minute.
function formatRestLength(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${two(seconds % 60)}s` : `${seconds}s`;
}

// The same in words, for screen readers: "2 minutes 30 seconds".
function restLengthWords(seconds) {
  const minutes = Math.floor(seconds / 60);
  return [minutes && plural(minutes, 'minute'), seconds % 60 && plural(seconds % 60, 'second')].filter(Boolean).join(' ');
}

// Rest left: "02:29". Rounded up, so it reads 00:01 in the last second, not 00:00.
function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
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

// A set's weight as text in the user's current unit (or the unit given). Shown exactly when
// it was entered in that unit, rounded when it has to be converted.
function shownWeight(set, unit = settings.unit) {
  const from = unitOf(set);
  return from === unit ? String(set.weight) : roundForDisplay(convertWeight(set.weight, from, unit));
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
//
// Each one also brings the exercise library up to date for the exercises it touched.
// `used` names exercises the user has just added or logged a set for; `removed` names
// exercises that were taken out of the workout (they are no longer in it to be found).
function saveWorkout(workout, { used = [], removed = [] } = {}) {
  workouts.set(workout.id, workout);
  fb.saveWorkout(user.uid, workout).catch(reportSaveError);
  syncLibrary([...exerciseNames(workout), ...removed], used);
}

function deleteWorkout(id) {
  const touched = exerciseNames(workouts.get(id));
  workouts.delete(id);
  fb.deleteWorkout(user.uid, id).catch(reportSaveError);
  syncLibrary(touched);
}

function saveWorkouts(list) {
  // Exercises in the new workouts, and in the versions of them that are being replaced.
  const touched = list.flatMap((workout) => [...exerciseNames(workout), ...exerciseNames(workouts.get(workout.id))]);
  list.forEach((workout) => workouts.set(workout.id, workout));
  fb.saveWorkouts(user.uid, list).catch(reportSaveError);
  syncLibrary(touched);
}

// Outlines: users/{uid}/outlines/{id} is { name, createdAt, exercises: [{ name, sets }] },
// where `sets` is how many sets the exercise had. No weights or reps are kept.
function saveOutline(outline) {
  outlines.set(outline.id, outline);
  fb.saveOutline(user.uid, outline).catch(reportSaveError);
}

function deleteOutline(id) {
  outlines.delete(id);
  fb.deleteOutline(user.uid, id).catch(reportSaveError);
}

// Returns a clean outline object, or null if the input isn't one.
function cleanOutline(item) {
  const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : '';
  if (!name || typeof item.id !== 'string' || !/^[\w-]{1,128}$/.test(item.id)) {
    return null;
  }
  return {
    id: item.id,
    name,
    createdAt: Number.isFinite(item.createdAt) && item.createdAt > 0 ? item.createdAt : 0,
    exercises: (Array.isArray(item.exercises) ? item.exercises : [])
      .filter((exercise) => exercise && typeof exercise.name === 'string' && exercise.name.trim())
      .map((exercise) => ({
        name: exercise.name.trim().slice(0, 60),
        sets: Number.isInteger(exercise.sets) && exercise.sets > 0 ? exercise.sets : 0,
      })),
  };
}

// ---------- Exercise library ----------
//
// users/{uid}/exercises has one entry for each exercise that is in any of the user's
// workouts: { name, key, lastUsedAt, last, max }. `last` is the most recent set and `max`
// the heaviest one, each { weight, unit, reps, date } exactly as the set was entered, or
// null when the exercise has no sets yet. `date` is the start of the workout the set is in.
//
// `last` and `max` are always worked out again from the workouts rather than adjusted, so
// deleting a set (even the heaviest one) leaves them correct.
//
// Hand edits from the Exercise data page are kept in `manual`: { max, last }, each
// { at, set } where `at` is when the edit was made and `set` is { weight, unit, reps }, or
// null when the stat was cleared. An edited stat starts from that set and only sets logged
// after `at` count towards it: a heavier one replaces an edited max, and any one replaces an
// edited last. The record made from an edited set carries `edited: true`, with `at` as its
// date. Automatic updates never write `manual` (see autoFields), so they can't undo an edit.
//
// `hidden: true` takes an exercise out of the suggestions and the Exercise data list until it
// is used in a workout again.

// Names that differ only in case or spacing are the same exercise.
const exerciseKey = (name) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// The Firestore document id for a key. It is derived from the key, so the same exercise
// added on two devices lands in one document. Anything but a-z and 0-9 is spelled out as
// its character code, which keeps the id to characters Firestore accepts.
const exerciseDocId = (key) => `e_${key.replace(/[^a-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`)}`;

const exerciseNames = (workout) => (Array.isArray(workout?.exercises) ? workout.exercises : []).map((exercise) => exercise?.name);

const setInKg = (set) => convertWeight(set.weight, unitOf(set), 'kg');

// Whether set `a` is better than set `b`: heavier, or more reps at the same weight.
// Anything beats no set at all.
const beats = (a, b) => !b || setInKg(a) > setInKg(b) || (setInKg(a) === setInKg(b) && a.reps > b.reps);

// The hand edits on a library entry, checked: { max, last }, each { at, set } or null where
// that stat has not been edited. `set` is { weight, unit, reps }, or null for a cleared stat.
function manualEdits(entry) {
  const part = (value) => {
    if (!value || !Number.isFinite(value.at)) {
      return null;
    }
    const set = value.set;
    const usable = set && Number.isFinite(set.weight) && set.weight >= 0 && Number.isInteger(set.reps) && set.reps >= 1;
    return { at: value.at, set: usable ? { weight: set.weight, unit: unitOf(set), reps: set.reps } : null };
  };
  return { max: part(entry?.manual?.max), last: part(entry?.manual?.last) };
}

// The library record for a hand-edited stat: its set, dated when the edit was made.
const editedRecord = (part) => (part?.set ? { ...part.set, date: part.at, edited: true } : null);

const hasEditedSet = (entry) => {
  const manual = manualEdits(entry);
  return Boolean(manual.max?.set || manual.last?.set);
};

// Reads the given workouts and returns key -> { name, lastUsedAt, last, max } for every
// exercise in them, or only for the keys in `wanted`. The hand edits of the matching
// entries in `entries` are applied (see the top of this section).
function deriveLibrary(list, wanted = null, entries = library) {
  const found = new Map();
  const oldestFirst = [...list].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const workout of oldestFirst) {
    const date = workout.startedAt || 0;
    for (const exercise of Array.isArray(workout.exercises) ? workout.exercises : []) {
      const key = exerciseKey(exercise?.name);
      if (!key || (wanted && !wanted.has(key))) {
        continue;
      }
      let entry = found.get(key);
      if (!entry) {
        // An edited stat starts from the edited set; an unedited one from nothing.
        const manual = manualEdits(entries.get(key));
        entry = { name: '', lastUsedAt: 0, last: editedRecord(manual.last), max: editedRecord(manual.max), manual };
        found.set(key, entry);
      }
      // Later workouts overwrite earlier ones, so these end up as the most recent.
      entry.name = String(exercise.name).trim();
      entry.lastUsedAt = date;
      for (const set of Array.isArray(exercise.sets) ? exercise.sets : []) {
        if (!set || !Number.isFinite(set.weight) || !Number.isFinite(set.reps)) {
          continue;
        }
        const record = { weight: set.weight, unit: unitOf(set), reps: set.reps, date };
        // When the set was logged. Sets saved before that was recorded count as logged
        // when their workout started.
        const loggedAt = Number.isFinite(set.at) ? set.at : date;
        if (!entry.manual.last || loggedAt > entry.manual.last.at) {
          entry.last = record;
        }
        // Heaviest wins; at the same weight, more reps wins; a tie keeps the earlier set.
        if ((!entry.manual.max || loggedAt > entry.manual.max.at) && beats(record, entry.max)) {
          entry.max = record;
        }
      }
    }
  }
  return found;
}

// The entry to keep for a key. An entry that already exists keeps its id, its name, its
// hand edits and whether it is hidden, unless it is being used now, which brings it back.
function libraryEntry(key, found, existing, usedNow = false) {
  const entry = {
    ...existing,
    id: existing?.id ?? exerciseDocId(key),
    name: existing?.name ?? found.name,
    key,
    lastUsedAt: usedNow ? Date.now() : Math.max(existing?.lastUsedAt ?? 0, found.lastUsedAt),
    last: found.last,
    max: found.max,
  };
  if (usedNow && entry.hidden) {
    entry.hidden = false;
  }
  return entry;
}

// The fields that the automatic updates (syncLibrary and buildLibrary) write. `manual` is
// never among them, and `hidden` only when using the exercise again has just cleared it.
function autoFields(entry, existing) {
  const fields = { id: entry.id, name: entry.name, key: entry.key, lastUsedAt: entry.lastUsedAt, last: entry.last, max: entry.max };
  if (existing?.hidden && !entry.hidden) {
    fields.hidden = false;
  }
  return fields;
}

const sameRecord = (a, b) =>
  a === b ||
  Boolean(
    a && b && a.weight === b.weight && a.unit === b.unit && a.reps === b.reps && a.date === b.date && Boolean(a.edited) === Boolean(b.edited)
  );

// Brings the library entries for these exercise names in line with the workouts as they
// are now: creates the missing ones, updates last/max, and removes an entry whose exercise
// is no longer in any workout (unless it has a hand-entered set, which is kept). Only
// entries that actually changed are written.
function syncLibrary(names, usedNames = []) {
  const keys = new Set(names.map(exerciseKey).filter(Boolean));
  if (!keys.size) {
    return;
  }
  const usedKeys = new Set(usedNames.map(exerciseKey));
  const found = deriveLibrary(workouts.values(), keys);
  const saves = [];
  const removedIds = [];
  for (const key of keys) {
    const existing = library.get(key);
    if (!found.has(key) && !hasEditedSet(existing)) {
      if (existing) {
        library.delete(key);
        removedIds.push(existing.id);
      }
      continue;
    }
    // In no workout any more, but with a hand-entered set: the edits are all there is.
    const stats = found.get(key) ?? { name: existing.name, lastUsedAt: 0, ...editedStats(existing) };
    const entry = libraryEntry(key, stats, existing, usedKeys.has(key));
    const unchanged =
      existing &&
      existing.lastUsedAt === entry.lastUsedAt &&
      sameRecord(existing.last, entry.last) &&
      sameRecord(existing.max, entry.max) &&
      Boolean(existing.hidden) === Boolean(entry.hidden);
    if (!unchanged) {
      library.set(key, entry);
      saves.push(autoFields(entry, existing));
    }
  }
  if (saves.length || removedIds.length) {
    fb.saveExercises(user.uid, saves, removedIds).catch(reportSaveError);
  }
}

// { last, max } from an entry's hand edits alone.
function editedStats(entry) {
  const manual = manualEdits(entry);
  return { last: editedRecord(manual.last), max: editedRecord(manual.max) };
}

// Runs once per account (settings.libraryBuilt records that it has): fills the library
// from every workout the account already has. It reads the workouts and the library from
// the server so a device with an incomplete offline copy can't build a partial library or
// miss a hand edit; with no connection it does nothing and runs again on the next launch.
// It never writes `manual` or `hidden`, and running it twice is harmless.
async function buildLibrary(uid) {
  try {
    const [list, stored] = await Promise.all([fb.serverWorkouts(uid), fb.serverExercises(uid)]);
    const known = new Map();
    for (const item of stored) {
      const key = typeof item.name === 'string' ? exerciseKey(item.name) : '';
      if (key) {
        known.set(key, { ...item, key });
      }
    }
    const found = deriveLibrary(list, null, known);
    await fb.saveExercises(
      uid,
      [...found].map(([key, entry]) => autoFields(libraryEntry(key, entry, known.get(key)), known.get(key)))
    );
    await fb.saveSettings(uid, { libraryBuilt: true });
  } catch (error) {
    console.warn('Building the exercise library will be retried next time.', error);
  }
}

// Returns a clean workout object, or throws if the input isn't one.
function cleanWorkout(item) {
  const text60 = (value) => String(value).trim().slice(0, 60);
  const timestamp = (value) => (Number.isFinite(value) && value > 0 ? value : null);

  // The id becomes the Firestore document id, so keep it to simple characters.
  if (!item || typeof item.id !== 'string' || !/^[\w-]{1,128}$/.test(item.id)) {
    throw new Error('Workout is missing a usable id');
  }
  const exercises = Array.isArray(item.exercises) ? item.exercises : [];
  const workout = {
    id: item.id,
    startedAt: timestamp(item.startedAt) ?? Date.now(),
    finishedAt: timestamp(item.finishedAt),
    exercises: exercises
      .filter((exercise) => exercise && typeof exercise.name === 'string' && text60(exercise.name))
      .map((exercise) => {
        const cleaned = {
          id: typeof exercise.id === 'string' && exercise.id ? exercise.id : newId(),
          name: text60(exercise.name),
          sets: (Array.isArray(exercise.sets) ? exercise.sets : [])
            .filter((set) => set && Number.isFinite(set.reps) && set.reps >= 1)
            .map((set) => {
              const cleanedSet = {
                id: typeof set.id === 'string' && set.id ? set.id : newId(),
                weight: Number.isFinite(set.weight) && set.weight > 0 ? set.weight : 0,
                unit: unitOf(set), // no unit (older data and backups) means kg
                reps: Math.floor(set.reps),
              };
              // When the set was logged; sets from before that was recorded have no time.
              if (Number.isFinite(set.at) && set.at > 0) {
                cleanedSet.at = set.at;
              }
              return cleanedSet;
            }),
        };
        // Only exercises that came from an outline have this.
        if (Number.isInteger(exercise.plannedSets) && exercise.plannedSets > 0) {
          cleaned.plannedSets = exercise.plannedSets;
        }
        return cleaned;
      }),
  };
  // Only workouts from when workouts had titles have a name.
  if (typeof item.name === 'string' && text60(item.name)) {
    workout.name = text60(item.name);
  }
  return workout;
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
    if (user?.uid === uid) {
      syncLibrary(missing.flatMap(exerciseNames));
    }
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

// ---------- Dropdown menus ----------
//
// One component for every menu that drops down from a button: the header's ⋮ and profile
// menus, and the menu on each exercise of the Exercise data page. It follows the ARIA menu
// button pattern (the button has aria-haspopup and aria-expanded; the menu is role="menu"
// with role="menuitem" options):
//   - Tapping the button opens the menu; tapping it again closes it.
//   - Only one menu is open at a time: opening one closes any other.
//   - Tapping outside it, Escape, Tab or choosing an option closes it.
//   - Up and Down move through the options (round from the last to the first), Home and End
//     go to the first and last; on the button, Down or Up opens the menu at the first or
//     last option.
//   - Opening moves focus to the first option. Closing from inside (Escape, an option, the
//     button) puts focus back on the button; a tap elsewhere leaves focus where it lands.

let openMenu = null; // the dropdown whose menu is showing, or null
let menuCount = 0; // for unique element ids

// `button` is the button that opens the menu. `items` are { label, onSelect, disabled,
// destructive }. `head` is shown above the options, outside the menu itself, and names it.
// Returns { element, button, close, place, contains }; `element` holds the button and menu.
function dropdown(button, items, { head = null, className = '' } = {}) {
  const id = `menu-${++menuCount}`;
  button.id ||= `${id}-button`;

  const options = items.map((item) =>
    h(
      'button',
      {
        class: item.destructive ? 'menu-item destructive' : 'menu-item',
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        disabled: Boolean(item.disabled),
        onclick: () => {
          close(true);
          item.onSelect();
        },
      },
      item.label
    )
  );
  const headId = head ? `${id}-head` : null;
  const menu = h('div', { class: 'menu', id, role: 'menu', 'aria-labelledby': headId ?? button.id }, options);
  const panel = h('div', { class: 'menu-panel', hidden: true }, head && h('div', { class: 'menu-head', id: headId }, head), menu);
  const element = h('div', { class: className ? `dropdown ${className}` : 'dropdown' }, button, panel);

  const usable = () => options.filter((option) => !option.disabled);

  // Under the button, lined up with its right edge; above it when there isn't room below
  // but there is above, and nudged right if it would run off the left of the screen.
  function place() {
    panel.classList.remove('above');
    panel.style.removeProperty('transform');
    const rect = panel.getBoundingClientRect();
    if (rect.bottom > document.documentElement.clientHeight - 8 && button.getBoundingClientRect().top - rect.height - 12 > 0) {
      panel.classList.add('above');
    }
    const left = panel.getBoundingClientRect().left;
    if (left < 8) {
      panel.style.transform = `translateX(${8 - left}px)`;
    }
  }

  function open(at = 'first') {
    if (openMenu && openMenu !== api) {
      openMenu.close(false);
    }
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openMenu = api;
    place();
    const list = usable();
    (at === 'last' ? list[list.length - 1] : list[0])?.focus();
  }

  function close(returnFocus) {
    if (openMenu === api) {
      openMenu = null;
    }
    if (panel.hidden) {
      return;
    }
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus && button.isConnected) {
      button.focus();
    }
  }

  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  button.addEventListener('click', () => (panel.hidden ? open() : close(true)));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowUp' ? 'last' : 'first');
    }
  });
  menu.addEventListener('keydown', (event) => {
    const list = usable();
    const index = list.indexOf(document.activeElement);
    const step = (delta) => (index < 0 ? list[delta > 0 ? 0 : list.length - 1] : list[(index + delta + list.length) % list.length]);
    let next = null;
    if (event.key === 'ArrowDown') {
      next = step(1);
    } else if (event.key === 'ArrowUp') {
      next = step(-1);
    } else if (event.key === 'Home') {
      next = list[0];
    } else if (event.key === 'End') {
      next = list[list.length - 1];
    } else if (event.key === 'Tab') {
      // Back to the button without stopping the Tab, so focus moves on from the button.
      close(true);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  const api = { element, button, close, place, contains: (node) => element.contains(node) };
  return api;
}

function closeMenus() {
  openMenu?.close(false);
}

// A tap anywhere outside the open menu and its button closes it. Capture, so nothing on the
// page can keep the tap from being seen.
document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) {
    openMenu.close(false);
  }
}, true);
document.addEventListener('keydown', (event) => {
  // Escape in a popup (the rest timer duration) closes just that popup.
  if (event.key !== 'Escape' || event.target.closest?.('dialog')) {
    return;
  }
  if (openMenu) {
    openMenu.close(true);
  } else if (location.hash === '#/settings' && !event.target.closest?.('input, textarea, select')) {
    // Settings is what the gear opens, and closes like the menus do, back to the gear.
    toggleSettings();
    settingsButton?.focus();
  }
});
window.addEventListener('resize', () => openMenu?.place());

// ---------- Header ----------

const authSlot = h('span', { id: 'auth', class: 'row' });
(document.getElementById('header-actions') ?? document.querySelector('.bar')).append(authSlot);

// The header's height as --bar-height, for what is pinned just under it: the rest timer
// and the "Rest over" banner. It changes with the notch insets and when the phone turns.
{
  const bar = document.querySelector('.bar');
  const measure = () => document.documentElement.style.setProperty('--bar-height', `${bar.getBoundingClientRect().height}px`);
  measure();
  if (window.ResizeObserver) {
    new ResizeObserver(measure).observe(bar);
  } else {
    window.addEventListener('resize', measure);
  }
}

let settingsButton = null; // the gear, while signed in

// ⋮: the other screens.
function moreMenu() {
  const button = h('button', { class: 'icon-btn more-btn', type: 'button', 'aria-label': 'More options', title: 'More options' }, icon('more'));
  return dropdown(button, [
    { label: 'Workout history', onSelect: () => (location.hash = '#/history') },
    { label: 'Exercise data', onSelect: () => (location.hash = '#/exercises') },
  ]);
}

// The round profile button: name, email and Sign out.
function accountMenu() {
  const name = user.displayName || user.email || 'Account';
  // Starts as the user's initial; swapped for their Google photo once it has loaded, so a
  // missing or unreachable photo (for example offline) just leaves the initial.
  const avatar = h('span', { class: 'avatar' }, name.trim().charAt(0).toUpperCase());
  if (user.photoURL) {
    const photo = h('img', { alt: '', referrerpolicy: 'no-referrer' });
    photo.addEventListener('load', () => avatar.replaceChildren(photo));
    photo.src = user.photoURL;
  }
  const button = h('button', { class: 'avatar-btn', type: 'button', 'aria-label': `Account: ${name}` }, avatar);
  return dropdown(button, [{ label: 'Sign out', onSelect: signOutNow }], {
    head: [h('strong', {}, user.displayName || 'Signed in'), user.email && h('span', { class: 'muted' }, user.email)],
    className: 'account-dropdown',
  });
}

// The gear opens Settings, which has too much in it for a dropdown (outline renaming, the
// backup file), and pressing it again closes Settings and goes back to the screen it was
// opened from. That is a step back in the browser history, the same as the Back button,
// when the gear opened it; Settings opened any other way (a bookmark, say) goes home.
function toggleSettings() {
  closeMenus();
  if (location.hash === '#/settings') {
    if (history.state?.settingsFromApp) {
      history.back();
    } else {
      location.replace('#/');
    }
    return;
  }
  location.hash = '#/settings';
  history.replaceState({ settingsFromApp: true }, '');
}

// Shows the gear as pressed while Settings is open.
function updateHeaderState() {
  settingsButton?.setAttribute('aria-pressed', String(location.hash === '#/settings'));
}

function renderHeader() {
  closeMenus();
  settingsButton = null;
  if (!fb) {
    authSlot.replaceChildren();
  } else if (user) {
    settingsButton = h(
      'button',
      { class: 'icon-btn settings-btn', type: 'button', 'aria-label': 'Settings', title: 'Settings', onclick: toggleSettings },
      icon('gear')
    );
    authSlot.replaceChildren(moreMenu().element, settingsButton, accountMenu().element);
    updateHeaderState();
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
      h('strong', { class: 'grow' }, workoutLabel(workout)),
      !workout.finishedAt && h('span', { class: 'badge' }, 'In progress')
    ),
    h(
      'span',
      { class: 'muted' },
      [workout.name && formatDateTime(workout.startedAt), summary(workout), workout.finishedAt && workoutDuration(workout)]
        .filter(Boolean)
        .join(' · ')
    )
  );
}

const newestFirst = () => [...workouts.values()].sort((a, b) => b.startedAt - a.startedAt);

const sortedOutlines = () => [...outlines.values()].sort((a, b) => a.name.localeCompare(b.name));

const outlineSummary = (outline) => outline.exercises.map((exercise) => exercise.name).join(', ') || 'No exercises';

// Starts a workout now and opens it. With an outline, its exercises are already in it.
function startWorkout(outline) {
  const exercises = (outline?.exercises ?? []).map((item) => {
    // The library's spelling, as when an exercise is added by hand.
    const exercise = { id: newId(), name: library.get(exerciseKey(item.name))?.name ?? item.name, sets: [] };
    if (item.sets > 0) {
      exercise.plannedSets = item.sets;
    }
    return exercise;
  });
  const workout = { id: newId(), startedAt: Date.now(), finishedAt: null, exercises };
  saveWorkout(workout, { used: exerciseNames(workout) });
  location.hash = `#/workout/${workout.id}`;
}

function renderHome() {
  // Finished workouts live on the History screen (the three-dot button in the header).
  const unfinished = newestFirst().filter((workout) => !workout.finishedAt);
  const saved = sortedOutlines();

  view.replaceChildren(
    h('button', { class: 'btn block start-workout', type: 'button', onclick: () => startWorkout() }, 'Start workout'),
    ...(saved.length
      ? [
          h('h2', {}, 'Start from an outline'),
          ...saved.map((outline) =>
            h(
              'button',
              { class: 'card outline-start', type: 'button', onclick: () => startWorkout(outline) },
              h('strong', {}, outline.name),
              h('span', { class: 'muted' }, outlineSummary(outline))
            )
          ),
        ]
      : []),
    ...(unfinished.length ? [h('h2', {}, 'In progress'), ...unfinished.map(workoutLink)] : [])
  );
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
//
// Each field is <input data-pad="weight|reps"> with an entry in padConfig: `next` gives the
// field that the pad's action key (and Enter) moves to; on the last field of a form there is
// no `next`, and the action key, labelled `action`, submits the form.

const padConfig = new WeakMap(); // field -> { next: () => field, action: 'Add set' }
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

// The bottom edge of what is pinned to the top of the screen: the header, and the rest
// timer while it counts down. Either may have scrolled away (the header stops sticking on
// short landscape screens while the pad is up).
function pinnedBottom() {
  return Math.max(
    0,
    ...[document.querySelector('.bar'), view.querySelector('.workout-clock.resting')].map(
      (element) => element?.getBoundingClientRect().bottom ?? 0
    )
  );
}

// Scrolls just enough that the field sits between the header and the pad.
function revealPadField(field) {
  const rect = field.getBoundingClientRect();
  const headerBottom = pinnedBottom();
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

  const config = padConfig.get(field) ?? {};
  padPoint.disabled = field.dataset.pad !== 'weight';
  padAction.textContent = config.next ? 'Next' : config.action ?? 'Done';

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
  const isWeight = field.dataset.pad === 'weight';

  if (key === 'hide') {
    // Just puts the pad away. What has been typed stays in the row, unsaved.
    closePad();
    field.blur();
    return;
  }
  if (key === 'action') {
    const next = padConfig.get(field)?.next?.();
    if (next) {
      openPad(next);
    } else if (field.form.checkValidity()) {
      field.form.requestSubmit(); // same as pressing the form's own submit button
    } else {
      // The browser's own "fill out this field" bubble would sit behind the pad, so mark
      // the first field that needs fixing instead. The mark clears on the next key.
      const invalid = [...field.form.elements].find((element) => isPadField(element) && !element.checkValidity()) ?? field;
      if (invalid !== field) {
        openPad(invalid);
      }
      invalid.classList.add('pad-invalid');
      invalid.setAttribute('aria-invalid', 'true');
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
  // Tell the field's listeners, as typing would.
  field.dispatchEvent(new Event('input', { bubbles: true }));
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

// A weight or reps field (`kind`) wired to the pad; `config` is its padConfig entry. Anything
// a physical keyboard (or paste) puts in that isn't part of a number is stripped out.
function padInput(attrs, kind, config = {}) {
  const allowed = kind === 'weight' ? weightText : repsText;
  const input = h('input', {
    type: 'text',
    inputmode: 'none',
    autocomplete: 'off',
    'data-pad': kind,
    ...attrs,
    // Enter moves on to the next field, like the pad's "Next"; on the last field it submits.
    onkeydown: (event) => {
      const next = event.key === 'Enter' && config.next?.();
      if (next) {
        event.preventDefault();
        openPad(next);
      }
    },
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
  padConfig.set(input, config);
  return input;
}

const weightText = (value) => {
  const [whole, ...rest] = value.replace(/[^0-9.]/g, '').split('.');
  return rest.length ? `${whole}.${rest.join('')}` : whole;
};
const repsText = (value) => value.replace(/[^0-9]/g, '');

// What the weight and reps fields accept (checked by the browser before a form is sent).
const WEIGHT_PATTERN = '[0-9]*[.]?[0-9]*';
const REPS_PATTERN = '0*[1-9][0-9]*';

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

// The small button on an exercise card that shows the last set or the heaviest set.
function setSetHint(which) {
  settings = { ...settings, setHint: which };
  fb.saveSettings(user.uid, { setHint: which }).catch(reportSaveError);
}

// ---------- "Add exercise" box, with suggestions from the exercise library ----------
//
// A combobox: the text box owns a list of the user's exercises that opens when the box is
// focused and narrows as they type. Focus never leaves the box; arrow keys move a highlight
// through the list (aria-activedescendant) and Enter picks the highlighted one.

let closeExerciseList = null; // closes the suggestion list, while one is showing

// Scrolls just enough that the open list is on screen, above the phone keyboard if it is up.
function revealExerciseList() {
  const form = view.querySelector('.add-exercise');
  if (!closeExerciseList || !form) {
    return;
  }
  const viewport = window.visualViewport;
  const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const rect = form.getBoundingClientRect();
  const headerBottom = pinnedBottom();
  const hidden = rect.bottom + 8 - visibleBottom;
  const room = rect.top - headerBottom - 8; // never push the box itself under the header
  if (hidden > 0 && room > 0) {
    window.scrollBy(0, Math.min(hidden, room));
  }
}
// The phone keyboard opening or closing changes how much of the page is visible.
window.visualViewport?.addEventListener('resize', revealExerciseList);

// Tapping anywhere outside the box and its list closes the list.
document.addEventListener('pointerdown', (event) => {
  if (closeExerciseList && !event.target.closest?.('.add-exercise')) {
    closeExerciseList();
  }
});

// `add` is called with the chosen or typed name.
function addExerciseForm(workout, add) {
  const inWorkout = new Set(workout.exercises.map((exercise) => exerciseKey(exercise.name)));
  // Most recently used first. Exercises already in this workout go to the end: they are
  // the most recent of all, and the least likely to be wanted again. Exercises removed from
  // the list on the Exercise data page are left out.
  const entries = [...library.values()]
    .filter((entry) => !entry.hidden)
    .sort((a, b) => inWorkout.has(a.key) - inWorkout.has(b.key) || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
  let matches = [];
  let active = -1; // index of the highlighted option, or -1

  const list = h('ul', {
    class: 'exercise-list',
    id: 'exercise-list',
    role: 'listbox',
    'aria-label': 'Your exercises',
    hidden: true,
  });

  const setActive = (index) => {
    active = index;
    [...list.children].forEach((option, position) => {
      option.classList.toggle('active', position === index);
      option.setAttribute('aria-selected', String(position === index));
    });
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', list.children[index].id);
      list.children[index].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const close = () => {
    if (closeExerciseList === close) {
      closeExerciseList = null;
    }
    if (list.hidden) {
      return;
    }
    setActive(-1);
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('exercise-list-open');
  };

  // Shows the exercises whose name contains what has been typed (all of them when the box
  // is empty), or closes the list when there are none.
  const open = () => {
    const typed = exerciseKey(input.value);
    matches = entries.filter((entry) => entry.key.includes(typed));
    list.replaceChildren(
      ...matches.map((entry, index) =>
        h(
          'li',
          { id: `exercise-option-${index}`, role: 'option', 'aria-selected': 'false' },
          h('span', { class: 'grow' }, entry.name),
          inWorkout.has(entry.key) && h('span', { class: 'muted' }, 'In this workout')
        )
      )
    );
    setActive(-1);
    if (!matches.length) {
      close();
      return;
    }
    list.hidden = false;
    list.scrollTop = 0;
    input.setAttribute('aria-expanded', 'true');
    // Room at the bottom of the page so the list can scroll clear of the phone keyboard.
    document.body.classList.add('exercise-list-open');
    closeExerciseList = close;
    revealExerciseList();
  };

  const input = h('input', {
    name: 'exercise',
    placeholder: 'e.g. Bench press',
    'aria-label': 'Exercise name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'exercise-list',
    onfocus: open,
    oninput: open,
    onblur: close,
    // A tap on the box when it already has focus, after Escape closed the list.
    onclick: () => {
      if (list.hidden) {
        open();
      }
    },
    onkeydown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) {
          open();
        }
        if (!list.hidden) {
          const next = active + (event.key === 'ArrowDown' ? 1 : -1);
          setActive(Math.max(-1, Math.min(matches.length - 1, next)));
        }
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault(); // pick the highlighted exercise instead of the typed text
        add(matches[active].name);
      } else if (event.key === 'Escape' && !list.hidden) {
        close();
      }
    },
  });

  // Pressing on the list must not take focus from the box: that would close the list (and
  // the phone keyboard) before the tap lands.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('li');
    if (option) {
      add(matches[[...list.children].indexOf(option)].name);
    }
  });

  return h(
    'form',
    {
      class: 'card add-exercise',
      onsubmit: (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (name) {
          add(name);
        }
      },
    },
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }, input),
      // Keeps focus in the box, so the list closing can't move this button from under the tap.
      h('button', { class: 'btn secondary', onmousedown: (event) => event.preventDefault() }, 'Add exercise')
    ),
    list
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

// ---------- Rest timer ----------
//
// Each exercise has a rest timer that is on or off and has a length. Both are kept on its
// exercise library entry as `rest: { on, seconds }`, each field written only once the user
// has changed it: an exercise with no `on` has its timer on, and one with no `seconds` uses
// the default length from Settings (settings.restSeconds).
//
// Logging a set of an exercise whose timer is on starts a rest. The rest is saved on the
// workout in progress as `restEndsAt` (when it ends, in ms like Date.now()) and
// `restExercise` (the exercise's name, for the "Rest over" banner). Everything shown is
// worked out from restEndsAt and the current time, never counted down, so it is still right
// after the app was closed and reopened, the phone was locked, or the device went offline.
// A restEndsAt that has passed is simply not a rest any more; it is only removed from the
// workout by Skip and by finishing the workout.

const REST_STEP = 5; // seconds; the seconds wheel moves in these
const REST_MAX_MINUTES = 15;
// A rest that ended while the phone was locked or the app was in the background still gets
// its alert on coming back, if that is within this long of the end. Later than that, the
// clock just shows the workout time again.
const REST_ALERT_GRACE = 60 * 1000;

// A rest length in seconds if it is one the picker could have chosen, otherwise null.
const cleanRestSeconds = (value) =>
  Number.isInteger(value) && value >= REST_STEP && value <= REST_MAX_MINUTES * 60 + 60 - REST_STEP && value % REST_STEP === 0
    ? value
    : null;

// The usable fields of a stored `rest`.
function storedRest(rest) {
  const fields = {};
  if (typeof rest?.on === 'boolean') {
    fields.on = rest.on;
  }
  if (cleanRestSeconds(rest?.seconds)) {
    fields.seconds = rest.seconds;
  }
  return fields;
}

// { on, seconds }: an exercise's rest timer, with the defaults filled in.
function restSettingFor(name) {
  const rest = storedRest(library.get(exerciseKey(name))?.rest);
  return { on: rest.on ?? true, seconds: rest.seconds ?? settings.restSeconds };
}

// Saves a change ({ on } or { seconds }) to an exercise's rest timer in its library entry.
// Only `rest` is written, so nothing else on the entry can be overwritten.
function saveRestSetting(name, changes) {
  const key = exerciseKey(name);
  const existing = library.get(key);
  const rest = { ...storedRest(existing?.rest), ...changes };
  // The entry is normally made when the exercise is added to a workout; this covers a
  // library that couldn't be loaded.
  const write = existing ? { id: existing.id, rest } : { id: exerciseDocId(key), name, key, rest };
  library.set(key, { ...(existing ?? write), rest });
  fb.saveExercises(user.uid, [write]).catch(reportSaveError);
}

function setDefaultRest(seconds) {
  settings = { ...settings, restSeconds: seconds };
  fb.saveSettings(user.uid, { restSeconds: seconds }).catch(reportSaveError);
}

// ---- Hooks for push notifications (not built yet) ----
//
// Called when a rest starts on this device, and again when its end is moved with -15s or
// +15s: `endsAt` is when it ends (ms, like Date.now()) and `exerciseName` the exercise for
// "next set of ...". Each call replaces the one before, since there is only ever one rest.
// Rests started or changed on another device don't call it (that device does).
// A push service would schedule its "Rest over" notification for `endsAt`. While the app is
// open and visible it shows its own banner when the rest ends, so a push arriving then
// should not be shown as well.
function onRestScheduled(endsAt, exerciseName) {}

// Called when a rest started on this device is stopped before its end: Skip, -15s with
// less than 15 seconds left, or finishing or deleting the workout. A push service would
// cancel the scheduled notification.
function onRestCancelled() {}

// A bug in a hook must never stop a set from being logged.
function callRestHook(hook, ...args) {
  try {
    hook(...args);
  } catch (error) {
    console.error(error);
  }
}

// Saves a change to the workout's rest fields. The exercises are unchanged, so the exercise
// library needs no update.
function saveRestState(workout) {
  workouts.set(workout.id, workout);
  fb.saveWorkout(user.uid, workout).catch(reportSaveError);
  tickClocks();
}

// Starts (or restarts) a rest after a set of `name` was logged, if its timer is on. Only
// changes the workout object; the caller saves it along with the new set.
function startRest(workout, name) {
  const { on, seconds } = restSettingFor(name);
  if (!on || workout.finishedAt) {
    return;
  }
  workout.restEndsAt = Date.now() + seconds * 1000;
  workout.restExercise = name;
  hideRestBanner();
  callRestHook(onRestScheduled, workout.restEndsAt, name);
}

// The rest on the workout, if it is still running.
const isResting = (workout, now = Date.now()) => !workout.finishedAt && Number.isFinite(workout.restEndsAt) && workout.restEndsAt > now;

// Takes the rest off the workout object. Returns whether a rest was running.
function clearRest(workout) {
  const wasResting = isResting(workout);
  delete workout.restEndsAt;
  delete workout.restExercise;
  if (wasResting) {
    callRestHook(onRestCancelled);
  }
  return wasResting;
}

// Skip: ends the rest now, without the "Rest over" alert.
function skipRest(workout) {
  clearRest(workout);
  saveRestState(workout);
}

// -15s and +15s. Taking off more than is left ends the rest, like Skip.
function moveRestEnd(workout, ms) {
  // The saved copy: the rest may have been moved on another device since this screen was drawn.
  const live = workouts.get(workout.id) ?? workout;
  if (!isResting(live)) {
    return;
  }
  const endsAt = live.restEndsAt + ms;
  if (endsAt - Date.now() < 1000) {
    skipRest(workout);
    return;
  }
  workout.restEndsAt = endsAt;
  workout.restExercise = live.restExercise;
  saveRestState(workout);
  callRestHook(onRestScheduled, endsAt, workout.restExercise ?? '');
}

// ---- The ticking: the workout clock on screen, and noticing when a rest ends ----
//
// One timer drives both. It runs while the workout clock is on screen or a rest is running,
// and fires when either next changes its whole second. Browsers slow or pause timers in the
// background, so it is also run on coming back to the app.

let clock = null; // the workout clock on screen: { element, workoutId, startedAt, draw }, or null
let watchedRest = null; // the running rest: { workoutId, endsAt, name }, or null
let tickTimer = null;

// The running rest to watch, or null. There is normally at most one.
function findRunningRest(now) {
  let found = null;
  for (const workout of workouts.values()) {
    if (isResting(workout, now) && (!found || workout.restEndsAt > found.endsAt)) {
      found = { workoutId: workout.id, endsAt: workout.restEndsAt, name: workout.restExercise ?? '' };
    }
  }
  return found;
}

function tickClocks() {
  clearTimeout(tickTimer);
  tickTimer = null;
  const now = Date.now();

  if (watchedRest) {
    const workout = workouts.get(watchedRest.workoutId);
    const endsAt = workout && !workout.finishedAt ? workout.restEndsAt : null;
    if (endsAt !== watchedRest.endsAt) {
      // Skipped, moved, restarted or finished, here or on another device: no alert.
      watchedRest = null;
    } else if (now >= endsAt) {
      const { name } = watchedRest;
      watchedRest = null;
      if (now - endsAt <= REST_ALERT_GRACE) {
        restOver(name);
      }
    }
  }
  watchedRest ??= findRunningRest(now);

  if (clock && !clock.element.isConnected) {
    clock = null;
  }
  clock?.draw(now);

  const waits = [];
  if (watchedRest) {
    waits.push((watchedRest.endsAt - now) % 1000 || 1000);
  }
  if (clock) {
    waits.push(1000 - ((now - clock.startedAt) % 1000));
  }
  if (waits.length) {
    // A little after the second turns over, so the new value is already due.
    tickTimer = setTimeout(tickClocks, Math.min(...waits) + 20);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    tickClocks();
  }
});
window.addEventListener('pageshow', tickClocks);

// The clock at the top of a workout in progress: the time since it started, or while
// resting, "REST 02:29" with -15s, +15s and Skip. While resting it stays pinned under the
// header, so the buttons can be reached from anywhere on the page.
function workoutClock(workout) {
  // Focused from code when Skip (which had focus) goes away; never reached with Tab.
  const element = h('div', { class: 'workout-clock', tabindex: '-1' });
  let mode = null; // 'elapsed' or 'rest', what is drawn
  let time = null; // the element showing the digits

  const restButton = (label, name, onclick) =>
    h('button', { class: 'btn secondary', type: 'button', 'aria-label': name, onclick }, label);

  const draw = (now) => {
    // The saved copy, which follows changes made on another device.
    const live = workouts.get(workout.id) ?? workout;
    const resting = isResting(live, now);
    if (mode !== (resting ? 'rest' : 'elapsed')) {
      const hadFocus = element.contains(document.activeElement);
      mode = resting ? 'rest' : 'elapsed';
      element.classList.toggle('resting', resting);
      if (resting) {
        time = h('span', { class: 'rest-left' });
        element.replaceChildren(
          h(
            'div',
            { class: 'timer rest-timer', role: 'timer', 'aria-label': 'Rest left' },
            h('span', { class: 'rest-word', 'aria-hidden': 'true' }, 'REST'),
            time
          ),
          h(
            'div',
            { class: 'rest-controls' },
            restButton('−15s', '15 seconds less rest', () => moveRestEnd(workout, -15000)),
            restButton('+15s', '15 seconds more rest', () => moveRestEnd(workout, 15000)),
            restButton('Skip', 'Skip rest', () => skipRest(workout))
          )
        );
      } else {
        time = h('div', { class: 'timer', role: 'timer', 'aria-label': 'Elapsed time' });
        element.replaceChildren(time);
      }
      if (hadFocus) {
        element.focus({ preventScroll: true });
      }
    }
    time.textContent = resting ? formatCountdown(live.restEndsAt - now) : formatClock(now - live.startedAt);
  };

  clock = { element, workoutId: workout.id, startedAt: workout.startedAt, draw };
  draw(Date.now());
  return element;
}

// ---- When a rest ends with the app open: banner, beep, vibration ----

// Fixed under the header, on whichever screen is showing.
const restBanner = h('div', { id: 'rest-banner', role: 'alert', hidden: true });
document.body.append(restBanner);
let restBannerTimer = null;

function hideRestBanner() {
  clearTimeout(restBannerTimer);
  restBanner.hidden = true;
  restBanner.replaceChildren();
}

function showRestBanner(name) {
  clearTimeout(restBannerTimer);
  restBanner.replaceChildren(
    h('span', {}, name ? `Rest over: next set of ${name}` : 'Rest over'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: hideRestBanner }, '×')
  );
  restBanner.hidden = false;
  restBannerTimer = setTimeout(hideRestBanner, 20 * 1000);
}

function restOver(name) {
  showRestBanner(name);
  beep();
  try {
    navigator.vibrate?.([200, 100, 200]); // Android; iPhones have no vibrate()
  } catch {
    // Not allowed here; the banner and beep still happen.
  }
}

// Browsers only let a page make sound once the user has interacted with it, so the audio
// context is made (or woken, after iOS suspends it in the background) on a tap or key
// press, never before. Until then the beep is silent and the banner alone shows.
let audio = null;

function unlockAudio() {
  if (audio?.state === 'running') {
    return;
  }
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) {
    return;
  }
  try {
    audio ??= new Context();
    audio.resume().catch(() => {});
    // Older iOS only lets sound start from a sound begun inside a tap; a silent one does it.
    const source = audio.createBufferSource();
    source.buffer = audio.createBuffer(1, 1, 22050);
    source.connect(audio.destination);
    source.start(0);
  } catch {
    // No sound on this device; the banner still shows.
  }
}
// The events browsers count as the user interacting.
['pointerup', 'touchend', 'click', 'keydown'].forEach((type) =>
  document.addEventListener(type, unlockAudio, { capture: true, passive: true })
);

// Three short pips, about half a second in all.
function beep() {
  if (!audio) {
    return; // no interaction yet, so no sound is allowed
  }
  const play = () => {
    const start = audio.currentTime + 0.02;
    [0, 0.18, 0.36].forEach((offset) => {
      const at = start + offset;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = 880;
      // Faded in and out over 10 ms so it doesn't click.
      volume.gain.setValueAtTime(0, at);
      volume.gain.linearRampToValueAtTime(0.35, at + 0.01);
      volume.gain.setValueAtTime(0.35, at + 0.11);
      volume.gain.linearRampToValueAtTime(0, at + 0.12);
      tone.connect(volume).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.13);
    });
  };
  if (audio.state === 'running') {
    play();
    return;
  }
  // Suspended in the background: try to wake it, but a beep that only comes much later,
  // at the next tap, would be confusing, so give up after a moment.
  const askedAt = Date.now();
  audio
    .resume()
    .then(() => {
      if (Date.now() - askedAt < 1000) {
        play();
      }
    })
    .catch(() => {});
}

// ---- "Rest timer duration" popup: minute and second wheels ----

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// One scroll wheel. It works like a spin button: Up and Down arrows step through the
// values, Home and End go to the ends, and tapping a value scrolls it to the middle.
// `unit` names one value and many: ['minute', 'minutes'].
function wheel({ label, unit, values, value, format, onChange }) {
  let index = Math.max(0, values.indexOf(value));
  const items = values.map((item, position) =>
    h('div', { class: 'wheel-item', 'data-index': String(position), 'aria-hidden': 'true' }, format(item))
  );
  // Room above the first value and below the last, so each can scroll to the middle.
  const spacer = () => h('div', { class: 'wheel-spacer', 'aria-hidden': 'true' });
  const element = h(
    'div',
    {
      class: 'wheel',
      role: 'spinbutton',
      tabindex: '0',
      'aria-label': label,
      'aria-valuemin': String(values[0]),
      'aria-valuemax': String(values[values.length - 1]),
    },
    spacer(),
    items,
    spacer()
  );

  const rowHeight = () => items[0].getBoundingClientRect().height || 40;

  // `scroll` is false (the wheel is already there), 'auto' (jump) or 'smooth'.
  const select = (position, scroll) => {
    index = Math.max(0, Math.min(values.length - 1, position));
    element.setAttribute('aria-valuenow', String(values[index]));
    element.setAttribute('aria-valuetext', `${values[index]} ${unit[values[index] === 1 ? 0 : 1]}`);
    items.forEach((item, position) => item.classList.toggle('selected', position === index));
    if (scroll) {
      element.scrollTo({ top: index * rowHeight(), behavior: scroll });
    }
    onChange();
  };

  // Scroll snapping settles the wheel on a value; the one in the middle is the choice.
  element.addEventListener(
    'scroll',
    () => {
      const position = Math.round(element.scrollTop / rowHeight());
      if (position !== index) {
        select(position, false);
      }
    },
    { passive: true }
  );
  element.addEventListener('keydown', (event) => {
    const targets = { ArrowUp: index + 1, ArrowDown: index - 1, Home: 0, End: values.length - 1 };
    if (event.key in targets) {
      event.preventDefault();
      select(targets[event.key], 'auto');
    }
  });
  element.addEventListener('click', (event) => {
    const item = event.target.closest?.('.wheel-item');
    if (item) {
      select(Number(item.dataset.index), reducedMotion() ? 'auto' : 'smooth');
    }
  });

  select(index, false);
  return {
    element,
    get value() {
      return values[index];
    },
    // Scrolls to the starting value; only possible once the wheel is on screen.
    place: () => select(index, 'auto'),
  };
}

// Opens the popup. `subtitle` says what the length is for; `onConfirm` gets the chosen
// length in seconds. Cancel, Escape or a tap outside closes it without a change.
function pickRestLength({ subtitle, seconds, onConfirm }) {
  closeMenus();
  closePad();

  let minutes = null;
  let secs = null;
  const total = () => minutes.value * 60 + secs.value;
  const confirm = h('button', { class: 'btn grow', value: 'confirm' }, 'Confirm');
  const hint = h('p', { class: 'muted picker-hint', 'aria-live': 'polite' });
  const update = () => {
    if (!minutes || !secs) {
      return; // still being built
    }
    const tooShort = total() < REST_STEP;
    confirm.disabled = tooShort;
    hint.textContent = tooShort ? `Choose at least ${REST_STEP} seconds.` : '';
  };

  minutes = wheel({
    label: 'Minutes',
    unit: ['minute', 'minutes'],
    values: Array.from({ length: REST_MAX_MINUTES + 1 }, (_, n) => n),
    value: Math.min(REST_MAX_MINUTES, Math.floor(seconds / 60)),
    format: String,
    onChange: update,
  });
  secs = wheel({
    label: 'Seconds',
    unit: ['second', 'seconds'],
    values: Array.from({ length: 60 / REST_STEP }, (_, n) => n * REST_STEP),
    value: Math.min(60 - REST_STEP, Math.round((seconds % 60) / REST_STEP) * REST_STEP),
    format: two,
    onChange: update,
  });
  minutes.element.setAttribute('autofocus', '');
  update();

  const column = (control, unitLabel) =>
    h('div', { class: 'wheel-column' }, control.element, h('span', { class: 'wheel-unit', 'aria-hidden': 'true' }, unitLabel));

  // method="dialog": Confirm closes the popup with returnValue "confirm".
  const dialog = h(
    'dialog',
    { class: 'picker', 'aria-labelledby': 'picker-title' },
    h(
      'form',
      { method: 'dialog' },
      h('h2', { class: 'picker-title', id: 'picker-title' }, 'Rest timer duration'),
      subtitle && h('p', { class: 'muted picker-subtitle' }, subtitle),
      h('div', { class: 'wheels' }, column(minutes, 'min'), column(secs, 'sec')),
      hint,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn secondary grow', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        confirm
      )
    )
  );

  // A tap on the dimmed page around the popup closes it. Both the press and the release
  // must be outside, so a drag that starts on a wheel and ends outside doesn't.
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = event.target === dialog;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressedOutside) {
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue === 'confirm') {
      onConfirm(total());
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  minutes.place();
  secs.place();
}

// The row under an exercise's name: "Rest timer 2m 30s ✎" and an on/off switch. Both
// change the exercise's library entry, so the next workout has them too. Changes take
// effect from the next set; a rest already running carries on.
function restRow(exercise) {
  let { on, seconds } = restSettingFor(exercise.name);

  const length = h('span', {});
  const lengthButton = h('button', {
    class: 'rest-length',
    type: 'button',
    onclick: () =>
      pickRestLength({
        subtitle: exercise.name,
        seconds,
        onConfirm: (chosen) => {
          seconds = chosen;
          saveRestSetting(exercise.name, { seconds });
          show();
        },
      }),
  });
  lengthButton.append(length, icon('pencil'));

  const toggle = h(
    'button',
    {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-label': `Rest timer for ${exercise.name}`,
      onclick: () => {
        on = !on;
        saveRestSetting(exercise.name, { on });
        show();
      },
    },
    h('span', { class: 'switch-knob' })
  );

  const row = h('div', { class: 'rest-row' }, h('span', { class: 'rest-label' }, 'Rest timer'), lengthButton, toggle);
  const show = () => {
    row.classList.toggle('off', !on);
    length.textContent = formatRestLength(seconds);
    lengthButton.setAttribute('aria-label', `Rest timer duration for ${exercise.name}: ${restLengthWords(seconds)}. Change`);
    toggle.setAttribute('aria-checked', String(on));
  };
  show();
  return row;
}

function renderWorkout(workout, focusSelector, openPadOnFocus = false) {
  rememberOpenSetValues();
  clock = null;
  closePad();
  closeExerciseList?.();
  if (openSet && !workout.exercises.some((exercise) => exercise.id === openSet.exerciseId)) {
    openSet = null; // its exercise was removed
  }

  const redraw = (nextFocus, withPad = false) => renderWorkout(workout, nextFocus, withPad);
  // libraryChanges: see saveWorkout.
  const commit = (nextFocus, libraryChanges) => {
    saveWorkout(workout, libraryChanges);
    redraw(nextFocus);
  };

  // What the workouts before this one say about its exercises, for the "Last:" line.
  const earlier = deriveLibrary(
    [...workouts.values()].filter((other) => other.id !== workout.id && (other.startedAt || 0) <= (workout.startedAt || 0)),
    new Set(workout.exercises.map((exercise) => exerciseKey(exercise.name)))
  );

  const exerciseCards = workout.exercises.map((exercise) => {
    const last = exercise.sets[exercise.sets.length - 1];
    const card = `.exercise[data-id="${exercise.id}"]`;
    // How many sets the outline this workout was started from had, while there are fewer.
    const planned = exercise.plannedSets > exercise.sets.length ? exercise.plannedSets : 0;

    // "Last: 135 lb × 8" or "Max: 155 lb × 5"; pressing it switches between the two.
    // Last is the most recent set from before this workout. Max is the heaviest set ever,
    // this workout included. Not shown for an exercise with no sets before this workout.
    // Both follow the hand edits from the Exercise data page (an edited Last shows until a
    // set logged after the edit is in an earlier workout).
    const setHint = () => {
      const key = exerciseKey(exercise.name);
      const previous = earlier.has(key) ? earlier.get(key).last : editedStats(library.get(key)).last;
      const max = library.get(key)?.max;
      if (!previous || !max) {
        return null;
      }
      const showMax = settings.setHint === 'max';
      const text = `${showMax ? 'Max' : 'Last'}: ${formatSet(showMax ? max : previous)}`;
      return h(
        'div',
        { class: 'set-hint-row' },
        h(
          'button',
          {
            class: 'set-hint',
            type: 'button',
            'aria-label': `${text}. Show ${showMax ? 'last set' : 'heaviest set'} instead.`,
            onclick: () => {
              setSetHint(showMax ? 'last' : 'max');
              redraw(`${card} .set-hint`);
            },
          },
          h('span', {}, text),
          icon('swap')
        )
      );
    };

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
          pattern: WEIGHT_PATTERN,
          title: 'A number, for example 62.5',
          placeholder: '0',
          value: openSet.weight || null,
        },
        'weight',
        { next: () => repsInput } // Enter and the pad's "Next" move on to reps
      );
      const repsInput = padInput(
        {
          name: 'reps',
          enterkeyhint: 'done',
          pattern: REPS_PATTERN,
          title: 'A whole number, 1 or more',
          required: true,
          value: openSet.reps || null,
        },
        'reps',
        { action: 'Add set' }
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
            // `at`: when it was logged, which decides whether it counts towards hand-edited
            // stats in the exercise library.
            exercise.sets.push({ id: newId(), weight, unit, reps, at: Date.now() });
            // Starts the rest, or starts it again, if this exercise's timer is on. Saved
            // with the set below.
            startRest(workout, exercise.name);
            openSet = null; // back to the "+ Add set" button; the next set is opened by hand
            commit(`${card} .open-set`, { used: [exercise.name] });
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
              commit(null, { removed: [exercise.name] });
            },
          },
          '×'
        )
      ),
      // Rests only happen in a workout in progress.
      !workout.finishedAt && restRow(exercise),
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
        : h('p', { class: 'muted' }, planned ? `No sets yet · ${plural(planned, 'set')} planned` : 'No sets yet.'),
      planned > 0 &&
        exercise.sets.length > 0 &&
        h('p', { class: 'muted planned' }, `${exercise.sets.length} of ${planned} planned sets`),
      setHint(),
      openSet?.exerciseId === exercise.id ? setRow() : openButton()
    );
  });

  const addExercise = addExerciseForm(workout, (typed) => {
    // A name that differs only in case or spacing from one in the library is that exercise,
    // and takes the library's spelling.
    const name = library.get(exerciseKey(typed))?.name ?? typed;
    const exercise = { id: newId(), name, sets: [] };
    workout.exercises.push(exercise);
    commit(`.exercise[data-id="${exercise.id}"] .open-set`, { used: [name] });
  });

  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← All workouts'),
    ...(workout.finishedAt ? [] : [workoutClock(workout)]),
    h('h1', {}, workoutLabel(workout)),
    h(
      'div',
      { class: 'row workout-meta' },
      h(
        'p',
        { class: 'muted grow' },
        [
          workout.name && formatDateTime(workout.startedAt),
          workout.finishedAt ? `Finished · ${workoutDuration(workout)}` : 'In progress',
          summary(workout),
        ]
          .filter(Boolean)
          .join(' · ')
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
              clearRest(workout);
              workout.finishedAt = Date.now();
              saveWorkout(workout);
              location.hash = `#/done/${workout.id}`;
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
            if (!confirm(`Delete the workout from ${workoutLabel(workout)}? This can't be undone.`)) {
              return;
            }
            clearRest(workout);
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
  // Keeps the new clock ticking, and picks up a rest the set just started.
  tickClocks();
}

// ---------- Workout completed ----------

// The exercises in this workout that went better than in the last workout before it that
// has them: a heavier top set, or more reps at the same top weight. An exercise being done
// for the first time has nothing to compare with and is not listed.
// Returns [{ name, before, top, best }], the two top sets and whether `top` is now the
// heaviest set in the library (the all-time best).
function improvements(workout) {
  const setsFor = (other, key) =>
    (Array.isArray(other.exercises) ? other.exercises : [])
      .filter((exercise) => exerciseKey(exercise?.name) === key)
      .flatMap((exercise) => (Array.isArray(exercise.sets) ? exercise.sets : []))
      .filter((set) => set && Number.isFinite(set.weight) && Number.isFinite(set.reps));
  const topOf = (sets) => sets.reduce((best, set) => (beats(set, best) ? set : best), null);

  const earlier = [...workouts.values()]
    .filter((other) => other.id !== workout.id && (other.startedAt || 0) <= (workout.startedAt || 0))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  const improved = [];
  const seen = new Set();
  for (const exercise of workout.exercises) {
    const key = exerciseKey(exercise.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const top = topOf(setsFor(workout, key));
    const previous = top && earlier.map((other) => setsFor(other, key)).find((sets) => sets.length);
    const before = previous && topOf(previous);
    if (before && beats(top, before)) {
      // The library's max carries the date of the workout it is in.
      const max = library.get(key)?.max;
      const best = Boolean(max && max.date === workout.startedAt && !beats(max, top));
      improved.push({ name: exercise.name, before, top, best });
    }
  }
  return improved;
}

// outlineState: undefined (just the button), 'naming' (the name form is open), or
// { saved: name } once an outline has been saved.
function renderDone(workout, outlineState) {
  const improved = improvements(workout);

  const nameInput = h('input', {
    name: 'outline',
    placeholder: 'e.g. Push day',
    'aria-label': 'Outline name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
  });
  let outlineBox;
  if (outlineState?.saved) {
    outlineBox = h('p', { class: 'muted status', role: 'status' }, `Saved "${outlineState.saved}". Start it from the home screen.`);
  } else if (outlineState === 'naming') {
    outlineBox = h(
      'form',
      {
        class: 'card save-outline',
        onsubmit: (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          if (!name) {
            return;
          }
          saveOutline({
            id: newId(),
            name,
            createdAt: Date.now(),
            exercises: workout.exercises.map((exercise) => ({ name: exercise.name, sets: exercise.sets.length })),
          });
          renderDone(workout, { saved: name });
        },
      },
      h('p', { class: 'muted' }, `Saves these exercises and how many sets each had: ${exerciseNames(workout).join(', ')}.`),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput), h('button', { class: 'btn' }, 'Save'))
    );
  } else {
    outlineBox = h(
      'button',
      {
        class: 'btn secondary block',
        type: 'button',
        disabled: workout.exercises.length === 0,
        onclick: () => renderDone(workout, 'naming'),
      },
      'Save as outline'
    );
  }

  view.replaceChildren(
    h('h1', {}, 'Workout completed'),
    h('p', { class: 'muted done-when' }, workoutLabel(workout)),
    h(
      'div',
      { class: 'card total-time' },
      h('span', { class: 'muted' }, 'Total time'),
      h('strong', {}, workoutDuration(workout)),
      h('span', { class: 'muted' }, summary(workout))
    ),
    h('h2', {}, 'Improved'),
    improved.length
      ? h(
          'ul',
          { class: 'card improved' },
          improved.map(({ name, before, top, best }) =>
            h(
              'li',
              {},
              h('strong', {}, `${name}: `),
              `${formatSet(before)} → ${formatSet(top)}`,
              best && h('span', { class: 'badge' }, 'All-time best')
            )
          )
        )
      : h('p', { class: 'muted' }, 'Nothing beat last time today, and that is fine. You showed up and did the work.'),
    h('div', { class: 'actions' }, outlineBox, h('a', { class: 'btn block', href: '#/' }, 'Done'))
  );
  if (outlineState === 'naming') {
    nameInput.focus();
  }
}

// ---------- Exercise data: each exercise's Max and Last, with hand edits ----------
//
// The exercise library, most recently used first, with a search box. Each exercise has a
// menu: Edit (its Max and Last sets, typed with the number pad), Clear stats and Remove from
// list. These change only the library entry, never a workout; see the Exercise library
// section for how the edits are stored and kept.

// Kept while the page is redrawn; cleared when another screen is opened (see route).
let exerciseQuery = ''; // what is typed in the search box
let editingExercise = null; // key of the exercise whose stats are being edited, or null
let exerciseStatus = ''; // the message under the search box

// Applies hand-made changes (`manual`, `last`, `max`, `hidden`) to one library entry.
function saveLibraryChanges(key, changes) {
  const entry = { ...library.get(key), ...changes };
  library.set(key, entry);
  fb.saveExercises(user.uid, [{ id: entry.id, ...changes }]).catch(reportSaveError);
}

// { last, max } of an exercise with the given hand edits, worked out from the workouts.
function statsWith(key, manual) {
  const entry = { ...library.get(key), manual };
  const found = deriveLibrary(workouts.values(), new Set([key]), new Map([[key, entry]])).get(key);
  return found ? { last: found.last, max: found.max } : editedStats(entry);
}

// One stat in the editor: the weight, the unit it was logged in and the reps of the Max or
// the Last set, filled in with the set exactly as it was logged (its own number and unit,
// which can differ from the unit the list shows it in). `next` gives the field that comes
// after this stat's reps; without it, the reps field's pad key saves.
function statFields(label, which, record, next) {
  const before = {
    weight: record ? String(record.weight) : '',
    unit: record ? unitOf(record) : settings.unit,
    reps: record ? String(record.reps) : '',
  };
  let unit = before.unit;

  const weight = padInput(
    { name: `${which}Weight`, pattern: WEIGHT_PATTERN, title: 'A number, for example 62.5', placeholder: '0', value: before.weight || null },
    'weight',
    { next: () => reps }
  );
  const reps = padInput(
    { name: `${which}Reps`, pattern: REPS_PATTERN, title: 'A whole number, 1 or more', value: before.reps || null },
    'reps',
    next ? { next } : { action: 'Save' }
  );
  // Emptying both fields empties the stat. A weight needs reps; reps with no weight is
  // bodyweight, as when adding a set.
  const needReps = () => {
    reps.required = weight.value !== '';
  };
  needReps();

  // Once the unit has been switched: what the set will be saved as, in both units, for
  // example "135 kg (≈ 297.6 lb)". Empty otherwise, and while there is no weight.
  const result = h('p', { class: 'unit-result', 'aria-live': 'polite' });
  const showResult = () => {
    const value = Number(weight.value);
    const other = UNITS.find((option) => option !== unit);
    result.textContent =
      unit !== before.unit && value > 0 ? `${value} ${unit} (≈ ${roundForDisplay(convertWeight(value, unit, other))} ${other})` : '';
  };
  weight.addEventListener('input', () => {
    needReps();
    showResult();
  });

  // "Logged in: lb / kg": the unit the number was logged in. Switching it keeps the number
  // and changes only its unit, which fixes a set saved in the wrong unit.
  const unitButtons = UNITS.map((option) =>
    h(
      'button',
      {
        class: 'unit-option',
        type: 'button',
        'aria-pressed': String(option === unit),
        onclick: () => {
          unit = option;
          unitButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.textContent === unit)));
          showResult();
        },
      },
      option
    )
  );

  // { unchanged: true }, or { set } with the stat's new set (null to empty it). Only called
  // once the browser has checked the fields.
  const read = () => {
    const weightValue = weight.value.trim();
    const repsValue = reps.value.trim();
    if (weightValue === before.weight && unit === before.unit && repsValue === before.reps) {
      return { unchanged: true };
    }
    if (!weightValue && !repsValue) {
      return { set: null };
    }
    return { set: { weight: Number(weightValue) || 0, unit, reps: Math.max(1, Math.floor(Number(repsValue))) } };
  };

  // Only one editor is open at a time, so these ids are unique on the page.
  const unitLabelId = `stat-${which}-unit`;
  const unitHintId = `stat-${which}-unit-hint`;
  const element = h(
    'fieldset',
    { class: 'stat-fields' },
    h('legend', {}, label),
    h('div', { class: 'stat-row' }, h('label', {}, 'Weight', weight), h('label', {}, 'Reps', reps)),
    h(
      'div',
      { class: 'unit-line' },
      h('span', { id: unitLabelId }, 'Logged in:'),
      h('div', { class: 'unit-toggle', role: 'group', 'aria-labelledby': unitLabelId, 'aria-describedby': unitHintId }, unitButtons)
    ),
    h('p', { class: 'muted unit-hint', id: unitHintId }, 'Changes the unit only, not the number. Use this to fix a set saved in the wrong unit.'),
    result
  );
  return { element, first: weight, read };
}

// The form for editing an exercise's Max and Last. `done` is called with the message to
// show (empty when nothing changed or it was cancelled).
function statsEditor(entry, done) {
  let lastStat = null;
  const maxStat = statFields('Max', 'max', entry.max, () => lastStat.first);
  lastStat = statFields('Last', 'last', entry.last, null);

  return h(
    'form',
    {
      class: 'stats-editor',
      onsubmit: (event) => {
        event.preventDefault();
        const manual = manualEdits(entry);
        const at = Date.now();
        let changed = false;
        for (const [which, stat] of [
          ['max', maxStat],
          ['last', lastStat],
        ]) {
          const result = stat.read();
          if (!result.unchanged) {
            manual[which] = { at, set: result.set };
            changed = true;
          }
        }
        if (changed) {
          saveLibraryChanges(entry.key, { manual, ...statsWith(entry.key, manual) });
        }
        done(changed ? `Saved ${entry.name}.` : '');
      },
    },
    maxStat.element,
    lastStat.element,
    h('p', { class: 'muted' }, 'An edited Max stays until a new set beats it. An edited Last is replaced by the next set you log.'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn grow' }, 'Save'),
      h('button', { class: 'btn secondary grow', type: 'button', onclick: () => done('') }, 'Cancel')
    )
  );
}

const statLine = (label, record) => [
  h('dt', {}, label),
  h(
    'dd',
    {},
    record ? formatSet(record) : h('span', { class: 'muted' }, 'None'),
    record?.edited && h('span', { class: 'muted edited' }, ' · edited')
  ),
];

function renderExerciseData() {
  const heading = h('h1', { tabindex: '-1' }, 'Exercise data');
  const search = h('input', {
    type: 'search',
    class: 'exercise-search',
    placeholder: 'Search exercises',
    'aria-label': 'Search exercises',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: exerciseQuery || null,
    oninput: () => {
      exerciseQuery = search.value;
      editingExercise = null;
      exerciseStatus = '';
      drawList();
    },
    // Enter puts the phone keyboard away; the list is already filtered.
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        search.blur();
      }
    },
  });
  // Always in the page, so screen readers announce what is put in it.
  const status = h('p', { class: 'muted status exercise-status', role: 'status' });
  const list = h('ul', { class: 'exercise-data-list', 'aria-label': 'Exercises' });
  const empty = h('p', { class: 'muted' });

  const cardOf = (key) => [...list.children].find((item) => item.dataset.key === key);
  const menuButtonOf = (item) => item?.querySelector('.dropdown > button');

  const finishEditing = (key) => (message) => {
    editingExercise = null;
    exerciseStatus = message;
    drawList();
    menuButtonOf(cardOf(key))?.focus();
  };

  const edit = (entry) => {
    editingExercise = entry.key;
    exerciseStatus = '';
    drawList();
    // The Max weight, with the pad open on it.
    cardOf(entry.key)?.querySelector('input')?.focus();
  };

  const clearStats = (entry) => {
    if (!confirm(`Clear the Max and Last of ${entry.name}? They stay empty until you log a new set. Your workouts and history are not changed.`)) {
      return;
    }
    const at = Date.now();
    const manual = { max: { at, set: null }, last: { at, set: null } };
    saveLibraryChanges(entry.key, { manual, ...statsWith(entry.key, manual) });
    exerciseStatus = `Cleared the stats of ${entry.name}.`;
    drawList();
    menuButtonOf(cardOf(entry.key))?.focus();
  };

  const remove = (entry) => {
    if (
      !confirm(
        `Remove ${entry.name} from your exercise list? It won't be suggested when you add an exercise. Logging it again brings it back. Your workouts and history are not changed.`
      )
    ) {
      return;
    }
    const index = [...list.children].indexOf(cardOf(entry.key));
    saveLibraryChanges(entry.key, { hidden: true });
    exerciseStatus = `Removed ${entry.name} from the list.`;
    drawList();
    // Focus goes to the exercise that took its place, or the one before it.
    (menuButtonOf(list.children[index] ?? list.children[index - 1]) ?? heading).focus();
  };

  const card = (entry) => {
    const editing = editingExercise === entry.key;
    const actions =
      !editing &&
      dropdown(h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Options for ${entry.name}`, title: 'Options' }, icon('more')), [
        { label: 'Edit', onSelect: () => edit(entry) },
        { label: 'Clear stats', destructive: true, disabled: !entry.max && !entry.last, onSelect: () => clearStats(entry) },
        { label: 'Remove from list', destructive: true, onSelect: () => remove(entry) },
      ]);
    return h(
      'li',
      { class: 'card exercise-data', 'data-key': entry.key },
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, entry.name), actions && actions.element),
      editing ? statsEditor(entry, finishEditing(entry.key)) : h('dl', { class: 'stats' }, statLine('Max', entry.max), statLine('Last', entry.last))
    );
  };

  function drawList() {
    closePad();
    // A menu on one of the cards about to be replaced; one in the header can stay open.
    if (openMenu && list.contains(openMenu.element)) {
      closeMenus();
    }
    const all = [...library.values()]
      .filter((entry) => !entry.hidden)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
    const typed = exerciseKey(exerciseQuery);
    const shown = all.filter((entry) => entry.key.includes(typed));
    status.textContent = exerciseStatus;
    list.replaceChildren(...shown.map(card));
    empty.textContent = !all.length
      ? 'No exercises yet. Exercises you add to a workout show up here.'
      : `No exercises match "${exerciseQuery.trim()}".`;
    empty.hidden = shown.length > 0;
  }

  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← Back'),
    heading,
    h('p', { class: 'muted exercise-intro' }, "Max is your heaviest set and Last your most recent. Changes here don't change any workout."),
    search,
    status,
    list,
    empty
  );
  drawList();
}

// ---------- Settings: account and backup ----------

const BACKUP_FORMAT = 'gym-workouts';

const backupCounts = ({ workouts: workoutCount, outlines: outlineCount }) =>
  outlineCount ? `${plural(workoutCount, 'workout')} and ${plural(outlineCount, 'outline')}` : plural(workoutCount, 'workout');

// Downloads the backup file and returns how many workouts and outlines are in it.
function exportWorkouts() {
  const backup = {
    format: BACKUP_FORMAT,
    // 2 adds a unit on every set, and the unit setting. Version 1 files were all kg.
    // 3 adds the outlines.
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: { unit: settings.unit },
    workouts: [...workouts.values()].map((workout) => ({
      ...workout,
      exercises: workout.exercises.map((exercise) => ({
        ...exercise,
        sets: exercise.sets.map((set) => ({ ...set, unit: unitOf(set) })),
      })),
    })),
    outlines: [...outlines.values()],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: `gym-workouts-${backup.exportedAt.slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { workouts: backup.workouts.length, outlines: backup.outlines.length };
}

// Returns clean workouts and outlines, or throws if the file isn't a backup. Files from
// before outlines were backed up have none; an outline that can't be read is skipped.
function parseBackup(text) {
  const data = JSON.parse(text);
  const items = Array.isArray(data) ? data : data?.workouts;
  if (!Array.isArray(items)) {
    throw new Error('No workouts list in file');
  }
  return {
    workouts: items.map(cleanWorkout),
    outlines: (Array.isArray(data?.outlines) ? data.outlines : []).map(cleanOutline).filter(Boolean),
  };
}

// Merges the file into the account: a workout or outline with the same id is replaced, the
// rest are kept. Returns how many of each were in the file.
async function importWorkouts(file) {
  const backup = parseBackup(await file.text());
  saveWorkouts(backup.workouts);
  backup.outlines.forEach(saveOutline);
  return { workouts: backup.workouts.length, outlines: backup.outlines.length };
}

// One saved outline on the Settings screen: its name in a box to rename it, and a delete button.
function outlineSettingsCard(outline) {
  const nameInput = h('input', {
    name: 'name',
    value: outline.name,
    'aria-label': 'Outline name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
  });
  return h(
    'form',
    {
      class: 'card outline-edit',
      onsubmit: (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) {
          return;
        }
        if (name !== outline.name) {
          saveOutline({ ...outline, name });
          renderSettings(null, `Renamed to "${name}".`);
        }
      },
    },
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }, nameInput),
      h('button', { class: 'btn secondary' }, 'Rename'),
      h(
        'button',
        {
          class: 'icon-btn destructive',
          type: 'button',
          'aria-label': `Delete outline ${outline.name}`,
          onclick: () => {
            if (!confirm(`Delete the outline "${outline.name}"? Workouts started from it are kept.`)) {
              return;
            }
            deleteOutline(outline.id);
            renderSettings(null, `Deleted "${outline.name}".`);
          },
        },
        '×'
      )
    ),
    h('p', { class: 'muted' }, outlineSummary(outline))
  );
}

// The default rest timer length, used by every exercise that hasn't been given its own.
function defaultRestCard() {
  const length = h('span', {});
  const button = h('button', {
    class: 'rest-length default-rest',
    type: 'button',
    onclick: () =>
      pickRestLength({
        subtitle: 'Default for exercises without their own',
        seconds: settings.restSeconds,
        onConfirm: (seconds) => {
          setDefaultRest(seconds);
          show();
        },
      }),
  });
  button.append(length, icon('pencil'));
  const show = () => {
    length.textContent = formatRestLength(settings.restSeconds);
    button.setAttribute('aria-label', `Default rest timer: ${restLengthWords(settings.restSeconds)}. Change`);
  };
  show();
  return h(
    'div',
    { class: 'card rest-settings' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Default length'), button),
    h(
      'p',
      { class: 'muted' },
      "Used by exercises you haven't set a length for. Logging a set starts the rest; change an exercise's own length, or switch its timer off, under its name in a workout."
    )
  );
}

function renderSettings(backupMessage, outlineMessage) {
  const saved = sortedOutlines();
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
        renderSettings({ text: `Imported ${backupCounts(await importWorkouts(file))}.` });
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
    h('h2', {}, 'Rest timer'),
    defaultRestCard(),
    h('h2', {}, 'Outlines'),
    ...(saved.length
      ? saved.map(outlineSettingsCard)
      : [h('p', { class: 'muted' }, 'No outlines yet. Finish a workout and choose "Save as outline" to make one.')]),
    ...(outlineMessage ? [h('p', { class: 'muted status', role: 'status' }, outlineMessage)] : []),
    h('h2', {}, 'Backup'),
    h(
      'div',
      { class: 'card backup' },
      h('p', { class: 'muted' }, 'Download a copy of all your workouts and outlines as a file, or load one back in.'),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn secondary grow export',
            type: 'button',
            disabled: workouts.size === 0 && outlines.size === 0,
            onclick: () => renderSettings({ text: `Exported ${backupCounts(exportWorkouts())}.` }),
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
const onListScreen = () => ['', '#', '#/', '#/history'].includes(location.hash);

let shownHash = null; // the address of the screen last routed to, to tell opening from redrawing

function route() {
  const newScreen = location.hash !== shownHash;
  shownHash = location.hash;
  if (newScreen) {
    // A redraw of the same screen (new data arriving) leaves an open header menu open.
    closeMenus();
    exerciseQuery = '';
    editingExercise = null;
    exerciseStatus = '';
  }
  clock = null; // renderWorkout makes a new one
  closePad();
  closeExerciseList?.();
  updateHeaderState();
  openSet = null;
  if (!fb) {
    return;
  }
  if (!user) {
    renderSignedOut();
    return;
  }
  if (!workoutsReady || !settingsReady || !libraryReady || !outlinesReady) {
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
  if (location.hash === '#/exercises') {
    renderExerciseData();
    if (newScreen) {
      window.scrollTo(0, 0);
    }
    return;
  }
  const match = location.hash.match(/^#\/(workout|done)\/(.+)$/);
  if (match) {
    const workout = workouts.get(decodeURIComponent(match[2]));
    if (workout) {
      // The "Workout completed" page only exists for a finished workout.
      if (match[1] === 'done' && workout.finishedAt) {
        renderDone(workout);
      } else {
        renderWorkout(workout);
      }
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
  settings = { ...DEFAULT_SETTINGS };
  settingsReady = false;
  library = new Map();
  libraryReady = false;
  outlines = new Map();
  outlinesReady = false;
  watchedRest = null;
  hideRestBanner();
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
      if (first || onListScreen()) {
        route();
      }
      // A rest started, moved or skipped on another device, or one running at launch.
      tickClocks();
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
  const settingsLoaded = ({ unit, setHint, restSeconds }) => {
    const first = !settingsReady;
    settingsReady = true;
    // false for the echo of a change made here
    const changed = unit !== settings.unit || setHint !== settings.setHint || restSeconds !== settings.restSeconds;
    settings = { ...settings, unit, setHint, restSeconds };
    if (first || changed) {
      route();
    }
  };
  const stopSettings = fb.watchSettings(
    uid,
    (saved) => {
      const first = !settingsReady;
      // Nothing saved yet means the defaults.
      settingsLoaded({
        unit: saved.unit === 'kg' ? 'kg' : 'lb',
        setHint: saved.setHint === 'max' ? 'max' : 'last',
        restSeconds: cleanRestSeconds(saved.restSeconds) ?? DEFAULT_SETTINGS.restSeconds,
      });
      if (first && !saved.libraryBuilt) {
        buildLibrary(uid);
      }
    },
    (error) => {
      console.error(error);
      settingsLoaded(settings); // carry on with what we have
    }
  );
  const libraryLoaded = (list) => {
    library = new Map();
    for (const item of list) {
      const key = typeof item.name === 'string' ? exerciseKey(item.name) : '';
      if (key) {
        library.set(key, { ...item, key, lastUsedAt: item.lastUsedAt || 0 });
      }
    }
    // Later changes are picked up the next time a screen is drawn; nothing is redrawn here.
    if (!libraryReady) {
      libraryReady = true;
      route();
    }
  };
  const stopLibrary = fb.watchExercises(uid, libraryLoaded, (error) => {
    console.error(error);
    libraryLoaded([]); // the app still works without suggestions
  });
  const outlinesLoaded = (list) => {
    outlines = new Map(
      list
        .map(cleanOutline)
        .filter(Boolean)
        .map((outline) => [outline.id, outline])
    );
    const first = !outlinesReady;
    outlinesReady = true;
    if (first || onListScreen()) {
      route();
    }
  };
  const stopOutlines = fb.watchOutlines(uid, outlinesLoaded, (error) => {
    console.error(error);
    outlinesLoaded([]); // the app still works without outlines
  });
  stopWatching = () => {
    stopWorkouts();
    stopSettings();
    stopLibrary();
    stopOutlines();
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
