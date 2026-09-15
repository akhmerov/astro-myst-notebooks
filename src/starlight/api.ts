// Like starlight-pydocs itself, this config entry is TypeScript so Astro loads
// the peer's source before invoking hooks. Node cannot dynamically import a
// TypeScript dependency from a hook after configuration has been evaluated.
import type { StarlightPlugin } from '@astrojs/starlight/types';
import pydocs from 'starlight-pydocs';
import notebooks, { type StarlightNotebookOptions } from './index.js';
export default function notebooksWithApi(options: StarlightNotebookOptions): StarlightPlugin {
  return notebooks(options, pydocs);
}
