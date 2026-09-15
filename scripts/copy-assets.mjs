import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir(new URL('../dist/templates/', import.meta.url), { recursive: true });
for (const path of ['execute.py', 'griffe_myst.py', 'AutodocContent.astro', 'ApiSummary.astro', 'CheckedDocstrings.astro',
  'execution-contract.json', 'environment-contract.json', 'notebooks/style.css', 'templates/environment.yml',
  'starlight/api.ts', 'starlight/PageTitle.astro']) {
  await copyFile(new URL(`../src/${path}`, import.meta.url), new URL(`../dist/${path}`, import.meta.url));
}
await chmod(new URL('../dist/cli.mjs', import.meta.url), 0o755);
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bundled = [...new Set(Object.entries(lock.packages).filter(([, entry]) => entry.inBundle)
  .map(([path]) => path.split('node_modules/').pop()))];
await writeFile(new URL('../dist/bundled-dependencies.json', import.meta.url), JSON.stringify(bundled));
