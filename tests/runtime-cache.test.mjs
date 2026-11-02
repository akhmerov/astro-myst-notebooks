import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedRuntimeFetch, prepareRuntimeCache } from '../dist/notebooks/runtime-cache.js';

function memoryStorage() {
  const caches = new Map();
  return {
    async open(name) {
      if (!caches.has(name)) {
        const entries = new Map();
        caches.set(name, {
          async match(request) { return entries.get(request.url)?.clone(); },
          async put(request, response) { entries.set(request.url, response.clone()); },
        });
      }
      return caches.get(name);
    },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
  };
}

test('immutable runtime downloads are reused across workers, and new versions fetch new bytes', async () => {
  const storage = memoryStorage();
  const first = new URL('https://docs.test/manual/thebe/first/');
  const next = new URL('../next/', first);
  let downloads = 0;
  const network = async () => new Response(`payload-${++downloads}`);
  const create = base => cachedRuntimeFetch(base, network, () => storage);
  assert.equal(await (await create(first)(new URL('python.wasm', first))).text(), 'payload-1');
  assert.equal(await (await create(first)(new URL('python.wasm', first))).text(), 'payload-1');
  assert.equal(await (await create(next)(new URL('python.wasm', next))).text(), 'payload-2');
  assert.equal(downloads, 2);
});

test('failed and private responses, range requests, and user network requests are not retained', async () => {
  const storage = memoryStorage();
  const base = new URL('https://docs.test/thebe/version/');
  let downloads = 0;
  let status = 503;
  let headers = {};
  const fetch = cachedRuntimeFetch(base, async () => {
    downloads++;
    return new Response('bytes', { status, headers });
  }, () => storage);
  const url = new URL('python.wasm', base);
  await fetch(url);
  status = 200;
  await fetch(url);
  await fetch(url);
  assert.equal(downloads, 2, 'an error must not poison retries');
  for (const [request, init] of [
    [new URL('private.wasm', base), {}],
    [url, { cache: 'no-store' }],
    [url, { headers: { range: 'bytes=0-3' } }],
    [new URL('/api/query', base), {}],
    [new URL('/thebe/version-other/python.wasm', base), {}],
  ]) {
    headers = { 'cache-control': 'no-store' };
    const before = downloads;
    await fetch(request, init);
    await fetch(request, init);
    assert.equal(downloads, before + 2);
  }
});

test('cache storage failures fall back to downloads and pruning retains two site versions', async () => {
  const base = new URL('https://docs.test/manual/thebe/current/');
  const unavailable = () => { throw new Error('Storage disabled'); };
  const fetch = cachedRuntimeFetch(base, async () => new Response('online'), unavailable);
  await prepareRuntimeCache(base, unavailable);
  assert.equal(await (await fetch(new URL('python.wasm', base))).text(), 'online');
  const storage = memoryStorage();
  const prefix = 'astro-myst-notebooks:https://docs.test/manual/thebe/';
  for (const name of ['host-app', prefix + 'oldest/', prefix + 'previous/',
    'astro-myst-notebooks:https://docs.test/other/thebe/version/']) await storage.open(name);
  await prepareRuntimeCache(base, () => storage);
  assert.deepEqual(await storage.keys(), ['host-app', prefix + 'previous/',
    'astro-myst-notebooks:https://docs.test/other/thebe/version/', prefix + 'current/']);
});
