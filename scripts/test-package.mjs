import { access, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { Inventory } from 'intersphinx';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
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
if (api) await writeFile(join(root, 'example.py'), `"""A small Python API."""

def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

class Base:
    def __init__(self, value: int = 2):
        """Construct a stored value."""
        self.value = value
    def inherited(self) -> int:
        """Read an inherited stored value."""
        return self.value

class Child(Base):
    """A class with an inherited constructor and member."""
`);
// Install and execute the CLI from the artifact, without linking to this checkout.
run('npm',['exec','--yes',`--package=${archive}`,'--','astro-myst-notebooks','init','--package',archive,...(api?['--api','example']:[])]);
// Exercise the bundled MyST extensions and notebook loader from the archive.
await writeFile(join(root, 'docs/src/content/docs/features.md'), [
  '---', 'title: Packaged authoring', '---', '',
  '```{code-cell} python', 'answer = 6 * 7', '```', '',
  'The packaged result is {eval}`answer`.', '',
  '```{code-cell} python', 'from IPython.display import display',
  'display({"application/vnd.plotly.v1+json": {"data": [{"x": [1, 2, 3], "y": [1, 4, 2], "type": "scatter"}], "layout": {"height": 280, "yaxis": {"title": {"text": "$C/k_B$"}}}}}, raw=True)',
  '```', '',
  '::::{tab-set}', ':::{tab-item} First', 'Packaged first tab.', ':::',
  ':::{tab-item} Second', 'Packaged second tab.', ':::', '::::', '',
  '::::{grid} 1 2', ':::{card} Welcome', ':link: index.md',
  'Packaged card.', ':::', '::::', '',
  '(packaged-equation)=', '```{math}',
  String.raw`\mathcal{H}=\begin{pmatrix} H_0^{AA}&0\\0&H_0^{BB}\end{pmatrix}+\sum_{n\ge1}H_n^{\prime},\qquad U=\sum_{n=0}^{\infty}U_n`,
  '```', '',
].join('\n'));
await writeFile(join(root, 'docs/src/content/docs/notebook.ipynb'), JSON.stringify({
  nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: '---\ntitle: Packed notebook\n---\n' },
    { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: 'print("Notebook from packed loader")' },
  ],
}));
if (api) await writeFile(join(root,'docs/src/content/docs/api-example.md'),'---\ntitle: API example\n---\n\n```{autodoc} example.add\n```\n\nUse {autolink}`~example.add`.\n');
await writeFile(join(root, 'docs/src/content/docs/references.bib'), '@article{packaged2026, title={A packaged citation}, author={Example, Ada}, journal={Example Journal}, year={2026}}\n');
await writeFile(join(root, 'docs/src/content/docs/citations.md'), '# Packaged citations\n\nSee {cite:p}`packaged2026`.\n\n```{bibliography}\n```\n');
await writeFile(join(root, 'docs/myst.yml'), (await readFile(join(root, 'docs/myst.yml'), 'utf8')) + '  bibliography:\n    - src/content/docs/references.bib\n');
const configPath = join(root, 'docs/astro.config.mjs');
const config = await readFile(configPath, 'utf8');
await writeFile(configPath, config.replace('notebooks({', "notebooks({ presentation: { input: 'hide' },"));
const environmentPath = join(root, 'docs/environment.yml');
await rename(environmentPath, environmentPath + '.optional');
run('pixi',['run','-e','docs','docs']);
const html=await readFile(join(root,'docs/dist/index.html'),'utf8');
assert.match(html,/Hello from Jupyter/);
assert.match(html, /<details class="jupyter-input-area jupyter-input-disclosure">/);
assert.doesNotMatch(html, /<jupyter-notebook|data-thebe-controls/);
const thebe = join(root, 'docs/dist/thebe');
await assert.rejects(access(thebe), { code: 'ENOENT' });
const runtime = join(root, 'docs/dist/notebooks');
const staticFiles = await readdir(runtime, { recursive: true });
assert.ok(staticFiles.some(name => name.endsWith('/client.js')));
assert.ok(staticFiles.some(name => name.endsWith('/mathjax-tex-svg.js')));
assert.ok(!staticFiles.some(name => name.endsWith('/element.js')));
const features = await readFile(join(root, 'docs/dist/features/index.html'), 'utf8');
assert.match(features, /role="tab"/);
assert.match(features, /class="card/);
const inlineResults = [];
const textContent = node => node.type === 'text' ? node.value : (node.children ?? []).map(textContent).join('');
visit(fromHtml(features), 'element', node => {
  if (node.properties.className?.includes('jupyter-inline')) inlineResults.push(textContent(node));
});
assert.ok(inlineResults.includes('42'), 'the computed inline expression must publish 42');
assert.match(features, /data-source-location=/);
assert.match(features, /Packaged first tab/);
assert.match(features, /Packaged second tab/);
assert.match(await readFile(join(root, 'docs/dist/citations/index.html'), 'utf8'), /A packaged citation/);
await access(join(root, 'docs/dist/_myst/config.json'));
await access(join(root, 'docs/dist/myst.xref.json'));
await access(join(root, 'docs/dist/objects.inv'));
assert.match(await readFile(join(root, 'docs/dist/notebook/index.html'), 'utf8'), /Notebook from packed loader/);
if (api) assert.match(await readFile(join(root,'docs/dist/api-example/index.html'),'utf8'),/Add two integers/);
if (api) {
  assert.match(await readFile(join(root, 'docs/dist/api/example/index.html'), 'utf8'), /A small Python API/);
  const child = await readFile(join(root, 'docs/dist/api/example/Child/index.html'), 'utf8');
  assert.match(child, /Construct a stored value/);
  assert.match(child, /Read an inherited stored value/);
  const inventory = new Inventory({ path: join(root, 'docs/dist/objects.inv') });
  await inventory.load();
  assert.match(inventory.data['py:function']['example.add'].location, /api-example.*#py-/);
  assert.ok(inventory.data['py:method']['example.Child.inherited']);
}
const installed=JSON.parse(await readFile(join(root,'docs/node_modules/astro-myst-notebooks/package.json'),'utf8'));
const packageRoot = join(root, 'docs/node_modules/astro-myst-notebooks');
const exportTargets = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(exportTargets);
for (const path of [...exportTargets(installed.exports), ...Object.values(installed.bin),
  'LICENSE', 'npm-shrinkwrap.json', 'dist/execute.py', 'dist/environment-contract.json',
  'dist/notebooks/style.css', 'dist/engine/autodoc/extract.py', 'dist/engine/autodoc/index.mjs', 'dist/notebooks/browser/LICENSES.txt',
  'dist/notebooks/browser/DEPENDENCIES.json', 'dist/DEPENDENCY-PATCHES.json']) {
  await access(join(packageRoot, path));
}
assert.equal(installed.scripts, undefined, 'archive must not run checkout-only build hooks');
assert.equal(installed.devDependencies, undefined, 'archive must not require development dependencies');
assert.ok(!Object.keys(installed.dependencies).some(name=>/^thebe|^@jupyter|^@lumino/.test(name)));
await access(join(packageRoot, 'dist/notebooks/browser/client.js.map'));
const modules=JSON.parse(await readFile(join(root,'docs/package-lock.json'),'utf8')).packages;
assert.ok(!Object.keys(modules).some(name=>/node_modules\/(thebe-lite|starlight-pydocs|@jupyterlite\/pyodide-kernel)$/.test(name)));
assert.ok(!Object.keys(modules).some(name => name.startsWith('packages/') || name.includes('myst-python-autodoc')), 'root consumer must not depend on checkout workspaces');
run('pixi',['run','-e','docs','--dry-run','docs-dev']);
run('pixi',['run','-e','docs','--dry-run','docs-dev','51559']);
// Rebuild under a prefix and opt in to the live runtime for the browser gate.
await rename(environmentPath + '.optional', environmentPath);
const interactive = values.browser ? '{}' : 'false';
await writeFile(configPath, config.replace('notebooks({', `notebooks({ interactive: ${interactive}, presentation: { input: 'remove' },`));
run('pixi',['run','-e','docs','npm','--prefix','docs','run','build','--','--base','/manual/']);
const prefixed = await readFile(join(root,'docs/dist/index.html'),'utf8');
assert.match(prefixed,/\/manual\/_astro\//);
assert.match(prefixed, /class="jupyter-static-input"><\/div>/);
assert.doesNotMatch(prefixed, /class="jupyter-input-area jupyter-input-disclosure"/);
const deployedFiles = await readdir(runtime, { recursive: true });
assert.ok(!deployedFiles.some(name => name.endsWith('.map')), 'debug source maps must not consume deployment space');
let runtimeBytes = 0;
for (const name of deployedFiles.filter(name => name.endsWith('.js'))) {
  runtimeBytes += (await stat(join(runtime, name))).size;
  assert.equal(/(?:^|\n)\/\/[#@] sourceMappingURL=[^\n]+\s*$/.test(await readFile(join(runtime, name), 'utf8')), false, 'deployed scripts must not reference omitted maps');
}
assert.ok(runtimeBytes < 20_000_000, `Notebook JavaScript exceeds the 20 MB deployment budget: ${runtimeBytes} bytes`);
if (values.browser) {
  assert.ok(deployedFiles.some(name => name.endsWith('/element.js')));
  const thebeFiles = await readdir(thebe, { recursive: true });
  assert.ok(thebeFiles.some(name => name.endsWith('/thebe.css')));
  run(process.execPath, [fileURLToPath(new URL('./check-consumer-browser.mjs', import.meta.url)),
    join(root, 'docs'), process.env.DOCS_PORT ?? '51488', '/manual/']);
} else {
  assert.doesNotMatch(prefixed, /<jupyter-notebook|data-thebe-controls/);
  await assert.rejects(access(thebe), { code: 'ENOENT' });
}
console.log(`Packed release passed. Consumer retained for browser inspection: ${root}`);
