import type { AstroConfig } from 'astro';

/** Integration and loaders resolve these from the same Astro configuration. */
export function notebookPaths(config: Pick<AstroConfig, 'cacheDir'>) {
  const cache = new URL('notebooks/', config.cacheDir);
  return {
    cache,
    documents: new URL('documents.json', cache),
    references: new URL('references/', cache),
    api: new URL('api.inv', cache),
  };
}
