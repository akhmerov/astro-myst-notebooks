import { createAutodoc } from '../../packages/myst-autodoc/index.mjs';
import { fileURLToPath } from 'node:url';

export default createAutodoc({
  modules: ['theme_api'],
  searchPaths: [fileURLToPath(new URL('./project/', import.meta.url))],
});
