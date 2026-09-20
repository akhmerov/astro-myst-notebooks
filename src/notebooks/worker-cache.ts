import { cachedRuntimeFetch } from './runtime-cache.js';

// This small prelude is bundled ahead of each upstream classic Xeus worker.
globalThis.fetch = cachedRuntimeFetch(new URL('./', globalThis.location.href));
