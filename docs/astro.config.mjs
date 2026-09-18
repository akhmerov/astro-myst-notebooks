import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import notebooks from 'astro-myst-notebooks/starlight';

export default defineConfig({
  // Exercise deployment under a prefix as well as at the origin root.
  base: process.env.DOCS_BASE ?? '/',
  integrations: [
    starlight({
      title: 'Astro MyST Notebooks',
      plugins: [notebooks({
        execution: { cwd: new URL('../', import.meta.url), timeout: 30 },
        interactive: { mounts: [
          { source: new URL('./data/measurements/', import.meta.url), target: '/data/measurements' },
          { source: new URL('./data/description.txt', import.meta.url), target: '/data' },
        ] },
      })],
      description: 'Executable MyST documentation for Astro and Starlight.',
      sidebar: [
        { label: 'Overview', slug: '' },
        { label: 'Set up a site', slug: 'setup' },
        { label: 'Executable walkthrough', slug: 'walkthrough' },
        { label: 'Author MyST', slug: 'authoring' },
        { label: 'Notebook source', slug: 'notebook' },
        { label: 'Browser execution', slug: 'browser' },
        { label: 'Configuration and API', slug: 'reference' },
        { label: 'Development', slug: 'development' },
      ],
    }),
  ],
});
