import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { sourceLoader, type SourceLoaderOptions } from '../source-loader.js';

/** Standard Starlight schema with deferred MyST rendering and managed routes. */
export function notebookCollection(options: SourceLoaderOptions = {}): ReturnType<typeof defineCollection> {
  return defineCollection({ loader: sourceLoader(options), schema: docsSchema() });
}

import api from 'virtual:notebook-api';
import { notebookPaths } from '../paths.js';
import type { Loader } from 'astro/loaders';
import type { StarlightPydocsOptions } from 'starlight-pydocs';
import { Inventory } from 'intersphinx';
import { fileURLToPath } from 'node:url';

function apiLoader(options: StarlightPydocsOptions): Loader {
  return {
    name: 'notebook-api-inventory',
    async load(context) {
      const { pydocsInventory } = await import('../pydocs-inventory.js');
      const paths = notebookPaths(context.config);
      context.store.clear();
      const merged = new Inventory({ project: 'documentation' });
      for (const [index, pkg] of options.packages.entries()) {
        const destination = new URL(`api-${index}.inv`, paths.references);
        const loader = pydocsInventory({ ...pkg, runner: options.runner }, destination);
        // One real Astro collection contains all configured packages.
        const store = new Proxy(context.store, { get(target, key) {
          if (key === 'clear') return () => {};
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        await loader.load({ ...context, store });
        const part = new Inventory({ path: fileURLToPath(destination) });
        await part.load();
        for (const [domain, entries] of Object.entries(part.data)) for (const [name, entry] of Object.entries(entries)) {
          merged.setEntry({ ...entry, name, type: domain });
        }
      }
      merged.write(fileURLToPath(paths.api));
    },
  };
}

/** Register prose and, when configured in the plugin, Python API symbols. */
export function notebookCollections(options: SourceLoaderOptions = {}): Record<string, ReturnType<typeof defineCollection>> {
  return {
    docs: notebookCollection(options),
    ...(api ? { apiSymbols: defineCollection({ loader: apiLoader(api) }) } : {}),
  };
}
