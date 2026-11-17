import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { toHtml } from 'hast-util-to-html';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { executePage } from '../dist/jupyter.mjs';
import { renderOutput } from '../dist/mime.mjs';
import { ansiToHast } from '../dist/ansi.mjs';
import { renderEngine as render } from './helpers/engine.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = fileURLToPath(new URL('../', import.meta.url));

const text = node => node.type === 'text' ? node.value : (node.children ?? []).map(text).join('');
const elements = html => {
  const result = [];
  visit(fromHtml(html, { fragment: true }), 'element', node => { result.push(node); });
  return result;
};

test('real Jupyter state, MIME bundles, display updates, clear_output, and kernel isolation', async () => {
  const notebook = await executePage([
    'from IPython.display import display, clear_output\nx = 41\nprint("setup")',
    'x + 1',
    'display({"text/html": "<b>rich</b>", "text/plain": "fallback"}, raw=True)',
    'handle = display("old", display_id=True)\nhandle.update("new")',
    'print("discard")\nclear_output(wait=True)\nprint("keep")',
  ], { cwd });
  assert.equal(notebook.cells[1].outputs[0].data['text/plain'], '42');
  assert.equal(notebook.cells[2].outputs[0].data['text/html'], '<b>rich</b>');
  assert.equal(notebook.cells[3].outputs[0].data['text/plain'], "'new'");
  assert.equal(notebook.cells[4].outputs[0].text, 'keep\n');
  const isolated = await executePage(['"x" in globals()'], { cwd });
  assert.equal(isolated.cells[0].outputs[0].data['text/plain'], 'False');
});

test('execution errors and per-cell timeouts reject', async () => {
  await assert.rejects(executePage(['raise ValueError("intentional-test-error")'], { cwd }), /intentional-test-error/);
  await assert.rejects(executePage(['import time; time.sleep(10)'], { cwd, timeout: 1 }), /CellTimeoutError/);
});

async function waitForKernel(path) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { return Number(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  throw new Error('Test kernel did not record its PID');
}

async function kernelGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
      // A killed orphan can remain a zombie until the container's init reaps
      // it. It is no longer executing and owns no memory or kernel resources.
      if (process.platform === 'linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return;
    } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return; throw error; }
    await delay(50);
  }
  assert.fail(`Kernel ${pid} survived execution teardown`);
}

test('the outer adapter deadline terminates a kernel stuck in a native call', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kernel-deadline-'));
  const path = join(directory, 'kernel.pid');
  try {
    const code = `import os, ctypes\nfrom pathlib import Path\nPath(${JSON.stringify(path)}).write_text(str(os.getpid()))\nctypes.CDLL(None).sleep(60)`;
    const result = executePage([code], { cwd: directory, timeout: 60, deadline: 5 });
    const rejection = assert.rejects(result, /Jupyter process deadline exceeded/);
    const pid = await waitForKernel(path);
    await rejection;
    await kernelGone(pid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('terminating the adapter cleans up its kernel independently of the nbclient event loop', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kernel-termination-'));
  const path = join(directory, 'kernel.pid');
  const child = spawn('python', [fileURLToPath(new URL('../dist/execute.py', import.meta.url))], {
    cwd: directory, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  child.stdin.end(JSON.stringify({ protocol: 1, operation: 'execute', cwd: directory, timeout: 60, deadline: 12,
    cells: [{ id: 'native-call', source: `import os, ctypes\nfrom pathlib import Path\nPath(${JSON.stringify(path)}).write_text(str(os.getpid()))\nctypes.CDLL(None).sleep(60)` }] }));
  try {
    const pid = await waitForKernel(path);
    child.kill('SIGTERM');
    const result = await exit;
    assert.equal(result.code, 143, stderr);
    await kernelGone(pid);
  } finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('raises-exception publishes the traceback and later cells keep running', async () => {
  const result = await render([
    '```{code-cell} python\n:tags: [raises-exception]\n\nraise ValueError("expected-test-error")\n```',
    '```{code-cell} python\nprint("still-running")\n```',
  ].join('\n\n'));
  assert.match(result, /data-tags="raises-exception"/);
  assert.match(result, /data-mime="application\/vnd.jupyter.error"><pre class="jupyter-error">/);
  assert.match(result, /class="ansi-[a-z-]*"[^>]*>ValueError/);
  assert.match(result, /expected-test-error/);
  assert.doesNotMatch(result, /\x1b/);
  assert.match(result, /<pre>still-running/);
  await assert.rejects(render('```{code-cell} python\nraise ValueError("untagged-test-error")\n```'), /untagged-test-error/);
});

test('skip-execution cells and execute.skip pages publish inputs without running', async () => {
  const skipped = await render([
    '```{code-cell} python\n:tags: [skip-execution]\n\nraise RuntimeError("skipped-cell-must-not-run")\n```',
    '```{code-cell} python\nprint("ran-anyway")\n```',
  ].join('\n\n'));
  assert.match(skipped, /data-tags="skip-execution"[^>]*>[\s\S]*?<div class="jupyter-static-input">[\s\S]*?skipped-cell-must-not-run[\s\S]*?<div class="jupyter-outputs"><\/div>/);
  assert.match(skipped, /<pre>ran-anyway/);
  for (const frontmatter of [{ execute: { skip: true } }, { skip_execution: true }]) {
    const page = await render('```{code-cell} python\nraise RuntimeError("page-must-not-run")\n```', frontmatter);
    assert.match(page, /page-must-not-run/);
    assert.match(page, /<div class="jupyter-outputs"><\/div>/);
  }
});

test('inline {eval} expressions see the kernel state at their position', async () => {
  const result = await render([
    '```{code-cell} python\nn = 8\n```',
    'Before: {eval}`n * (n + 1) // 2` and {eval}`f"{n:03d}"` and {eval}`__import__("IPython").display.HTML("<b>rich</b>")`.',
    '```{code-cell} python\nn = 2\n```',
    'After: {eval}`n`.',
  ].join('\n\n'));
  const nodes = elements(result);
  const inline = nodes.filter(node => node.properties.className?.includes('jupyter-inline'));
  assert.deepEqual(inline.map(text), ['36', "'008'", 'rich', '2']);
  assert.ok(inline.every(node => node.tagName === 'span' && node.properties.dataSourceGenerated === 'true'));
  assert.ok(inline[2].children.some(node => node.tagName === 'b' && text(node) === 'rich'));
  assert.ok(nodes.some(node => node.tagName === 'p' && text(node) === "Before: 36 and '008' and rich."));
  assert.ok(nodes.some(node => node.tagName === 'p' && text(node) === 'After: 2.'));
  assert.doesNotMatch(result, /<pre>36/);
  await assert.rejects(render('```{code-cell} python\nx = 1\n```\n\n{eval}`undefined_name`'), /NameError/);
  await assert.rejects(render('{eval}`1`', { execute: { skip: true } }), /execute\.skip/);
});

test('ANSI colours, bold, resets, 256-colour and truecolour codes become spans', () => {
  const html = toHtml({ type: 'root', children: ansiToHast('\x1b[1;31mbold red\x1b[0m plain \x1b[38;5;208morange\x1b[39m \x1b[48;2;1;2;3mbg\x1b[0m \x1b[2Kcleared') });
  assert.equal(html, '<span class="ansi-bold ansi-red-fg">bold red</span> plain <span style="color:rgb(255,135,0)">orange</span> <span style="background-color:rgb(1,2,3)">bg</span> cleared');
});

test('plain pages do not execute; hidden cells still share state', async () => {
  assert.match(await render('```python\nraise RuntimeError("must not execute")\n```'), /must not execute/);
  const result = await render([
    '```{code-cell} ipython3\n:tags: [remove-cell]\n\nx = 40\n```',
    '```{code-cell} ipython3\n:tags: [hide-input]\n\nx + 2\n```',
    '```{code-cell} ipython3\n:tags: [remove-output]\n\nprint("suppressed-output")\n```',
  ].join('\n\n'));
  assert.doesNotMatch(result, /<code[^>]*>x = 40/);
  assert.match(result, /data-source="x = 40"[^>]* hidden/);
  assert.match(result, /<details[^>]*><summary><span[^>]*>Show code<\/span><\/summary>/);
  assert.match(result, /<pre>42<\/pre>/);
  assert.doesNotMatch(result, /<pre>suppressed-output/);
  const streams = await render('```{code-cell} python\n:tags: [remove-stderr]\n\nimport sys\nprint("kept-stdout")\nprint("dropped-stderr", file=sys.stderr)\n"kept-result"\n```');
  const outputs = streams.slice(streams.indexOf('class="jupyter-outputs"'));
  assert.match(outputs, /<pre>kept-stdout/);
  assert.match(outputs, /kept-result/);
  assert.doesNotMatch(outputs, /dropped-stderr/);
});

test('presentation preserves execution, outputs, and explicit cell overrides', async () => {
  const cell = tags => `\`\`\`{code-cell} python\n:tags: [${tags}]\n\nprint("visible-result")\n\`\`\``;
  for (const input of ['show', 'hide', 'remove']) {
    const options = { presentation: { input } };
    const html = await render(cell(''), {}, options);
    assert.match(html, /data-source="print/);
    assert.match(html, /<pre>visible-result\n<\/pre>/);
    assert.equal(html.includes('<details'), input === 'hide');
    assert.equal(html.includes('<code'), input !== 'remove');
    const shown = await render(cell('show-input'), {}, options);
    assert.match(shown, /<code/);
    assert.doesNotMatch(shown, /<details/);
    assert.match(await render(cell('hide-input'), {}, options), /<details/);
    assert.doesNotMatch(await render(cell('remove-input'), {}, options), /<code/);
    assert.match(await render(cell('hide-cell'), {}, options), /Show cell/);
    assert.match(await render(cell('remove-cell'), {}, options), / hidden/);
    assert.match(await render('```python\nx = 1\n```', {}, options), /<code/);
  }
  await assert.rejects(render(cell(''), {}, { presentation: { input: 'typo' } }), /presentation.input/);
  await assert.rejects(render(cell('show-output, remove-output')), /Conflicting presentation tags/);
  const page = await render(cell(''), { presentation: { input: 'show', output: 'hide' } }, { presentation: { input: 'remove' } });
  assert.match(page, /<code/);
  assert.match(page, /Show output/);
  assert.match(page, /<pre>visible-result/);
});

test('MIME priority, escaped text, math, image and interactive representations', async () => {
  const render = async (data) => toHtml(await renderOutput({ output_type: 'display_data', data }));
  assert.match(await render({ 'text/html': '<b>rich</b>', 'text/plain': 'fallback' }), /<b>rich<\/b>/);
  assert.doesNotMatch(await render({ 'text/html': '<b>rich</b>', 'text/plain': 'fallback' }), /fallback/);
  assert.match(await render({ 'text/plain': '<script>alert(1)</script>' }), /&#x3C;script>/);
  assert.match(await render({ 'text/latex': '$$x^2$$' }), /class="katex"/);
  assert.match(await render({ 'text/markdown': '**bold** and $x$' }), /<strong>bold<\/strong>/);
  assert.match(await render({ 'image/png': 'AAAA' }), /src="data:image\/png;base64,AAAA"/);
  assert.match(await render({ 'image/svg+xml': '<svg viewBox="0 0 1 1"></svg>' }), /<svg/);
  assert.match(await render({ 'application/vnd.plotly.v1+json': { data: [] }, 'text/plain': 'fallback' }), /data-plotly=/);
  await assert.rejects(render({ 'application/x-unknown': {} }), /Unsupported Jupyter MIME/);
});

test('MyST parses directives, tags, math, links, and rejects unknown syntax', async () => {
  const source = [
    '```python\nraise RuntimeError("ordinary fence must not execute")\n```',
    '```{code-cell} ipython3\n:tags: [remove-cell]\n\nx = 40\n```',
    '```{code-cell} ipython3\nx + 2\n```',
    ':::{admonition} A collapsible explanation\n:class: dropdown tip\n\nThe answer is $x^2$.\n:::',
    '\\begin{equation}\nx = 2\n\\end{equation}',
  ].join('\n\n');
  const result = await render(source);
  assert.match(result, /<pre>42<\/pre>/);
  assert.match(result, /data-source="x = 40"[^>]* hidden/);
  assert.match(result, /<details[^>]*><summary[^>]*><span[^>]*>A collapsible explanation/);
  assert.match(result, /class="katex-display"/);
  assert.doesNotMatch(result, /katex-error|unhandled|\{code-cell\}/);
  await assert.rejects(render(':::{not-a-real-directive}\nbody\n:::'), /unknown directive|Unsupported resolved MyST node: mystDirective/i);
  await assert.rejects(render('{not-a-real-role}`value`'), /unknown role|Unsupported resolved MyST node: mystRole/i);
});
