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
