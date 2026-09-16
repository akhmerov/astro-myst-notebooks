import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { remarkMyst, mystRehype } from '../dist/myst.mjs';

/** Render MyST to HTML without execution; layout constructs never need a kernel. */
async function render(source) {
  const processor = unified().use(remarkMyst).use(remarkRehype, mystRehype);
  return toHtml(await processor.run(processor.parse(source), { value: source, data: { astro: { frontmatter: {} } } }));
}

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
