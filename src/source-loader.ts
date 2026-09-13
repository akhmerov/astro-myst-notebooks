import { glob } from 'astro/loaders';
import type { Loader } from 'astro/loaders';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Source = { id: string; title: string };

/** Add site metadata to existing MyST files without copying or rewriting them. */
export type SourceLoaderOptions = Pick<Parameters<typeof glob>[0], 'pattern' | 'generateId'> & {
  base: URL; sources?: Record<string, Source>; documents: URL;
};

export function sourceLoader({ base, pattern, sources = {}, documents, generateId }: SourceLoaderOptions): Loader {
  const loader = glob({
    base,
    pattern: [...(Array.isArray(pattern) ? pattern : [pattern]), ...Object.keys(sources)],
    deferRender: true,
    generateId: (args) => sources[args.entry]?.id ?? generateId?.(args) ?? String(args.data.slug ?? args.entry
      .replace(/\.(md|mdx)$/, '')),
  });
  return {
    name: 'myst-sources',
    async load(context) {
      await loader.load({
        ...context,
        parseData(args) {
          const source = args.filePath && sources[relative(fileURLToPath(base), args.filePath)];
          const { id, ...metadata } = source || {};
          return context.parseData({ ...args, data: { ...args.data, ...metadata } });
        },
      });
      const routes = [...context.store.values()].filter(entry => entry.filePath?.endsWith('.md')).map(entry => ({
        path: resolve(fileURLToPath(context.config.root), entry.filePath!),
        url: `${context.config.base.replace(/\/$/, '')}/${entry.id === 'index' ? '' : entry.id + '/'}`,
      }));
      await mkdir(new URL('./', documents), { recursive: true });
      const temporary = new URL(documents.href + '.tmp');
      await writeFile(temporary, JSON.stringify(routes));
      await rename(temporary, documents);
    },
  };
}
