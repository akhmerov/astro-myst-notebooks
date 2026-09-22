import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'astro';
import { fetchJson } from './content.mjs';

if (!process.env.CONTENT_CDN || !process.env.BUILD_DIRECTORY) {
  throw new Error('Run this theme with myst build --html (mystmd >= 1.11.0)');
}
if (!process.env.ASTRO_MYST_PROJECT) {
  throw new Error('Use experiments/myst-theme/build.mjs to pass the project execution directory');
}
// The MyST hook passes a path relative to the project but runs in the theme.
process.env.BUILD_DIRECTORY = resolve(process.env.ASTRO_MYST_PROJECT, process.env.BUILD_DIRECTORY);
await build({ root: fileURLToPath(new URL('./', import.meta.url)) });

// With build.render the theme owns content assets and inventories as well as
// HTML. The CLI only adds explicitly configured static_files afterwards.
const publicFiles = await fetchJson('/public.json');
for (const path of [...publicFiles, 'objects.inv', 'myst.xref.json', 'myst.search.json']) {
  const response = await fetch(new URL(path, process.env.CONTENT_CDN));
  if (!response.ok) throw new Error(`Unable to copy MyST asset: ${path}`);
  const destination = resolve(process.env.BUILD_DIRECTORY, path.replace(/^\//, ''));
  if (!destination.startsWith(process.env.BUILD_DIRECTORY + '/')) throw new Error('Invalid MyST asset path');
  await mkdir(dirname(destination), { recursive: true });
  if (path === 'myst.xref.json') {
    const xrefs = await response.json();
    for (const ref of xrefs.references ?? []) ref.data = ref.data?.replace(/^\/content/, '');
    await writeFile(destination, JSON.stringify(xrefs));
  } else await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}
