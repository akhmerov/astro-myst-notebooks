import { pydocsLoader } from 'starlight-pydocs/loader';
import type { PydocsLoaderOptions, PydocsEntry } from 'starlight-pydocs/loader';
import type { Loader } from 'astro/loaders';
import { Inventory } from 'intersphinx';
import { mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Publish build-time references from Pydocs' public content loader/model. */
export function pydocsInventory(options: PydocsLoaderOptions, destination: URL): Loader {
  const loader = pydocsLoader(options);
  return {
    ...loader,
    name: 'pydocs-reference-inventory',
    async load(context) {
      await loader.load(context);
      const inventory = new Inventory({ project: options.name });
      const base = context.config.base.replace(/\/$/, '');
      const symbols = [...context.store.values()].map(entry => entry.data as PydocsEntry);
      const byPath = new Map(symbols.map(symbol => [symbol.path, symbol]));
      const documented = new Set(symbols.map(symbol => symbol.path));
      const aliases = new Set<string>();
      for (const symbol of symbols) {
        const parent = byPath.get(symbol.path.slice(0, symbol.path.lastIndexOf('.')));
        const type = symbol.kind === 'function' ? (parent?.kind === 'class' ? 'method' : 'function')
          : symbol.kind === 'module' ? 'module' : symbol.kind === 'class' ? 'class'
          : symbol.labels.includes('property') ? 'property' : parent?.kind === 'module' ? 'data' : 'attribute';
        const slash = context.config.trailingSlash === 'never' ? '' : '/';
        const target = {
          type: `py:${type}`, name: symbol.path,
          location: `${base}/${symbol.page}${slash}${symbol.anchor ? `#${symbol.anchor}` : ''}`,
          display: symbol.path,
        };
        inventory.setEntry(target);
        if (!documented.has(symbol.canonicalPath) && !aliases.has(symbol.canonicalPath)) {
          inventory.setEntry({ ...target, name: symbol.canonicalPath });
          aliases.add(symbol.canonicalPath);
        }
      }
      await mkdir(new URL('./', destination), { recursive: true });
      const temporary = fileURLToPath(destination) + '.tmp';
      inventory.write(temporary);
      await rename(temporary, destination);
    },
  };
}
