import type { Loader } from 'astro/loaders';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { sep, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngine, enginePages, getEngine } from './project.mjs';
import { renderPage } from './render.mjs';
import { isExecutionDependencyFile } from './execution.mjs';
import { notebookPaths, pageUrl } from '../paths.js';

export interface EngineLoaderOptions { base?: URL; sources?: Record<string, {id: string; title: string}>; documents?: URL; }

/** Load MyST's already resolved documents; rendering never executes Python. */
export function mystLoader(options: EngineLoaderOptions = {}): Loader {
  return { name: 'myst-resolved-documents', async load(context) {
    const engine = getEngine(context.config.root);
    if (options.base && fileURLToPath(options.base) !== engine.source) {
      engine.source = fileURLToPath(options.base); engine.manifest = undefined;
    }
    if (JSON.stringify(engine.sourceOverrides) !== JSON.stringify(options.sources)) {
      engine.sourceOverrides = options.sources; engine.manifest = undefined;
    }
    let pending = Promise.resolve();
    const load = async (force = false) => {
      await buildEngine(engine, { force });
      if (context.watcher && engine.documentInputs.size) context.watcher.add([...engine.documentInputs]);
      const pages = await enginePages(engine);
      const routes = engine.routes;
      const entries = [];
      for (const { id: originalId, file, page, frontmatter } of pages) {
        const override = options.sources?.[relative(engine.source, file)];
        const id = override?.id ?? originalId;
        const rendered = await renderPage({ ...page, location: relative(fileURLToPath(engine.options.execution?.cwd ?? context.config.root), file) }, { root: fileURLToPath(engine.options.execution?.cwd ?? context.config.root),
          base: context.config.base, interactive: engine.options.interactive !== false,
          presentation: engine.options.presentation, frontmatter,
          resolvePageUrl: (slug: string) => routes.get(slug) ?? routes.get(slug.replace(/^\/+|\/+$/g, '')),
          isPublicAsset: (path: string) => engine.publicAssets.has(path.startsWith('/') ? path : '/' + path),
          readAsset: async (path: string) => {
            const candidate = resolve(engine.site, 'public', path.replace(/^\//, ''));
            const root = resolve(engine.site, 'public');
            if (!candidate.startsWith(root + '/')) throw new Error('Invalid MyST asset path');
            return readFile(candidate);
          },
        });
        const data = await context.parseData({ id: id || 'index', filePath: file,
          data: { ...page.frontmatter, ...frontmatter, ...override, title: override?.title ?? page.frontmatter.title ?? frontmatter.title ?? id } });
        entries.push({ id: id || 'index', data, rendered, filePath: relative(fileURLToPath(context.config.root), file), digest: context.generateDigest(page) });
      }
      context.store.clear();
      for (const entry of entries) context.store.set(entry);
      const documents = options.documents ?? notebookPaths(context.config).documents;
      await mkdir(new URL('./', documents), { recursive: true });
      await writeFile(documents, JSON.stringify(pages.map(({id,file,frontmatter,page}: any) => ({path:file,name:id,title:frontmatter.title ?? page.frontmatter.title,url:pageUrl(context.config,id)}))));
    };
    await load();
    if (context.watcher) {
      const watcher = context.watcher;
      const inputPaths = (engine.options.execution?.dependencies ?? []).map((path: URL | string) =>
        resolve(engine.root, path instanceof URL ? fileURLToPath(path) : path));
      const apiPaths = engine.options.api?.searchPaths?.map((path: URL | string) =>
        resolve(engine.root, path instanceof URL ? fileURLToPath(path) : path)) ?? [];
      const cwd = fileURLToPath(engine.options.execution?.cwd ?? context.config.root);
      watcher.add([engine.source, engine.configFile, ...(resolve(cwd) === engine.root ? [] : [cwd]), ...inputPaths, ...apiPaths]);
      let timer: ReturnType<typeof setTimeout>;
      const changed = (file: string) => {
        const absolute = resolve(engine.root, file);
        const normalized = absolute.split(sep).join('/');
        if (normalized.includes('/node_modules/') || normalized.includes('/.pixi/') || normalized.includes('/_build/') || normalized.includes('/.astro/') || normalized.endsWith('/.astro-myst.generated.yml')) return;
        const explicitInput = inputPaths.some((path: string) => absolute === path || absolute.startsWith(path + sep));
        const configOrDocument = ['.md', '.ipynb', '.yml', '.yaml', '.bib'].includes(extname(file));
        if (!explicitInput && !engine.documentInputs.has(absolute) && !configOrDocument && !isExecutionDependencyFile(absolute)) return;
        clearTimeout(timer);
        timer = setTimeout(() => { pending = pending.then(() => load(true)).catch(error => context.logger.error(String(error))); }, 100);
      };
      watcher.on('change', changed).on('add', changed).on('unlink', changed);
      watcher.once('close', () => { clearTimeout(timer); watcher.off('change', changed).off('add', changed).off('unlink', changed); });
    }
  } };
}
