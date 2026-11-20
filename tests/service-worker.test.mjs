// The service worker must pick up a new upload even though the web host lets browsers keep
// JS and CSS for a week (Cache-Control: max-age=604800). Run with `node --test tests/`.
//
// UI/service-worker.js runs here against a pretend browser: Cache Storage, and a network with
// the browser's own HTTP cache in front of it. A request with the default cache mode gets the
// browser's stored copy while it is within its week, as on a phone; "no-cache", "reload" or
// "no-store" go to the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://gym.example';
const SOURCE = readFileSync(new URL('../UI/service-worker.js', import.meta.url), 'utf8');

function pretendBrowser({ server, httpCache }) {
  const absolute = (input) => new URL(typeof input === 'string' ? input : input.url, `${ORIGIN}/`).href;
  const withoutQuery = (url) => url.split('?')[0];

  // Requests made with a relative URL resolve against the service worker's own address.
  class SwRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' ? absolute(input) : input, init);
    }
  }

  const fetchLog = [];
  const network = { offline: false };
  async function fetch(input, init = {}) {
    if (network.offline) {
      throw new TypeError('Failed to fetch');
    }
    const request = input instanceof Request ? new SwRequest(input, init) : new SwRequest(input, init);
    const url = withoutQuery(request.url);
    fetchLog.push({ url, cache: request.cache });
    const useHttpCache = request.cache === 'default' || request.cache === 'force-cache' || request.cache === 'only-if-cached';
    const body = useHttpCache && httpCache.has(url) ? httpCache.get(url) : server.get(url);
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    httpCache.set(url, body);
    return new Response(body, { status: 200 });
  }

  const stores = new Map(); // cache name -> Map(url -> body)
  const cacheObject = (entries) => ({
    async addAll(requests) {
      const responses = await Promise.all(requests.map((item) => fetch(item)));
      if (responses.some((response) => !response.ok)) {
        throw new TypeError('addAll: a request failed');
      }
      await Promise.all(responses.map(async (response, i) => entries.set(absolute(requests[i]), await response.text())));
    },
    async put(request, response) {
      entries.set(absolute(request), await response.text());
    },
    async match(request) {
      const url = absolute(request);
      return entries.has(url) ? new Response(entries.get(url)) : undefined;
    },
  });
  const caches = {
    async open(name) {
      if (!stores.has(name)) {
        stores.set(name, new Map());
      }
      return cacheObject(stores.get(name));
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request) {
      for (const entries of stores.values()) {
        const found = await cacheObject(entries).match(request);
        if (found) {
          return found;
        }
      }
      return undefined;
    },
  };

  // Loads a version of service-worker.js, as the browser does when it finds a new one.
  function loadWorker(source) {
    const handlers = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (type, handler) => (handlers[type] = handler),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    };
    vm.runInNewContext(source, { self, caches, fetch, Request: SwRequest, Response, URL, Set, Promise, console });
    return {
      async install() {
        let done;
        handlers.install({ waitUntil: (promise) => (done = promise) });
        await done;
      },
      async activate() {
        let done;
        handlers.activate({ waitUntil: (promise) => (done = promise) });
        await done;
      },
      // A request from the page; returns the body it is answered with.
      async request(path) {
        let answer;
        handlers.fetch({ request: new SwRequest(path), respondWith: (promise) => (answer = promise) });
        const response = await answer;
        // Let the background refresh finish.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return response.text();
      },
    };
  }

  return { loadWorker, caches, fetchLog, network };
}

const bumped = (source) => source.replace(/const CACHE_NAME = 'gym-pwa-v(\d+)';/, (_, n) => `const CACHE_NAME = 'gym-pwa-v${Number(n) + 1}';`);

// The phone has version A everywhere: in the service worker's cache and, for the rest of
// the week, in the browser's HTTP cache. Then version B is uploaded.
async function phoneWithVersionA() {
  const server = new Map();
  const httpCache = new Map();
  for (const path of ['/', '/index.html', '/styles.css', '/app.js', '/units.js', '/firebase.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg']) {
    server.set(`${ORIGIN}${path}`, `${path} A`);
  }
  const browser = pretendBrowser({ server, httpCache });
  const worker = browser.loadWorker(SOURCE);
  await worker.install();
  await worker.activate();
  assert.equal(await worker.request('/app.js'), '/app.js A');
  return { server, httpCache, browser, worker };
}

const upload = (server) => {
  for (const path of ['/app.js', '/styles.css']) {
    server.set(`${ORIGIN}${path}`, `${path} B`);
  }
};

test('a new service worker fills its cache from the server, not the week-old browser copy', async () => {
  const { server, browser } = await phoneWithVersionA();
  upload(server); // with CACHE_NAME bumped, so the phone installs the new worker
  const next = browser.loadWorker(bumped(SOURCE));
  await next.install();
  await next.activate();
  assert.equal(await next.request('/app.js'), '/app.js B');
  assert.equal(await next.request('/styles.css'), '/styles.css B');
});

test('opening the app refreshes its files from the server for next time', async () => {
  const { server, worker } = await phoneWithVersionA();
  upload(server);
  // This launch still shows the saved copy straight away (and works offline)...
  assert.equal(await worker.request('/app.js'), '/app.js A');
  // ...and the next one has the upload.
  assert.equal(await worker.request('/app.js'), '/app.js B');
});

test('with no signal the app still opens from the saved copy', async () => {
  const { browser, worker } = await phoneWithVersionA();
  browser.network.offline = true;
  assert.equal(await worker.request('/'), '/ A');
  assert.equal(await worker.request('/app.js'), '/app.js A');
  assert.equal(await worker.request('/?from=home-screen'), '/ A');
});

test('app files are never taken from the browser HTTP cache', async () => {
  const { server, browser, worker } = await phoneWithVersionA();
  upload(server);
  await worker.request('/app.js');
  await browser.loadWorker(bumped(SOURCE)).install();
  const appFetches = browser.fetchLog.filter(({ url }) => url.startsWith(ORIGIN));
  assert.ok(appFetches.length > 0);
  for (const { url, cache } of appFetches) {
    assert.notEqual(cache, 'default', `${url} was fetched with the default cache mode`);
  }
});

test('the Firebase SDK, whose URLs carry the version, may still come from any cache', async () => {
  // Nothing to refresh there: a versioned URL's contents never change. Only checks that the
  // worker still caches the SDK when it can.
  const server = new Map(
    ['app', 'auth', 'firestore'].map((part) => [`https://www.gstatic.com/firebasejs/12.6.0/firebase-${part}.js`, 'sdk'])
  );
  for (const path of ['/', '/index.html', '/styles.css', '/app.js', '/units.js', '/firebase.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg']) {
    server.set(`${ORIGIN}${path}`, path);
  }
  const browser = pretendBrowser({ server, httpCache: new Map() });
  const worker = browser.loadWorker(SOURCE);
  await worker.install();
  assert.ok(await browser.caches.match('https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js'));
});
