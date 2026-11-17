import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir(new URL('../dist/templates/', import.meta.url), { recursive: true });
for (const path of ['execute.py',
  'execution-contract.json', 'environment-contract.json', 'notebooks/style.css', 'templates/environment.yml',
  'starlight/PageTitle.astro']) {
  await copyFile(new URL(`../src/${path}`, import.meta.url), new URL(`../dist/${path}`, import.meta.url));
}
await chmod(new URL('../dist/cli.mjs', import.meta.url), 0o755);
// The standalone workspace is canonical. The root archive carries a runtime
// copy so consumers never need an unpublished workspace dependency or checkout.
await mkdir(new URL('../dist/engine/autodoc/', import.meta.url), { recursive: true });
for (const path of ['index.mjs', 'inventory.mjs', 'references.mjs', 'extract.py', 'LICENSE']) {
  await copyFile(new URL(`../packages/myst-autodoc/${path}`, import.meta.url), new URL(`../dist/engine/autodoc/${path}`, import.meta.url));
}
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bundled = [...new Set(Object.entries(lock.packages).filter(([, entry]) => entry.inBundle)
  .map(([path]) => path.split('node_modules/').pop()))];
await writeFile(new URL('../dist/bundled-dependencies.json', import.meta.url), JSON.stringify(bundled));
