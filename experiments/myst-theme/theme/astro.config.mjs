import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import notebooks from '../../../dist/notebooks/index.js';
import { fetchJson, pagesFromManifest } from './content.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const project = pathToFileURL(process.env.ASTRO_MYST_PROJECT + '/');

const manifest = await fetchJson('/config.json');
const pages = pagesFromManifest(manifest);

export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  outDir: process.env.BUILD_DIRECTORY,
  // Keep each consumer's content and dependency cache separate.
  cacheDir: resolve(process.env.ASTRO_MYST_PROJECT, '_build/.astro'),
  integrations: [
    starlight({
      title: manifest.projects[0].title,
      components: { PageTitle: 'astro-myst-notebooks/starlight/PageTitle.astro' },
      sidebar: pages.map(page => ({ label: page.title, slug: page.id })),
    }),
    // Only the runtime/assets hooks are used here: the content loader already
    // renders resolved trees and never invokes this integration's source parser.
    notebooks({
      execution: { python: process.env.MYST_EXECUTION_PYTHON ?? 'python', cwd: project, timeout: 30 },
      interactive: { environment: new URL('../../../docs/environment.yml', import.meta.url) },
    }),
  ],
});
