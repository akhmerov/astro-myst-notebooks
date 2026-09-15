import { copyFile } from 'node:fs/promises';
for (const path of ['execute.py', 'griffe_myst.py', 'AutodocContent.astro', 'ApiSummary.astro', 'CheckedDocstrings.astro', 'execution-contract.json', 'notebooks/style.css']) {
  await copyFile(new URL(`../src/${path}`, import.meta.url), new URL(`../dist/${path}`, import.meta.url));
}
const { mkdir, chmod } = await import('node:fs/promises');
await copyFile(new URL('../src/environment-contract.json', import.meta.url), new URL('../dist/environment-contract.json', import.meta.url));
await mkdir(new URL('../dist/templates/', import.meta.url), { recursive: true });
await copyFile(new URL('../src/templates/environment.yml', import.meta.url), new URL('../dist/templates/environment.yml', import.meta.url));
await chmod(new URL('../dist/cli.mjs', import.meta.url), 0o755);
await copyFile(new URL('../src/starlight/api.ts', import.meta.url), new URL('../dist/starlight/api.ts', import.meta.url));
await copyFile(new URL('../src/starlight/PageTitle.astro', import.meta.url), new URL('../dist/starlight/PageTitle.astro', import.meta.url));
const { readFile, writeFile } = await import('node:fs/promises');
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bundled = [...new Set(Object.entries(lock.packages).filter(([, entry]) => entry.inBundle)
  .map(([path]) => path.split('node_modules/').pop()))];
await writeFile(new URL('../dist/bundled-dependencies.json', import.meta.url), JSON.stringify(bundled));
