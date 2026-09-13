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
      for (const entry of context.store.values()) {
        const symbol = entry.data as PydocsEntry;
        const type = symbol.kind === 'function' ? 'function' : symbol.kind === 'module' ? 'module' : symbol.kind === 'class' ? 'class' : 'attribute';
        const slash = context.config.trailingSlash === 'never' ? '' : '/';
        inventory.setEntry({
          type: `py:${type}`, name: symbol.path,
          location: `${base}/${symbol.page}${slash}${symbol.anchor ? `#${symbol.anchor}` : ''}`,
          display: symbol.path,
        });
      }
      await mkdir(new URL('./', destination), { recursive: true });
      const temporary = fileURLToPath(destination) + '.tmp';
      inventory.write(temporary);
      await rename(temporary, destination);
    },
  };
}
