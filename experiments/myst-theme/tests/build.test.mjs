import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { renderPage } from '../theme/content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = new URL('../project/', import.meta.url);
const read = path => readFile(new URL(path, project), 'utf8');
const prefix = (process.env.BASE_URL ?? '/').replace(/\/$/, '');

test('MyST engine output becomes Starlight HTML with executed cells and working targets', async () => {
  const html = await read('_build/html/index.html');
  assert.match(html, /<jupyter-notebook>/);
  assert.match(html, /The triangular number is 21/);
  assert.match(html, /class="expressive-code"/);
  assert.ok(html.includes(`href="${prefix}/second#triangle"`));
  assert.match(await read('_build/html/second/index.html'), /id="triangle"[\s\S]*class="katex/);
  assert.match(await read('_build/html/notebook/index.html'), /<pre>42\n<\/pre>/);
  assert.doesNotMatch(await read('_build/html/notebook/index.html'), /stale saved output/);
  const xrefs = JSON.parse(await read('_build/html/myst.xref.json'));
  assert.ok(xrefs.references.every(ref => !ref.data?.startsWith('/content/')));
  const assets = JSON.parse(await read('_build/site/public.json'));
  for (const path of assets) await read(`_build/html${path}`);
});

test('published exact selections and code lines match original files and digests', async () => {
  const html = fromHtml(await read('_build/html/index.html'));
  const origins = [];
  visit(html, 'element', node => {
    if (node.properties.dataSourceLocation) origins.push({ origin: JSON.parse(node.properties.dataSourceLocation),
      value: node.children.map(child => child.value ?? '').join('') });
    if (node.properties.dataOrigin) {
      const origin = JSON.parse(node.properties.dataOrigin);
      origins.push({ origin, value: node.properties.dataSource });
      assert.equal(origin.lines.length, 2);
      assert.equal(origin.lines[0].kind, 'exact');
    }
  });
  assert.ok(origins.some(({ origin }) => origin.file === '_included.md'));
  assert.ok(origins.length > 5);
  for (const { origin, value } of origins) {
    const source = await read(origin.file);
    assert.equal(origin.digest, createHash('sha256').update(source).digest('hex'));
    if (origin.kind === 'exact') assert.equal(source.slice(origin.start, origin.end), value);
  }
});

test('renderer rejects unsupported nodes instead of silently dropping content', async () => {
  const page = { location: '/index.md', frontmatter: {}, mdast: { type: 'root', children: [{ type: 'widget' }] } };
  await assert.rejects(renderPage(page, { root }), /does not render MyST node: widget/);
});

test('real MyST builds reject missing targets, API directives, inline eval, conflicting tags, and filtered includes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-myst-theme-'));
  // Resolve the repository CLI independently of the temporary project.
  const launcher = fileURLToPath(new URL('../build.mjs', import.meta.url));
  try {
    await writeFile(join(directory, 'myst.yml'), `version: 1\nproject:\n  plugins: [${JSON.stringify(join(root, 'provenance.mjs'))}]\n  toc:\n    - file: index.md\nsite:\n  template: ${JSON.stringify(join(root, 'theme'))}\n`);
    for (const [source, error] of [
      ['# Invalid\n\nSee [](#missing-equation).', /missing-equation/],
      ['# Invalid\n\n```{autodoc} example.calculate\n```', /autodoc/],
      ['# Invalid\n\n{eval}`1 + 1`', /does not yet support inline eval/],
      ['# Invalid\n\n```{code-cell} python\n:tags: [hide-input, remove-input]\n\nprint(1)\n```', /Conflicting presentation tags/],
      ['# Invalid\n\n```{include} included.md\n:start-line: 1\n```', /does not support filtered includes/],
    ]) {
      await writeFile(join(directory, 'index.md'), source);
      await writeFile(join(directory, 'included.md'), 'First.\nSecond.\n');
      const result = spawnSync(process.execPath, [launcher, directory], { encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0, source);
      assert.match(result.stdout + result.stderr, error);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
