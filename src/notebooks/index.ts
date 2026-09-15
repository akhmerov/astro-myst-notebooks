import type { AstroIntegration } from 'astro';
import { unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { remarkMyst, mystRehype, rehypeDocumentBase, rehypeMathErrors } from '../myst.mjs';
import { remarkReferences } from '../references.mjs';
import { checkEnvironment, remarkJupyter } from '../jupyter.mjs';
import { rehypeJupyter } from '../mime.mjs';
import { notebookPaths } from '../paths.js';
import { buildEnvironment } from './build-environment.js';
import type { BrowserOptions, ExecutionOptions, InteractiveOptions } from './types.js';

export interface Options {
  execution?: ExecutionOptions;
  interactive?: InteractiveOptions | false;
  references?: Record<string, { url?: string; file?: URL; base?: string; refresh?: boolean }>;
  localInventory?: URL;
  referenceCache?: URL;
  documents?: URL;
}
const require = createRequire(import.meta.url);
const bundled: string[] = JSON.parse(readFileSync(new URL('../bundled-dependencies.json', import.meta.url), 'utf8'));

/** MyST parsing, build execution, and optional Xeus notebooks as one Astro integration. */
export default function notebooks(options: Options = {}): AstroIntegration {
  return {
    name: 'astro-myst-notebooks',
    hooks: {
      'astro:config:setup': async ({ config, updateConfig, injectScript, command, logger }) => {
        const paths = notebookPaths(config);
        // Preserve private dependency resolutions when Vite emits the SSR build.
        updateConfig({ vite: { environments: Object.fromEntries((command === 'build' ? ['ssr', 'prerender'] : []).map(name => [name, { resolve: { noExternal: bundled } }])) } });
        const execution = { ...options.execution, cwd: fileURLToPath(options.execution?.cwd ?? config.root) };
        const interactive = options.interactive !== false;
        if (command === 'build' || command === 'dev') await checkEnvironment(execution);
        updateConfig({ markdown: { processor: unified({
          remarkPlugins: [[remarkMyst, { root: options.execution?.cwd ?? config.root, documents: options.documents ?? paths.documents }],
            [remarkReferences, { references: options.references, localInventory: options.localInventory, cacheDir: options.referenceCache ?? paths.references }],
            [remarkJupyter, { ...execution, interactive }]],
          remarkRehype: mystRehype,
          rehypePlugins: [rehypeJupyter, rehypeKatex, rehypeMathErrors, [rehypeDocumentBase, { base: config.base }]],
        }) } });
        injectScript('page-ssr', `import ${JSON.stringify(fileURLToPath(new URL('./style.css', import.meta.url)))}; import ${JSON.stringify(require.resolve('katex/dist/katex.min.css'))};`);
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./source-selection.js', import.meta.url)))};`);
        const runtimeBase = `${config.base.replace(/\/$/, '')}/notebooks`;
        const runtime = fileURLToPath(new URL('./browser/', import.meta.url));
        updateConfig({ vite: { plugins: viteStaticCopy({ targets: [{ src: `${runtime}*.{js,map}`, dest: 'notebooks', rename: { stripBase: true as const } }] }) } });
        injectScript('page', `const runtimeBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ runtimeBase + '/client.js');`);
        if (!interactive || (command !== 'build' && command !== 'dev')) return;
        const settings = options.interactive || {};
        if ('xeus' in settings || 'packages' in settings) throw new Error('Use interactive.environment for the Xeus environment; Pyodide and interactive.xeus were removed in 0.3');
        const environment = await buildEnvironment(settings, { root: config.root, cache: paths.cache, python: execution.python, log: message => logger.info(message) });
        const browser: BrowserOptions = {
          assetBase: `${config.base.replace(/\/$/, '')}/thebe`, setup: settings.setup ?? '',
          kernelName: settings.kernelName ?? 'xpython', startupTimeout: settings.startupTimeout ?? 120000,
          wheelPath: environment.wheelPath,
        };
        const assets = fileURLToPath(new URL('./browser/assets/', import.meta.url));
        updateConfig({ vite: { plugins: viteStaticCopy({ targets: [
          { src: `${assets}*`, dest: 'thebe', rename: { stripBase: true as const } },
          { src: join(environment.directory, 'xeus'), dest: 'thebe/xeus', rename: { stripBase: relative(fileURLToPath(config.root), join(environment.directory, 'xeus')).split(/[/\\]/).filter(part => part && part !== '..').length } },
        ] }) } });
        injectScript('page', `const notebookBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ notebookBase + '/element.js').then(({ defineNotebooks }) => defineNotebooks(${JSON.stringify(browser)}));`);
      },
    },
  };
}
