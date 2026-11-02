import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { remarkMyst, mystRehype } from '../dist/myst.mjs';

/** Render MyST to HTML without execution; layout constructs never need a kernel. */
async function render(source) {
  const processor = unified().use(remarkMyst).use(remarkRehype, mystRehype);
  return toHtml(await processor.run(processor.parse(source), { value: source, data: { astro: { frontmatter: {} } } }));
}

test('tight, loose, nested, and task lists retain authored paragraph spacing', async () => {
  for (const marker of ['-', '1.']) {
    for (const [separator, paragraphs] of [['\n', 0], ['\n\n', 2]]) {
      const html = await render(`${marker} One${separator}${marker} Two`);
      assert.equal((html.match(/<p>/g) ?? []).length, paragraphs);
      assert.match(html, /data-source-generated/);
    }
  }
  const nested = await render('- Parent\n  - Child\n  - Another\n- Sibling');
  assert.doesNotMatch(nested, /<p>/);
  const tasks = await render('- [x] Done\n- [ ] Todo');
  assert.doesNotMatch(tasks, /<p>/);
  assert.equal((tasks.match(/type="checkbox"/g) ?? []).length, 2);
  const mixed = await render('- First\n\n- Second\n\n  Another paragraph.\n\n  - Nested\n  - Tight');
  const items = [];
  visit(fromHtml(mixed, { fragment: true }), 'element', node => { if (node.tagName === 'li') items.push(node); });
  assert.deepEqual(items.map(item => item.children.filter(child => child.tagName === 'p').length), [1, 2, 0, 0]);
  assert.doesNotMatch(await render(':::{note}\n- One\n- Two\n:::'), /<li>\s*<p>/);
  assert.match(await render('- ```text\n  code\n  ```\n\n  Paragraph.'), /<p>/);
});

test('admonition kinds use the matching Starlight palette and preserve custom classes', async () => {
  for (const [style, kinds] of Object.entries({ note: ['note'], tip: ['tip', 'hint', 'important'],
    caution: ['warning', 'caution', 'attention'], danger: ['danger', 'error'] })) {
    for (const kind of kinds) assert.match(await render(`:::{${kind}}\nBody.\n:::`), new RegExp(`starlight-aside--${style}`));
  }
  const dropdown = await render(':::{admonition} Details\n:class: dropdown tip project-note\n\nBody.\n:::');
  assert.match(dropdown, /<details class="dropdown tip project-note admonition starlight-aside starlight-aside--tip">/);
  assert.match(dropdown, /<summary class="admonition-title starlight-aside__title">/);
  assert.match(await render(':::{note}\n:class: danger\n\nBody.\n:::'), /starlight-aside--danger/);
});

test('iframes render with their attributes and captions become figures', async () => {
  const plain = await render('```{iframe} https://example.org/embed\n:width: 50%\n:align: center\n:title: Example\n```');
  assert.match(plain, /<iframe src="https:\/\/example.org\/embed" title="Example" width="50%" loading="lazy" allowfullscreen class="align-center"><\/iframe>/);
  const captioned = await render('```{iframe} https://example.org/embed\n:name: frame\n\nA caption.\n```\n\nSee {numref}`frame`.');
  assert.match(captioned, /<figure id="frame"[^>]*><iframe[^>]*><\/iframe><figcaption>/);
  assert.match(captioned, /A caption\./);
  assert.match(captioned, /href="#frame"/);
});

test('mermaid directives and fences publish their source for browser rendering', async () => {
  for (const source of ['```{mermaid}\ngraph LR; A-->B;\n```', '```mermaid\ngraph LR; A-->B;\n```']) {
    assert.match(await render(source), /<pre class="mermaid">graph LR; A-->B;<\/pre>/);
  }
});

test('tab sets render accessible tabs with sync keys and a selected item', async () => {
  const source = ['::::{tab-set}', ':::{tab-item} One', ':sync: a', 'First.', ':::', ':::{tab-item} Two', ':sync: b', ':selected:', 'Second.', ':::', '::::'].join('\n');
  const html = await render(source + '\n\n' + source);
  assert.match(html, /<div class="tab-set" data-tab-set=""><div class="tab-list" role="tablist"><button type="button" role="tab" id="tabs-1-tab-1" aria-controls="tabs-1-panel-1" aria-selected="false" tabindex="-1" data-sync="a">One<\/button><button [^>]*id="tabs-1-tab-2"[^>]*aria-selected="true" tabindex="0" data-sync="b">Two<\/button><\/div>/);
  assert.match(html, /<div class="tab-panel" role="tabpanel" id="tabs-1-panel-1" aria-labelledby="tabs-1-tab-1" hidden>/);
  assert.match(html, /<div class="tab-panel" role="tabpanel" id="tabs-1-panel-2" aria-labelledby="tabs-1-tab-2"><p>/);
  assert.match(html, /id="tabs-2-tab-1"/);
});

test('grids and cards render responsive columns, card parts, and links', async () => {
  const html = await render(['::::{grid} 1 2 3', ':::{card} Title', ':link: https://example.org/', 'Header', '^^^', 'Body text.', '+++', 'Footer', ':::', ':::{grid-item}', ':columns: 2', 'Plain item.', ':::', '::::'].join('\n'));
  assert.match(html, /<div class="grid" style="--grid-xs:1;--grid-sm:2;--grid-md:3;--grid-lg:3">/);
  assert.match(html, /<a class="card" href="https:\/\/example.org\/"><div class="card-header"><p>[^]*?Header[^]*?<\/div><div class="card-title">[^]*?Title[^]*?<\/div><div class="card-body"><p>[^]*?Body text\.[^]*?<\/div><div class="card-footer"><p>[^]*?Footer[^]*?<\/div><\/a>/);
  assert.match(html, /<div class="grid-item" style="grid-column: span 2"><p>/);
  assert.match(await render(':::{card}\nJust a body.\n:::'), /<div class="card"><div class="card-body"><p>/);
});
