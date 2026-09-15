import type { StarlightPlugin } from '@astrojs/starlight/types';
import type { StarlightPydocsOptions } from 'starlight-pydocs';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import notebooks, { type Options } from '../notebooks/index.js';
import { notebookPaths } from '../paths.js';
import { exportInventory } from '../inventory.js';

export interface StarlightNotebookOptions extends Options {
  /** Optional Pydocs configuration; adapters and inventories are connected automatically. */
  api?: StarlightPydocsOptions;
}

export default function starlightNotebooks(options: StarlightNotebookOptions = {}, apiPlugin?: typeof import('starlight-pydocs').default): StarlightPlugin {
  let pydocs: StarlightPlugin | undefined;
  const api = options.api && {
    ...options.api,
    packages: options.api.packages.map(pkg => ({ ...pkg, extensions: [
      ...(pkg.extensions ?? []),
      { name: fileURLToPath(new URL('../griffe_myst.py', import.meta.url)) },
    ] })),
    inventories: options.api.inventories ?? Object.values(options.references ?? {}).map(ref => ({
      ...ref, file: ref.file && fileURLToPath(ref.file),
    })),
  };
  return {
    name: 'astro-myst-notebooks/starlight',
    hooks: {
      async 'i18n:setup'(context) {
        if (options.api) {
          if (!apiPlugin) throw new Error('Use astro-myst-notebooks/starlight/api when configuring Python API documentation');
          pydocs = apiPlugin({ ...api!, publishInventory: false, components: {
            DocstringSections: 'astro-myst-notebooks/CheckedDocstrings.astro', ...options.api.components,
          } });
          await pydocs.hooks['i18n:setup']?.(context);
        }
      },
      async 'config:setup'(context) {
        const { astroConfig, addIntegration, config, updateConfig } = context;
        const paths = notebookPaths(astroConfig);
        // Starlight replaces top-level keys on update, so merge all component overrides once.
        const components = { ...config.components };
        components.PageTitle ??= 'astro-myst-notebooks/starlight/PageTitle.astro';
        if (options.api) {
          if (components.MarkdownContent) throw new Error('The notebook API preset owns MarkdownContent; use the lower-level adapters for a custom override');
          components.MarkdownContent = 'astro-myst-notebooks/AutodocContent.astro';
        }
        updateConfig({ components });
        if (options.api) await pydocs!.hooks['config:setup']?.(context);
        const localInventory = options.localInventory ?? (options.api ? paths.api : undefined);
        addIntegration({ name: 'notebook-api-options', hooks: {
          'astro:config:setup': ({ updateConfig }) => { updateConfig({ vite: { plugins: [{
            name: 'notebook-api-options',
            resolveId(id) { if (id === 'virtual:notebook-api') return '\0' + id; },
            load(id) { if (id === '\0virtual:notebook-api') return `export default ${JSON.stringify(api ?? null)};`; },
          }] } }); },
        } });
        addIntegration(notebooks({ ...options, localInventory }));
        addIntegration({ name: 'notebook-inventory', hooks: {
          'astro:build:done': async ({ dir }) => {
            if (options.api && !options.localInventory) await access(paths.api).catch(() => {
              throw new Error(`Missing API inventory ${fileURLToPath(paths.api)}. Register the apiSymbols collection with notebookCollections() from astro-myst-notebooks/starlight/content.`);
            });
            await exportInventory({
              api: localInventory,
              documents: options.documents ?? paths.documents,
              root: options.execution?.cwd ?? astroConfig.root,
              destination: new URL('objects.inv', dir), base: astroConfig.base,
            });
          },
        } });
      },
    },
  };
}
