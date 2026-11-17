import type { AstroIntegration } from 'astro';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { lookup } from 'mrmime';
import { checkEnvironment } from '../jupyter.mjs';
import { notebookPaths, sitePrefix } from '../paths.js';
import { buildEnvironment } from './build-environment.js';
import type { BrowserOptions, ExecutionOptions, InteractiveOptions, PresentationOptions } from './types.js';
import { validatePresentation } from '../presentation.js';
import { registerEngine, publishEngine } from '../engine/project.mjs';

export interface Options {
  /** Generic Python API documentation compiled by the MyST autodoc workspace. */
  api?: { modules: string[]; searchPaths?: (string | URL)[]; python?: string; parser?: string; markup?: string; documents?: Record<string, string>; docstringWarnings?: 'error' | 'warn'; externalReferences?: Record<string, any> };
  /** MyST project inputs. Astro owns both build and development commands. */
  myst?: { config?: URL; source?: URL; buildTimeout?: number };
  /** Notebook presentation defaults, overridden by page frontmatter and cell tags. */
  presentation?: PresentationOptions;
  execution?: ExecutionOptions;
  interactive?: InteractiveOptions | false;

}
const require = createRequire(import.meta.url);
const bundled: string[] = JSON.parse(readFileSync(new URL('../bundled-dependencies.json', import.meta.url), 'utf8'));
// Static-copy sources are glob patterns, where backslashes escape rather than separate.
const posix = (path: string) => path.split(sep).join('/');
type CopyTarget = Parameters<typeof viteStaticCopy>[0]['targets'][number];

/** MyST parsing, build execution, and optional Xeus notebooks as one Astro integration. */
export default function notebooks(options: Options = {}): AstroIntegration {
  for (const key of ['references', 'localInventory', 'referenceCache', 'documents']) {
    if (key in options) throw new Error(`${key} moved out of the Astro integration; configure references in myst.yml or api.externalReferences, and collection source options in notebookCollections()`);
  }
  if ('inputVisibility' in options) throw new Error('inputVisibility was removed in 0.4; use presentation.input: show, hide, or remove');
  validatePresentation(options.presentation);
  let engine: ReturnType<typeof registerEngine> | undefined;
  return {
    name: 'astro-myst-notebooks',
    hooks: {
      'astro:build:done': async ({ dir }) => { if (engine?.manifest) await publishEngine(engine, dir); },
      'astro:config:setup': async (setup) => {
        const { config, updateConfig, injectScript, command, logger } = setup;
        const paths = notebookPaths(config);
        // Preserve private dependency resolutions when Vite emits the SSR build.
        if (command === 'build') {
          const resolve = { noExternal: bundled };
          updateConfig({ vite: { environments: { ssr: { resolve }, prerender: { resolve } } } });
        }
        const execution = { ...options.execution, cwd: fileURLToPath(options.execution?.cwd ?? config.root) };
        const interactive = options.interactive !== false;
        if (command === 'build' || command === 'dev') await checkEnvironment(execution);
        const project = registerEngine(config, options);
        engine = project;
        injectScript('page-ssr', `import ${JSON.stringify(fileURLToPath(new URL('./style.css', import.meta.url)))}; import ${JSON.stringify(require.resolve('katex/dist/katex.min.css'))};`);
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./source-selection.js', import.meta.url)))};`);
        const prefix = sitePrefix(config);
        const runtimeVersion: string = JSON.parse(readFileSync(new URL('./browser/version.json', import.meta.url), 'utf8'));
        const runtimeDestination = `notebooks/${runtimeVersion}`;
        const runtimeBase = `${prefix}/${runtimeDestination}`;
        const runtime = posix(fileURLToPath(new URL('./browser/', import.meta.url)));
        const targets: CopyTarget[] = [{ src: `${runtime}*.js`, dest: runtimeDestination, rename: { stripBase: true } }];
        injectScript('page', `const runtimeBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ runtimeBase + '/client.js');`);
        if (interactive && (command === 'build' || command === 'dev')) {
          const settings = options.interactive || {};
          if ('xeus' in settings || 'packages' in settings) throw new Error('Use interactive.environment for the Xeus environment; Pyodide and interactive.xeus were removed in 0.3');
          const environment = await buildEnvironment(settings, { root: config.root, cache: paths.cache, python: settings.python ?? execution.python, log: message => logger.info(message) });
          const assetVersion = createHash('sha256').update(runtimeVersion + environment.version).digest('hex').slice(0, 20);
          const assetDestination = `thebe/${assetVersion}`;
          const browser: BrowserOptions = {
            assetBase: `${prefix}/${assetDestination}`, setup: settings.setup ?? '',
            kernelName: settings.kernelName ?? 'xpython', startupTimeout: settings.startupTimeout ?? 120000,
            wheelPath: environment.wheelPath,
          };
          const assets = posix(fileURLToPath(new URL('./browser/assets/', import.meta.url)));
          const xeus = join(environment.directory, 'xeus');
          const depth = relative(fileURLToPath(config.root), xeus).split(sep).filter(part => part && part !== '..').length;
          targets.push({ src: `${assets}*`, dest: assetDestination, rename: { stripBase: true } },
            { src: posix(xeus), dest: `${assetDestination}/xeus`, rename: { stripBase: depth } });
          injectScript('page', `const notebookBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ notebookBase + '/element.js').then(({ defineNotebooks }) => defineNotebooks(${JSON.stringify(browser)}));`);
        }
        updateConfig({ vite: { plugins: [...viteStaticCopy({ targets }), {
          name: 'astro-myst-public-assets',
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.method !== 'GET' && request.method !== 'HEAD') return next();
              const pathname = request.url?.split('?', 1)[0];
              if (!pathname) return next();
              // Astro's dev middleware validates and strips the deployment base
              // before forwarding the request to Vite plugins.
              const file = project.publicAssets.get(pathname);
              if (!file) return next();
              try {
                const bytes = await readFile(file);
                response.setHeader('Content-Type', lookup(file) ?? 'application/octet-stream');
                response.setHeader('Content-Length', bytes.length);
                response.end(request.method === 'HEAD' ? undefined : bytes);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return next();
                next(error);
              }
            });
          },
        }] } });
      },
    },
  };
}
