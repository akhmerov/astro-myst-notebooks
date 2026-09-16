import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import { remarkMyst, mystRehype } from '../dist/myst.mjs';
import rehypeKatex from 'rehype-katex';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { executePage, remarkJupyter } from '../dist/jupyter.mjs';
import { renderOutput, rehypeJupyter } from '../dist/mime.mjs';
import { ansiToHast } from '../dist/ansi.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));

async function render(source, frontmatter = {}) {
  const processor = unified().use(remarkMyst).use(remarkJupyter, { cwd }).use(remarkRehype, mystRehype).use(rehypeKatex).use(rehypeJupyter);
  const file = { value: source, data: { astro: { frontmatter } } };
  return toHtml(await processor.run(processor.parse(source), file));
}

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
  assert.match(skipped, /data-tags="skip-execution"[^>]*><div class="jupyter-static-input">[\s\S]*?skipped-cell-must-not-run[\s\S]*?<div class="jupyter-outputs"><\/div>/);
  assert.match(skipped, /<pre>ran-anyway/);
  for (const frontmatter of [{ execute: { skip: true } }, { skip_execution: true }]) {
    const page = await render('```{code-cell} python\nraise RuntimeError("page-must-not-run")\n```', frontmatter);
    assert.match(page, /page-must-not-run/);
    assert.match(page, /<div class="jupyter-outputs"><\/div>/);
  }
});

test('ANSI colours, bold, resets, 256-colour and truecolour codes become spans', () => {
  const html = toHtml({ type: 'root', children: ansiToHast('\x1b[1;31mbold red\x1b[0m plain \x1b[38;5;208morange\x1b[39m \x1b[48;2;1;2;3mbg\x1b[0m \x1b[2Kcleared') });
  assert.equal(html, '<span class="ansi-bold ansi-red-fg">bold red</span> plain <span style="color:rgb(255,135,0)">orange</span> <span style="background-color:rgb(1,2,3)">bg</span> cleared');
});

test('plain pages do not execute; hidden cells still share state', async () => {
  assert.match(await render('```python\nraise RuntimeError("must not execute")\n```'), /must not execute/);
  const result = await render([
    '```{code-cell} ipython3\n:tags: [hide-cell]\n\nx = 40\n```',
    '```{code-cell} ipython3\n:tags: [hide-input]\n\nx + 2\n```',
    '```{code-cell} ipython3\n:tags: [hide-output]\n\nprint("suppressed-output")\n```',
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
    '{autolink}`~pymablock.series.BlockSeries`',
  ].join('\n\n');
  const result = await render(source);
  assert.match(result, /<pre>42<\/pre>/);
  assert.match(result, /data-source="x = 40"[^>]* hidden/);
  assert.match(result, /<details[^>]*><summary[^>]*><span[^>]*>A collapsible explanation/);
  assert.match(result, /class="katex-display"/);
  assert.doesNotMatch(result, /katex-error|unhandled|\{code-cell\}/);
  assert.match(result, /href="xref:auto#pymablock.series.BlockSeries"/);
  await assert.rejects(render(':::{not-a-real-directive}\nbody\n:::'), /unknown directive/);
  await assert.rejects(render('{not-a-real-role}`value`'), /unknown role/);
});
