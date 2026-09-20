import type { AstroConfig, AstroIntegration, ContentEntryType } from 'astro';
import { unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { remarkMyst, mystRehype, rehypeDocumentBase, rehypeMathErrors } from '../myst.mjs';
import { remarkReferences } from '../references.mjs';
import { checkEnvironment, remarkJupyter } from '../jupyter.mjs';
import { rehypeJupyter } from '../mime.mjs';
import { notebookPaths, sitePrefix } from '../paths.js';
import { buildEnvironment } from './build-environment.js';
import { notebookEntryType } from './entry-type.js';
import type { BrowserOptions, ExecutionOptions, InteractiveOptions, PresentationOptions } from './types.js';
import { validatePresentation } from '../presentation.js';

export interface Options {
  /** Notebook presentation defaults, overridden by page frontmatter and cell tags. */
  presentation?: PresentationOptions;
  execution?: ExecutionOptions;
  interactive?: InteractiveOptions | false;
  references?: Record<string, { url?: string; file?: URL; base?: string; refresh?: boolean }>;
  localInventory?: URL;
  referenceCache?: URL;
  documents?: URL;
}
const require = createRequire(import.meta.url);
const bundled: string[] = JSON.parse(readFileSync(new URL('../bundled-dependencies.json', import.meta.url), 'utf8'));
// Static-copy sources are glob patterns, where backslashes escape rather than separate.
const posix = (path: string) => path.split(sep).join('/');
type CopyTarget = Parameters<typeof viteStaticCopy>[0]['targets'][number];

/** MyST parsing, build execution, and optional Xeus notebooks as one Astro integration. */
export default function notebooks(options: Options = {}): AstroIntegration {
  if ('inputVisibility' in options) throw new Error('inputVisibility was removed in 0.4; use presentation.input: show, hide, or remove');
  validatePresentation(options.presentation);
  let finalConfig: AstroConfig | undefined;
  return {
    name: 'astro-myst-notebooks',
    hooks: {
      'astro:config:done': ({ config }) => { finalConfig = config; },
      'astro:config:setup': async (setup) => {
        const { config, updateConfig, injectScript, command, logger } = setup;
        const paths = notebookPaths(config);
        // Notebooks render through the same processor once every integration has configured it.
        // Astro defines addContentEntryType as a non-enumerable hook property.
        (setup as unknown as { addContentEntryType(type: ContentEntryType): void }).addContentEntryType(notebookEntryType(() => {
          if (!finalConfig) throw new Error('Notebook rendering requested before the Astro config was finalized');
          return finalConfig;
        }));
        // Preserve private dependency resolutions when Vite emits the SSR build.
        if (command === 'build') {
          const resolve = { noExternal: bundled };
          updateConfig({ vite: { environments: { ssr: { resolve }, prerender: { resolve } } } });
        }
        const execution = { ...options.execution, cwd: fileURLToPath(options.execution?.cwd ?? config.root) };
        const interactive = options.interactive !== false;
        if (command === 'build' || command === 'dev') await checkEnvironment(execution);
        updateConfig({ markdown: { processor: unified({
          remarkPlugins: [[remarkMyst, { root: options.execution?.cwd ?? config.root, documents: options.documents ?? paths.documents }],
            [remarkReferences, { references: options.references, localInventory: options.localInventory, cacheDir: options.referenceCache ?? paths.references }],
            [remarkJupyter, { ...execution, interactive, presentation: options.presentation }]],
          remarkRehype: mystRehype,
          rehypePlugins: [rehypeJupyter, rehypeKatex, rehypeMathErrors, [rehypeDocumentBase, { base: config.base }]],
        }) } });
        injectScript('page-ssr', `import ${JSON.stringify(fileURLToPath(new URL('./style.css', import.meta.url)))}; import ${JSON.stringify(require.resolve('katex/dist/katex.min.css'))};`);
        injectScript('page', `import ${JSON.stringify(fileURLToPath(new URL('./source-selection.js', import.meta.url)))};`);
        const prefix = sitePrefix(config);
        const runtimeBase = `${prefix}/notebooks`;
        const runtime = posix(fileURLToPath(new URL('./browser/', import.meta.url)));
        const targets: CopyTarget[] = [{ src: `${runtime}*.{js,map}`, dest: 'notebooks', rename: { stripBase: true } }];
        injectScript('page', `const runtimeBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ runtimeBase + '/client.js');`);
        if (interactive && (command === 'build' || command === 'dev')) {
          const settings = options.interactive || {};
          if ('xeus' in settings || 'packages' in settings) throw new Error('Use interactive.environment for the Xeus environment; Pyodide and interactive.xeus were removed in 0.3');
          const environment = await buildEnvironment(settings, { root: config.root, cache: paths.cache, python: execution.python, log: message => logger.info(message) });
          const browser: BrowserOptions = {
            assetBase: `${prefix}/thebe`, setup: settings.setup ?? '',
            kernelName: settings.kernelName ?? 'xpython', startupTimeout: settings.startupTimeout ?? 120000,
            wheelPath: environment.wheelPath,
          };
          const assets = posix(fileURLToPath(new URL('./browser/assets/', import.meta.url)));
          const xeus = join(environment.directory, 'xeus');
          const depth = relative(fileURLToPath(config.root), xeus).split(sep).filter(part => part && part !== '..').length;
          targets.push({ src: `${assets}*`, dest: 'thebe', rename: { stripBase: true } },
            { src: posix(xeus), dest: 'thebe/xeus', rename: { stripBase: depth } });
          injectScript('page', `const notebookBase = ${JSON.stringify(runtimeBase)}; import(/* @vite-ignore */ notebookBase + '/element.js').then(({ defineNotebooks }) => defineNotebooks(${JSON.stringify(browser)}));`);
        }
        updateConfig({ vite: { plugins: viteStaticCopy({ targets }) } });
      },
    },
  };
}
