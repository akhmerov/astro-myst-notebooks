import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VFile } from 'vfile';
import { createDocumentExecution } from '../dist/engine/execution.mjs';

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'myst-execution-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function pageTree(source = 'print(42)', tags = []) {
  return { type: 'root', children: [{ type: 'block', kind: 'notebook-code', data: { tags }, children: [
    { type: 'code', lang: 'python', executable: true, value: source },
    { type: 'outputs', children: [{ type: 'output', jupyter_data: { output_type: 'stream', name: 'stdout', text: 'old' } }] },
  ] }] };
}
const transform = (plugin, tree, path) => plugin.transforms[0].plugin()(tree, new VFile({ path }));
const output = tree => tree.children[0].children.find(node => node.type === 'outputs').children[0]?.jupyter_data;
const fake = async items => ({ notebook: { cells: items.filter(i => i.kind === 'cell').map(i => ({ id: i.id,
  outputs: [{ output_type: 'stream', name: 'stdout', text: i.source }] })) }, expressions: {} });


test('skip_execution, execute.skip precedence and per-cell skip never run skipped code or retain saved outputs', () => fixture(async root => {
  const path = join(root, 'page.md'); let executions = 0;
  const plugin = createDocumentExecution({ root, runDocument: async items => { executions++; return fake(items); } });
  for (const metadata of ['skip_execution: true', 'execute:\n  skip: true']) {
    await writeFile(path, `---\n${metadata}\n---\n`);
    const tree = pageTree('raise RuntimeError("must not run")');
    await transform(plugin, tree, path);
    assert.equal(output(tree), undefined);
  }
  await writeFile(path, '');
  const skipped = pageTree('raise RuntimeError("must not run")', ['skip-execution']);
  await transform(plugin, skipped, path); assert.equal(output(skipped), undefined); assert.equal(executions, 0);
  await writeFile(path, '---\nskip_execution: true\nexecute:\n  skip: false\n---\n');
  const explicit = pageTree('print("canonical setting wins")');
  await transform(plugin, explicit, path); assert.equal(executions, 1);
  assert.equal(output(explicit).text, 'print("canonical setting wins")');
}));

test('unsupported or malformed execution settings fail explicitly; supported kernel aliases retain selected Python', () => fixture(async root => {
  const path = join(root, 'page.md');
  const cases = [
    ['execute: true', /execute must be an object/], ['execute:\n  timeout: 5', /execute.timeout/],
    ['execute:\n  cache: wrong', /cache must be a boolean/], ['execute:\n  depends_on_env: VALUE', /depends_on_env must be a list/],
    ['kernelspec:\n  name: remote-python', /kernelspec.name.*selected Pixi Python/],
    ['kernelspec:\n  language: julia', /Unsupported execution language/],
  ];
  const plugin = createDocumentExecution({ root, runDocument: fake });
  for (const [metadata, pattern] of cases) {
    await writeFile(path, `---\n${metadata}\n---\n`);
    await assert.rejects(transform(plugin, pageTree(), path), pattern);
  }
  await writeFile(path, '---\nkernelspec:\n  name: python3\n  language: python\noptions:\n  presentation:\n    input: hide\n  thebe: false\n---\n');
  const tree = pageTree(); await transform(plugin, tree, path);
  assert.deepEqual(tree.data.astroNotebook, { presentation: { input: 'hide' }, thebe: false });
}));

test('real execution reuses prose-only rebuilds and new CLI instances but invalidates Python imports, environment dependencies and disabled cache', () => fixture(async root => {
  const path = join(root, 'page.md'); const counter = join(root, 'executions.txt');
  const source = 'from pathlib import Path\nfrom local_input import VALUE\np = Path("executions.txt")\np.write_text(str(int(p.read_text()) + 1) if p.exists() else "1")\nprint(VALUE)';
  const metadata = '---\nexecute:\n  depends_on_env: [ASTRO_EXECUTION_TEST_INPUT]\n---\n';
  await writeFile(join(root, 'local_input.py'), 'VALUE = 42\n'); await writeFile(path, metadata + 'Initial prose.');
  const previous = process.env.ASTRO_EXECUTION_TEST_INPUT;
  process.env.ASTRO_EXECUTION_TEST_INPUT = 'one';
  try {
    let plugin = createDocumentExecution({ root, cwd: root });
    let tree = pageTree(source); await transform(plugin, tree, path); assert.equal(output(tree).text, '42\n');
    await writeFile(path, metadata + 'Edited prose only.');
    tree = pageTree(source); await transform(plugin, tree, path); assert.equal(await readFile(counter, 'utf8'), '1');
    plugin = createDocumentExecution({ root, cwd: root });
    tree = pageTree(source); await transform(plugin, tree, path); assert.equal(await readFile(counter, 'utf8'), '1');
    await writeFile(join(root, 'local_input.py'), 'VALUE = 100\n');
    tree = pageTree(source); await transform(plugin, tree, path); assert.equal(output(tree).text, '100\n');
    assert.equal(await readFile(counter, 'utf8'), '2');
    process.env.ASTRO_EXECUTION_TEST_INPUT = 'two';
    await transform(plugin, pageTree(source), path); assert.equal(await readFile(counter, 'utf8'), '3');
    await writeFile(path, '---\nexecute:\n  cache: false\n---\n');
    await transform(plugin, pageTree(source), path); await transform(plugin, pageTree(source), path);
    assert.equal(await readFile(counter, 'utf8'), '5');
  } finally {
    if (previous === undefined) delete process.env.ASTRO_EXECUTION_TEST_INPUT;
    else process.env.ASTRO_EXECUTION_TEST_INPUT = previous;
  }
}));

test('concurrent document transforms share the configured kernel limit and failed runs remain retryable', () => fixture(async root => {
  let active = 0, maximum = 0;
  const plugin = createDocumentExecution({ root, concurrency: 1, runDocument: async items => {
    active++; maximum = Math.max(maximum, active); await delay(25); active--; return fake(items);
  } });
  const paths = [0, 1, 2].map(i => join(root, `${i}.md`));
  await Promise.all(paths.map(path => writeFile(path, '')));
  await Promise.all(paths.map(path => transform(plugin, pageTree(path), path)));
  assert.equal(maximum, 1);
  let attempts = 0;
  const retry = createDocumentExecution({ root, runDocument: async items => { if (++attempts === 1) throw new Error('transient kernel failure'); return fake(items); } });
  await assert.rejects(transform(retry, pageTree('retry cell'), paths[0]), /transient kernel failure/);
  await transform(retry, pageTree('retry cell'), paths[0]); assert.equal(attempts, 2);
}));

test('editing a data file in a declared directory inside the project invalidates the execution cache', () => fixture(async root => {
  const page = join(root, 'page.md');
  const input = join(root, 'data', 'measurements.csv');
  await mkdir(join(root, 'data'));
  await writeFile(page, 'A notebook reading measurements.');
  await writeFile(input, 'value\n42\n');
  const plugin = createDocumentExecution({ root, cwd: root, dependencies: ['data'] });
  const code = 'from pathlib import Path\nprint(Path("data/measurements.csv").read_text().splitlines()[1])';
  const first = pageTree(code);
  await transform(plugin, first, page);
  assert.equal(output(first).text, '42\n');
  await writeFile(input, 'value\n43\n');
  const second = pageTree(code);
  await transform(plugin, second, page);
  assert.equal(output(second).text, '43\n');
}));
