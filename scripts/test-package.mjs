import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: {
  api: { type: 'boolean' }, browser: { type: 'boolean' }, archive: { type: 'string' },
} });
const pkg = JSON.parse(await readFile('package.json','utf8'));
const archive = values.archive ?? resolve(`astro-myst-notebooks-${pkg.version}.tgz`);
const api = values.api;
const root = await mkdtemp(join(tmpdir(),'notebooks-release-'));
function run(command,args,cwd=root) {
  const commandArgs = command === 'pixi' ? [args[0], '--manifest-path', join(root, 'pixi.toml'), ...args.slice(1)] : args;
  const result=spawnSync(command,commandArgs,{cwd,stdio:'inherit',env:process.env});
  assert.equal(result.status,0,`${command} failed in ${cwd}`);
}
console.log(`Testing packed release in ${root}`);
if (api) await writeFile(join(root, 'example.py'), '\"\"\"A small Python API.\"\"\"\n\ndef add(a: int, b: int) -> int:\n    \"\"\"Add two integers.\"\"\"\n    return a + b\n');
// Install and execute the CLI from the artifact, without linking to this checkout.
run('npm',['exec','--yes',`--package=${archive}`,'--','astro-myst-notebooks','init','--package',archive,...(api?['--api','example']:[])]);
// Exercise the bundled MyST extensions and notebook loader from the archive.
await writeFile(join(root, 'docs/src/content/docs/features.md'), [
  '---', 'title: Packaged authoring', '---', '',
  '```{code-cell} python', 'answer = 6 * 7', '```', '',
  'The packaged result is {eval}`answer`.', '',
  '::::{tab-set}', ':::{tab-item} First', 'Packaged first tab.', ':::',
  ':::{tab-item} Second', 'Packaged second tab.', ':::', '::::', '',
  '::::{grid} 1 2', ':::{card} Welcome', ':link: index.md',
  'Packaged card.', ':::', '::::', '',
].join('\n'));
await writeFile(join(root, 'docs/src/content/docs/notebook.ipynb'), JSON.stringify({
  nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: '---\ntitle: Packed notebook\n---\n' },
    { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: 'print("Notebook from packed loader")' },
  ],
}));
if (api) await writeFile(join(root,'docs/src/content/docs/api-example.md'),'---\ntitle: API example\n---\n\n```{autodoc} example.add\n```\n');
if (api) await writeFile(join(root,'docs/src/middleware.ts'), `
import { defineMiddleware } from 'astro:middleware';
import { autodocOutline } from 'astro-myst-notebooks/autodoc';
export const onRequest = defineMiddleware((_context, next) => {
  if (autodocOutline('## API\\n\\n\\x60\\x60\\x60{autodoc} example.add\\n\\x60\\x60\\x60').length !== 1) throw new Error('API outline missing');
  return next();
});
`);
const configPath = join(root, 'docs/astro.config.mjs');
const config = await readFile(configPath, 'utf8');
await writeFile(configPath, config.replace('notebooks({', "notebooks({ inputVisibility: 'collapsed',"));
run('pixi',['run','-e','docs','docs']);
const html=await readFile(join(root,'docs/dist/index.html'),'utf8');
assert.match(html,/Hello from Jupyter/);
assert.match(html, /<details class="jupyter-input">/);
const features = await readFile(join(root, 'docs/dist/features/index.html'), 'utf8');
assert.match(features, /role="tab"/);
assert.match(features, /class="card/);
assert.match(features, /jupyter-inline[^>]*>42</);
assert.match(await readFile(join(root, 'docs/dist/notebook/index.html'), 'utf8'), /Notebook from packed loader/);
if (api) assert.match(await readFile(join(root,'docs/dist/api-example/index.html'),'utf8'),/Add two integers/);
const installed=JSON.parse(await readFile(join(root,'docs/node_modules/astro-myst-notebooks/package.json'),'utf8'));
const packageRoot = join(root, 'docs/node_modules/astro-myst-notebooks');
const exportTargets = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(exportTargets);
for (const path of [...exportTargets(installed.exports), ...Object.values(installed.bin),
  'LICENSE', 'npm-shrinkwrap.json', 'dist/execute.py', 'dist/environment-contract.json',
  'dist/notebooks/style.css', 'dist/notebooks/browser/LICENSES.txt',
  'dist/notebooks/browser/DEPENDENCIES.json', 'dist/DEPENDENCY-PATCHES.json']) {
  await access(join(packageRoot, path));
}
assert.equal(installed.scripts, undefined, 'archive must not run checkout-only build hooks');
assert.equal(installed.devDependencies, undefined, 'archive must not require development dependencies');
assert.ok(!Object.keys(installed.dependencies).some(name=>/^thebe|^@jupyter|^@lumino/.test(name)));
const modules=JSON.parse(await readFile(join(root,'docs/package-lock.json'),'utf8')).packages;
assert.ok(!Object.keys(modules).some(name=>/node_modules\/(thebe-lite|@jupyterlite\/pyodide-kernel)$/.test(name)));
run('pixi',['run','-e','docs','--dry-run','docs-dev']);
run('pixi',['run','-e','docs','--dry-run','docs-dev','51559']);
// Rebuild under a prefix, exercising the same cached environment.
await writeFile(configPath, config.replace('notebooks({', "notebooks({ inputVisibility: 'hidden',"));
run('pixi',['run','-e','docs','npm','--prefix','docs','run','build','--','--base','/manual/']);
const prefixed = await readFile(join(root,'docs/dist/index.html'),'utf8');
assert.match(prefixed,/\/manual\/_astro\//);
assert.match(prefixed, /class="jupyter-static-input"><\/div>/);
assert.doesNotMatch(prefixed, /class="jupyter-input"/);
if (values.browser) {
  run(process.execPath, [fileURLToPath(new URL('./check-consumer-browser.mjs', import.meta.url)),
    join(root, 'docs'), process.env.DOCS_PORT ?? '51488', '/manual/']);
}
console.log(`Packed release passed. Consumer retained for browser inspection: ${root}`);
