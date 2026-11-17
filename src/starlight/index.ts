import type { StarlightPlugin } from '@astrojs/starlight/types';
import notebooks, { type Options } from '../notebooks/index.js';

export type StarlightNotebookOptions = Options;

/** Consumer-owned Starlight with the same MyST compiler as plain Astro. */
export default function starlightNotebooks(options: StarlightNotebookOptions = {}): StarlightPlugin {
  return { name: 'astro-myst-notebooks/starlight', hooks: {
    'config:setup': ({ config, updateConfig, addIntegration }) => {
      updateConfig({ components: { ...config.components,
        PageTitle: config.components?.PageTitle ?? 'astro-myst-notebooks/starlight/PageTitle.astro' } });
      addIntegration(notebooks(options));
    },
  } };
}
