import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experiment = dirname(fileURLToPath(import.meta.url));
const repo = resolve(experiment, '../..');
const cli = resolve(repo, 'node_modules/mystmd/dist/myst.cjs');
const selectedPython = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const nativePython = process.env.MYST_NATIVE_PYTHON ?? selectedPython;
const availableModes = ['render', 'native', 'native-uncached', 'native-digest', 'document'];
const modes = process.env.MYST_COMPARE_MODES?.split(',') ?? availableModes;
if (modes.some(mode => !availableModes.includes(mode))) throw new Error('Unknown comparison mode');
if (modes.some(mode => mode.startsWith('native'))) {
  const serverCheck = spawnSync(nativePython, ['-c', 'import jupyter_server'], { stdio: 'ignore' });
  if (serverCheck.status !== 0) throw new Error('Native comparisons need Jupyter Server; set MYST_NATIVE_PYTHON to a Python environment that provides it');
}
const root = await mkdtemp(join(tmpdir(), 'myst-execution-options-'));
const resultPath = resolve(process.argv[2] ?? join(root, 'results.json'));
const records = [];
const walk = (node, fn) => { fn(node); for (const child of node.children ?? []) walk(child, fn); };
const inlineValues = page => {
  const values = [];
  walk(page.mdast, node => { if (node.type === 'inlineExpression') values.push(node.result?.data?.['text/plain']); });
  return values;
};
const outputText = page => {
  const text = [];
  walk(page.mdast, node => { if (node.jupyter_data?.output_type === 'stream') text.push(node.jupyter_data.text); });
  return text.join('');
};

async function build(directory, mode, extra = [], deadline = 30000) {
  const native = mode.startsWith('native');
  const env = { ...process.env, MYST_THEME_EXECUTION: native ? 'native' : mode,
    ASTRO_MYST_PROJECT: directory,
    MYST_EXECUTION_PYTHON: selectedPython, MYST_EXECUTION_TIMEOUT: '1',
    JUPYTER_CONFIG_DIR: join(root, 'jupyter-config'), JUPYTER_RUNTIME_DIR: join(root, 'jupyter-runtime'),
    JUPYTER_DATA_DIR: join(root, 'jupyter-data') };
  delete env.JUPYTER_TOKEN;
  delete env.JUPYTER_BASE_URL;
  if (native) env.PATH = dirname(nativePython) + ':' + env.PATH;
  if (mode === 'native-digest') {
    // An explicit input list is intentional: this is not automatic Python
    // dependency discovery. Include environment identity as well as source.
    const hash = createHash('sha256').update(selectedPython);
    for (const path of ['helper.py', resolve(repo, 'pixi.lock')]) hash.update(await readFile(resolve(directory, path)));
    env.MYST_EXECUTION_DIGEST = hash.digest('hex');
  }
  const args = [cli, 'build', ...extra.length ? extra : ['--site'], '--strict'];
  if (native) args.push('--execute', '--execute-parallel', '1');
  const started = performance.now();
  const proc = spawn(process.execPath, args, { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  }, deadline);
  const exit = await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
  clearTimeout(timer);
  // MyST may log a Jupyter connection URL. Never print or persist raw output.
  const diagnostics = ['A cell timed out', 'expected failure', 'Inline expressions need execution',
    'Do not combine', 'does not support inline eval', 'Unsupported execution language',
    'does not support inherited configuration', 'Unresolved', 'Could not load', 'Please update']
    .concat(['MyST embed has no resolved content', 'Experimental theme does not render',
      'Inline expression has no computed output', 'EXDEV', 'ERR_MODULE_NOT_FOUND',
      'Cannot find package', 'Cannot read properties', 'Unable to copy MyST asset',
      'Unable to fetch MyST output', 'Invalid MyST'])
    .filter(text => output.includes(text));
  const record = { exit, expired, seconds: Number(((performance.now() - started) / 1000).toFixed(2)), diagnostics };
  if (exit !== 0) {
    // Return only ordinary exception lines; discard URLs and any line mentioning
    // credentials. Full CLI/Jupyter logs remain neither printed nor persisted.
    record.errors = (output.match(/(?:Error(?: \[[A-Z_]+\])?:|\[config\])[^\n]*/g) ?? [])
      .filter(line => !/https?:|token|secret|password|credential|authorization|bearer/i.test(line)).slice(-3);
  }
  if (exit === 0) {
    const page = JSON.parse(await readFile(join(directory, '_build/site/content/index.json')));
    record.inline = inlineValues(page);
    record.output = outputText(page);
    const reuse = JSON.parse(await readFile(join(directory, '_build/site/content/reuse.json')));
    record.reusedOutput = outputText(reuse);
  }
  try { record.runs = (await readFile(join(directory, 'runs.txt'), 'utf8')).trim().split('\n').length; }
  catch { record.runs = 0; }
  return record;
}

const source = (mode, { expression = true, code = 'x = 2', tags = '', policy = '' } = {}) => `---
kernelspec: {name: comparison-python, display_name: Comparison Python, language: python}
execute:
  cache: ${mode === 'native-uncached' ? 'false' : 'true'}
  depends_on_env: [MYST_EXECUTION_DIGEST]
${policy}---
# Execution probe

\`\`\`{code-cell} python
:label: probe-output
from pathlib import Path
from helper import value
x = 1
with Path('runs.txt').open('a') as runs:
    runs.write('run\\n')
print(f'OUTPUT-{value}')
\`\`\`

${expression ? 'First: {eval}`x`. Imported: {eval}`value`.' : ''}

\`\`\`{code-cell} python
${tags}${code}
\`\`\`

${expression ? 'Second: {eval}`x`.' : ''}
`;

await mkdir(join(root, 'jupyter-data/kernels/comparison-python'), { recursive: true });
await writeFile(join(root, 'jupyter-data/kernels/comparison-python/kernel.json'), JSON.stringify({
  argv: [selectedPython, '-m', 'ipykernel_launcher', '-f', '{connection_file}'], display_name: 'Comparison Python', language: 'python',
}));

try {
  for (const mode of modes) {
    const directory = join(root, mode);
    await mkdir(directory);
    // A consumer must have the theme's npm dependencies available. Reuse this
    // checkout's locked install, rather than downloading it for each fixture.
    await symlink(resolve(repo, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(join(directory, 'myst.yml'), `version: 1\nproject:\n  plugins: [${JSON.stringify(join(experiment, 'execution.mjs'))}]\n  toc:\n    - file: index.md\n    - file: reuse.md\nsite:\n  template: ${JSON.stringify(join(experiment, 'theme'))}\n`);
    await writeFile(join(directory, 'reuse.md'), '# Output reuse\n\n![](#probe-output)\n');
    await writeFile(join(directory, 'helper.py'), 'value = 11\n');
    await writeFile(join(directory, 'index.md'), source(mode));
    const row = { mode };
    records.push(row);
    row.initial = await build(directory, mode);
    // Render-stage execution does not compute the common document at all.
    assert.equal(row.initial.exit, 0, JSON.stringify(row.initial));
    if (mode === 'render') {
      assert.equal(row.initial.runs, 0);
      assert.equal(row.initial.output, '');
      assert.equal(row.initial.reusedOutput, '');
      await writeFile(join(directory, 'index.md'), source(mode, { expression: false }));
      row.html = await build(directory, mode, ['--html']);
      assert.equal(row.html.exit, 0, JSON.stringify(row.html));
      assert.equal(row.html.runs, 1);
      assert.match(await readFile(join(directory, '_build/html/index.html'), 'utf8'), /OUTPUT-11/);
      assert.doesNotMatch(await readFile(join(directory, '_build/html/reuse/index.html'), 'utf8'), /OUTPUT-11/);
      row.docx = await build(directory, mode, ['index.md', '--docx', '--site']);
      assert.equal(row.docx.exit, 0);
      const xml = spawnSync(selectedPython, ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode())', join(directory, '_build/exports/index.doc')], { encoding: 'utf8' });
      assert.equal(xml.status, 0);
      assert.doesNotMatch(xml.stdout, /OUTPUT-11/);
    } else {
      assert.deepEqual(row.initial.inline, ['1', '11', '2']);
      assert.equal(row.initial.runs, 1);
      assert.match(row.initial.reusedOutput, /OUTPUT-11/);
      row.unchanged = await build(directory, mode);
      assert.equal(row.unchanged.exit, 0);
      assert.equal(row.unchanged.runs, ['native', 'native-digest'].includes(mode) ? 1 : 2);
      await writeFile(join(directory, 'helper.py'), 'value = 1234\n');
      row.importChanged = await build(directory, mode);
      assert.equal(row.importChanged.exit, 0);
      assert.equal(row.importChanged.inline[1], mode === 'native' ? '11' : '1234');
      // Native execution runs this three-second cell successfully. The plugin
      // enforces its one-second cell timeout and fails the build.
      await writeFile(join(directory, 'index.md'), source(mode, { expression: false, code: 'import time\ntime.sleep(3)' }));
      row.slowCell = await build(directory, mode);
      assert.equal(row.slowCell.exit === 0, mode !== 'document', JSON.stringify(row.slowCell));
      if (mode === 'document') assert.ok(row.slowCell.diagnostics.includes('A cell timed out'));
      await writeFile(join(directory, 'index.md'), source(mode, { expression: false, code: 'raise ValueError("expected failure")' }));
      row.unexpectedError = await build(directory, mode);
      assert.notEqual(row.unexpectedError.exit, 0);
      await writeFile(join(directory, 'index.md'), source(mode, { expression: false,
        code: 'raise ValueError("expected failure")', tags: ':tags: [raises-exception]\n' }));
      row.expectedError = await build(directory, mode);
      assert.equal(row.expectedError.exit, 0);
      await writeFile(join(directory, 'index.md'), source(mode));
      row.docx = await build(directory, mode, ['index.md', '--docx', '--site']);
      assert.equal(row.docx.exit, 0, JSON.stringify(row.docx));
      const exported = join(directory, '_build/exports/index.doc');
      const xml = spawnSync(selectedPython, ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode())', exported], { encoding: 'utf8' });
      assert.equal(xml.status, 0, xml.stderr);
      assert.ok(xml.stdout.includes(mode === 'native' ? 'OUTPUT-11' : 'OUTPUT-1234'));
      assert.match(xml.stdout, /First:.*1/s);
      row.html = await build(directory, mode, ['--html']);
      assert.equal(row.html.exit, 0, JSON.stringify(row.html));
      const expected = mode === 'native' ? 'OUTPUT-11' : 'OUTPUT-1234';
      assert.ok((await readFile(join(directory, '_build/html/index.html'), 'utf8')).includes(expected));
      assert.ok((await readFile(join(directory, '_build/html/reuse/index.html'), 'utf8')).includes(expected));
      // A render must not execute the already computed document again.
      assert.equal(row.html.runs - row.docx.runs, ['native', 'native-digest'].includes(mode) ? 0 : 1);
    }
    console.log(`${mode}: validated (${row.initial.seconds}s first build)`);
  }
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify({ myst: '1.11.0', directory: root, selectedPython, records }, null, 2) + '\n');
  console.log(`Results: ${resultPath}`);
} catch (error) {
  await writeFile(join(root, 'partial-results.json'), JSON.stringify(records, null, 2));
  console.error(`Comparison failed; temporary fixtures: ${root}`);
  throw error;
}
