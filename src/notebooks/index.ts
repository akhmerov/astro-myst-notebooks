import type { AstroIntegration } from 'astro';
import { unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { join, relative } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { remarkMyst, mystRehype, rehypeDocumentBase, rehypeMathErrors } from '../myst.mjs';
import { remarkReferences } from '../references.mjs';
import { checkEnvironment, remarkJupyter } from '../jupyter.mjs';
import { rehypeJupyter } from '../mime.mjs';
import type { BrowserOptions, ExecutionOptions, InteractiveOptions } from './types.js';

export interface Options {
  execution: ExecutionOptions;
  interactive?: InteractiveOptions | false;
  references?: Record<string, { url?: string; file?: URL; base?: string; refresh?: boolean }>;
  localInventory?: URL;
  referenceCache: URL;
  documents?: URL;
}

const require = createRequire(import.meta.url);
const asset = (name: string, path: string) => join(dirname(require.resolve(`${name}/package.json`)), path).replaceAll('\\', '/');

/** MyST parsing, build execution, and optional browser notebooks as one Astro integration. */
export default function notebooks(options: Options): AstroIntegration {
  return {
    name: 'astro-myst-notebooks',
    hooks: {
      'astro:config:setup': async ({ config, updateConfig, injectScript, command }) => {
        const interactive = options.interactive !== false;
        if (command === 'build' || command === 'dev') await checkEnvironment({
          ...options.execution, cwd: fileURLToPath(options.execution.cwd),
        });
        updateConfig({ markdown: { processor: unified({
          remarkPlugins: [[remarkMyst, { root: options.execution.cwd, documents: options.documents }],
            [remarkReferences, { references: options.references, localInventory: options.localInventory, cacheDir: options.referenceCache }],
            [remarkJupyter, { ...options.execution, cwd: fileURLToPath(options.execution.cwd), interactive }],
          ],
          remarkRehype: mystRehype,
          rehypePlugins: [rehypeJupyter, rehypeKatex, rehypeMathErrors, [rehypeDocumentBase, { base: config.base }]],
        }) } });
        // Include styles in server-rendered pages, including pages with no live cells.
        injectScript('page-ssr', `import ${JSON.stringify(fileURLToPath(new URL('./style.css', import.meta.url)))}; import ${JSON.stringify(require.resolve('katex/dist/katex.min.css'))};`);
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./client.js', import.meta.url)))};`);
        if (!interactive || (command !== 'build' && command !== 'dev')) return;
        const settings = options.interactive || {};
        const assetBase = `${config.base.replace(/\/$/, '')}/thebe`;
        const browser: BrowserOptions = {
          assetBase, packages: settings.packages ?? [], setup: settings.setup ?? '',
          kernelName: settings.kernelName ?? 'python', startupTimeout: settings.startupTimeout ?? 120000,
        };
        const wheelTargets = [];
        let wheelDirectory: string | undefined;
        if (settings.wheel) {
          const cache = fileURLToPath(config.cacheDir);
          await mkdir(cache, { recursive: true });
          const directory = await mkdtemp(join(cache, 'notebook-wheel-'));
          wheelDirectory = directory;
          const [executable, ...args] = settings.wheel.command;
          if (!executable) throw new Error('The wheel build command must not be empty');
          await promisify(execFile)(executable, [...args, '-d', directory], { cwd: fileURLToPath(settings.wheel.project) });
          const wheels = (await readdir(directory)).filter(name => name.endsWith('.whl'));
          if (wheels.length !== 1) throw new Error('The notebook build must produce exactly one wheel');
          const wheel = wheels[0]!;
          if (settings.xeus) browser.xeus = { wheelPath: `/opt/wheels/${wheel}` };
          else browser.wheelUrl = `${assetBase}/wheels/${wheel}`;
          wheelTargets.push({ src: join(directory, wheel), dest: 'thebe/wheels', rename: { stripBase: true as const } });
        }
        const liteTargets = [];
        if (settings.xeus) {
          if (settings.packages?.length) throw new Error('Configure Xeus packages in its environment file');
          browser.xeus ??= {};
          browser.kernelName = settings.kernelName ?? 'xpython';
          const directory = join(fileURLToPath(config.cacheDir), 'jupyterlite');
          const [command, ...args] = settings.xeus.command ?? ['jupyter', 'lite'];
          if (!command) throw new Error('The Xeus build command must not be empty');
          await promisify(execFile)(command, [...args, 'build',
            `--XeusAddon.environment_file=${fileURLToPath(settings.xeus.environment)}`,
            `--output-dir=${directory}`, `--lite-dir=${dirname(fileURLToPath(settings.xeus.environment))}`,
            ...(wheelDirectory ? [`--XeusAddon.mounts=${wheelDirectory}:/opt/wheels`] : []),
          ], { cwd: fileURLToPath(config.root), maxBuffer: 10 * 1024 * 1024 });
          liteTargets.push(
            { src: join(directory, 'xeus'), dest: 'thebe/xeus', rename: {
              stripBase: relative(fileURLToPath(config.root), join(directory, 'xeus'))
                .split(/[/\\]/).filter(part => part && part !== '..').length,
            } },
            { src: asset('@emscripten-forge/mambajs-core', 'lib/*.wasm'), dest: 'thebe', rename: { stripBase: true as const } },
            { src: asset('@jupyterlite/xeus', 'lib/*.worker.js'), dest: 'thebe', rename: { stripBase: true as const } },
          );
        } else {
          liteTargets.push(
            { src: asset('thebe-lite', 'dist/lib/*.{js,txt}'), dest: 'thebe', rename: { stripBase: true as const } },
            { src: asset('@jupyterlite/pyodide-kernel', 'pypi/*'), dest: 'thebe/pypi', rename: { stripBase: true as const } },
            { src: asset('thebe-lite', 'dist/lib/service-worker.js'), dest: '.', rename: { stripBase: true as const } },
          );
        }
        // Libraries retain their supported prebuilt worker/chunk names. App code
        // is bundled normally; only this adapter knows the distribution layout.
        updateConfig({ vite: {
          resolve: { alias: settings.xeus ? [{
            find: /^@jupyterlite\/xeus$/,
            replacement: fileURLToPath(new URL('./xeus-kernel.js', import.meta.url)),
          }] : [] },
          plugins: [
          {
            name: 'jupyterlite-text-assets',
            enforce: 'pre',
            async resolveId(id, importer) {
              if (id.endsWith('?text') && importer?.includes('/@jupyterlite/')) {
                return this.resolve(id.replace('?text', '.js?raw'), importer, { skipSelf: true });
              }
            },
          },
          {
            name: 'notebook-browser-options',
            resolveId(id) { if (id === 'virtual:notebook-options') return '\0' + id; },
            load(id) { if (id === '\0virtual:notebook-options') return `export default ${JSON.stringify(browser)};`; },
          },
          ...viteStaticCopy({ targets: [
            { src: asset('thebe', 'lib/*.{js,css,txt}'), dest: 'thebe', rename: { stripBase: true as const } },
            ...liteTargets, ...wheelTargets,
          ] }),
        ] } });
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./element.js', import.meta.url)))};`);
      },
    },
  };
}
