const namespace = 'astro-myst-notebooks:';

const cacheName = (base: URL) => namespace + base.href;

/** Keep this site's current environment and one previous version, not other apps' caches. */
export async function prepareRuntimeCache(base: URL, getStorage: () => CacheStorage = () => globalThis.caches) {
  try {
    const storage = getStorage();
    const current = cacheName(base);
    const prefix = cacheName(new URL('../', base));
    await storage.open(current);
    const previous = (await storage.keys()).filter(name => name.startsWith(prefix) && name !== current);
    await Promise.all(previous.slice(0, -1).map(name => storage.delete(name)));
  } catch { /* Disabled storage or quota pressure must not prevent execution. */ }
}

/** Cache only successful immutable runtime GETs, leaving user Python network requests alone. */
export function cachedRuntimeFetch(base: URL, fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  storage: () => CacheStorage = () => globalThis.caches): typeof fetch {
  let opening: Promise<Cache | undefined> | undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'GET' || !request.url.startsWith(base.href) ||
        request.headers.has('range') || request.cache === 'no-store') return fetcher(request);
    opening ??= (async () => { try { return await storage().open(cacheName(base)); } catch { return undefined; } })();
    const cache = await opening;
    if (request.cache !== 'reload') {
      const hit = await cache?.match(request).catch(() => undefined);
      if (hit) { request.signal.throwIfAborted(); return hit; }
    }
    const response = await fetcher(request);
    if (cache && response.status === 200 && !response.redirected &&
        !/\bno-store\b/i.test(response.headers.get('cache-control') ?? '')) {
      // Do not delay streaming WASM compilation while its cache copy is written.
      void cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  };
}
