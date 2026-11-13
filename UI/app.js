// ---------- Storage (IndexedDB, on this device only) ----------

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('gym', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('workouts', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function withStore(mode, action) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workouts', mode);
    const request = action(tx.objectStore('workouts'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const listWorkouts = () => withStore('readonly', (store) => store.getAll());
const getWorkout = (id) => withStore('readonly', (store) => store.get(id));
const saveWorkout = (workout) => withStore('readwrite', (store) => store.put(workout));
const deleteWorkout = (id) => withStore('readwrite', (store) => store.delete(id));
const saveWorkouts = (workouts) =>
  withStore('readwrite', (store) => {
    workouts.forEach((workout) => store.put(workout));
  });

// Ask the browser not to evict this site's data when the device runs low on space.
navigator.storage?.persist?.().catch(() => {});

// ---------- Backup: export to / import from a JSON file ----------

const BACKUP_FORMAT = 'gym-workouts';

async function exportWorkouts() {
  const backup = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    workouts: await listWorkouts(),
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

  const text60 = (value) => String(value).trim().slice(0, 60);
  const timestamp = (value) => (Number.isFinite(value) && value > 0 ? value : null);

  return items.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !text60(item.name)) {
      throw new Error('Workout is missing an id or name');
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
  });
}

// Merges the file into what's already here: same id is replaced, everything else is kept.
async function importWorkouts(file) {
  const workouts = parseBackup(await file.text());
  await saveWorkouts(workouts);
  return workouts.length;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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

// ---------- Home: start a workout, see past ones ----------

function renderHome(workouts, backupMessage) {
  workouts.sort((a, b) => b.startedAt - a.startedAt);

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) {
        return;
      }
      let message;
      try {
        message = { text: `Imported ${plural(await importWorkouts(file), 'workout')}.` };
      } catch (error) {
        console.error(error);
        message = { text: "Couldn't import that file. It doesn't look like a Gym export.", error: true };
      }
      renderHome(await listWorkouts(), message);
    },
  });

  const backup = h(
    'div',
    { class: 'card backup' },
    h('p', { class: 'muted' }, 'Workouts are stored only on this device. Export a file to keep a copy or move them.'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn secondary grow export',
          type: 'button',
          disabled: workouts.length === 0,
          onclick: async () => {
            const count = await exportWorkouts();
            renderHome(await listWorkouts(), { text: `Exported ${plural(count, 'workout')}.` });
          },
        },
        'Export'
      ),
      h('button', { class: 'btn secondary grow import', type: 'button', onclick: () => fileInput.click() }, 'Import'),
      fileInput
    ),
    backupMessage &&
      h('p', { class: backupMessage.error ? 'error status' : 'muted status', role: 'status' }, backupMessage.text)
  );

  const nameInput = h('input', {
    name: 'name',
    placeholder: 'e.g. Push day',
    'aria-label': 'Workout name',
    maxlength: '60',
    autocomplete: 'off',
    required: true,
  });

  const form = h(
    'form',
    {
      class: 'card new-workout',
      onsubmit: async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) {
          return;
        }
        const workout = { id: newId(), name, startedAt: Date.now(), finishedAt: null, exercises: [] };
        await saveWorkout(workout);
        location.hash = `#/workout/${workout.id}`;
      },
    },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput), h('button', { class: 'btn' }, 'Start'))
  );

  const list = workouts.length
    ? workouts.map((workout) =>
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
    : h('p', { class: 'muted' }, 'No workouts yet. Name one above to start logging.');

  view.replaceChildren(
    h('h2', {}, 'New workout'),
    form,
    h('h2', {}, 'History'),
    ...[list].flat(),
    h('h2', {}, 'Backup'),
    backup
  );
}

// ---------- Workout: exercises and sets ----------

function renderWorkout(workout, focusSelector) {
  const commit = async (nextFocus) => {
    await saveWorkout(workout);
    renderWorkout(workout, nextFocus);
  };

  const exerciseCards = workout.exercises.map((exercise) => {
    const last = exercise.sets[exercise.sets.length - 1];
    const weightInput = h('input', {
      name: 'weight',
      type: 'number',
      inputmode: 'decimal',
      min: '0',
      step: 'any',
      placeholder: '0',
      value: last ? String(last.weight) : null,
    });
    const repsInput = h('input', {
      name: 'reps',
      type: 'number',
      inputmode: 'numeric',
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
            onclick: async () => {
              workout.finishedAt = Date.now();
              await saveWorkout(workout);
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
          onclick: async () => {
            if (!confirm(`Delete "${workout.name}"? This can't be undone.`)) {
              return;
            }
            await deleteWorkout(workout.id);
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

// ---------- Routing ----------

async function route() {
  try {
    const match = location.hash.match(/^#\/workout\/(.+)$/);
    if (match) {
      const workout = await getWorkout(decodeURIComponent(match[1]));
      if (workout) {
        renderWorkout(workout);
        window.scrollTo(0, 0);
        return;
      }
      history.replaceState(null, '', '#/');
    }
    renderHome(await listWorkouts());
  } catch (error) {
    console.error(error);
    view.replaceChildren(
      h('p', { class: 'error' }, "Couldn't open this device's storage, so workouts can't be saved. Private browsing can cause this.")
    );
  }
}

window.addEventListener('hashchange', route);
route();

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
