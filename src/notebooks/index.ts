import type { AstroIntegration } from 'astro';
import { unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { remarkMyst, mystRehype } from '../myst.mjs';
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
          rehypePlugins: [rehypeJupyter, rehypeKatex],
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
        if (settings.wheel) {
          const cache = fileURLToPath(config.cacheDir);
          await mkdir(cache, { recursive: true });
          const directory = await mkdtemp(join(cache, 'notebook-wheel-'));
          const [executable, ...args] = settings.wheel.command;
          if (!executable) throw new Error('The wheel build command must not be empty');
          await promisify(execFile)(executable, [...args, '-d', directory], { cwd: fileURLToPath(settings.wheel.project) });
          const wheels = (await readdir(directory)).filter(name => name.endsWith('.whl'));
          if (wheels.length !== 1) throw new Error('The notebook build must produce exactly one wheel');
          const wheel = wheels[0]!;
          browser.wheelUrl = `${assetBase}/wheels/${wheel}`;
          wheelTargets.push({ src: join(directory, wheel), dest: 'thebe/wheels', rename: { stripBase: true as const } });
        }
        // Libraries retain their supported prebuilt worker/chunk names. App code
        // is bundled normally; only this adapter knows the distribution layout.
        updateConfig({ vite: { plugins: [
          {
            name: 'notebook-browser-options',
            resolveId(id) { if (id === 'virtual:notebook-options') return '\0' + id; },
            load(id) { if (id === '\0virtual:notebook-options') return `export default ${JSON.stringify(browser)};`; },
          },
          ...viteStaticCopy({ targets: [
            { src: asset('thebe', 'lib/*.{js,css,txt}'), dest: 'thebe', rename: { stripBase: true as const } },
            { src: asset('thebe-lite', 'dist/lib/*.{js,txt}'), dest: 'thebe', rename: { stripBase: true as const } },
            { src: asset('@jupyterlite/pyodide-kernel', 'pypi/*'), dest: 'thebe/pypi', rename: { stripBase: true as const } },
            ...wheelTargets,
            { src: asset('thebe-lite', 'dist/lib/service-worker.js'), dest: '.', rename: { stripBase: true as const } },
          ] }),
        ] } });
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./element.js', import.meta.url)))};`);
      },
    },
  };
}
