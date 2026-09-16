import { glob } from 'astro/loaders';
import type { Loader } from 'astro/loaders';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notebookPaths, pageUrl } from './paths.js';

export { notebookToMyst } from './notebook-source.mjs';

export type Source = { id: string; title: string };
export type SourceLoaderOptions = Partial<Pick<Parameters<typeof glob>[0], 'pattern' | 'generateId'>> & {
  base?: URL; sources?: Record<string, Source>; documents?: URL;
};

/** Add site metadata to existing MyST files without copying authored files. */
export function sourceLoader(options: SourceLoaderOptions = {}): Loader {
  return {
    name: 'myst-sources',
    async load(context) {
      const { pattern = '**/[^_]*.{md,ipynb}', sources = {}, generateId } = options;
      const base = options.base ?? new URL('content/docs/', context.config.srcDir);
      const documents = options.documents ?? notebookPaths(context.config).documents;
      let loading = true;
      let scheduled = false;
      let pending = Promise.resolve();
      // A burst of store updates (save-all, branch switch) produces one rewrite.
      const schedule = () => {
        if (loading || scheduled) return;
        scheduled = true;
        pending = pending.then(() => { scheduled = false; return writeRoutes(); })
          .catch(error => { context.logger.error(`Unable to update MyST routes: ${error.message}`); });
      };
      async function writeRoutes() {
        const routes = [...context.store.values()].filter(entry => /\.(md|ipynb)$/.test(entry.filePath ?? '')).map(entry => {
          const id = entry.id.replace(/(^|\/)index$/, '');
          return {
            path: resolve(fileURLToPath(context.config.root), entry.filePath!), name: entry.id,
            title: String(entry.data.title), url: pageUrl(context.config, id),
          };
        });
        await mkdir(new URL('./', documents), { recursive: true });
        const temporary = new URL(documents.href + '.tmp');
        await writeFile(temporary, JSON.stringify(routes));
        await rename(temporary, documents);
      }
      const store = new Proxy(context.store, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            if (['set', 'delete', 'clear'].includes(String(key))) schedule();
            return result;
          };
        },
      });
      const loader = glob({
        base, pattern: [...(Array.isArray(pattern) ? pattern : [pattern]), ...Object.keys(sources)], deferRender: true,
        generateId: args => sources[args.entry]?.id ?? generateId?.(args) ?? String(args.data.slug ?? args.entry.replace(/\.(md|mdx|ipynb)$/, '')),
      });
      await loader.load({ ...context, store, parseData(args) {
        const source = args.filePath && sources[relative(fileURLToPath(base), args.filePath)];
        const { id, ...metadata } = source || {};
        return context.parseData({ ...args, data: { ...args.data, ...metadata } });
      } });
      await writeRoutes();
      loading = false;
    },
  };
}
