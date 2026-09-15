import type { AstroConfig } from 'astro';

/** Deployment base without its trailing slash; empty at the origin root. */
export function sitePrefix(config: Pick<AstroConfig, 'base'>): string {
  return config.base.replace(/\/$/, '');
}

/** Page URL for a route id, following the site's trailing-slash setting. */
export function pageUrl(config: Pick<AstroConfig, 'base' | 'trailingSlash'>, id: string): string {
  const slash = config.trailingSlash === 'never' || !id ? '' : '/';
  return `${sitePrefix(config)}/${id}${slash}`;
}

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
