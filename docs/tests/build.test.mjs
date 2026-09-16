import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';

const output = new URL('../dist/', import.meta.url);
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');
const names = ['', 'setup', 'walkthrough', 'authoring', 'notebook', 'browser', 'reference', 'development'];
const pages = new Map(await Promise.all(names.map(async name => {
  const html = await readFile(new URL(`${name ? name + '/' : ''}index.html`, output), 'utf8');
  return [name, fromHtml(html)];
})));
const elements = tree => {
  const found = [];
  visit(tree, 'element', node => { found.push(node); });
  return found;
};
const text = tree => {
  const found = [];
  visit(tree, 'text', node => { found.push(node.value); });
  return found.join('');
};

test('the documentation renders real Jupyter results and includes hidden setup', () => {
  const tree = pages.get('walkthrough');
  const nodes = elements(tree);
  const cells = nodes.filter(node => node.properties.className?.includes('jupyter-cell'));
  assert.equal(cells.length, 5);
  assert.ok(cells.some(node => node.properties.hidden && node.properties.dataSource.includes('IPython.display')));
  const outputs = nodes.filter(node => node.properties.className?.includes('jupyter-output'));
  assert.ok(outputs.some(node => text(node).includes('Sum: 36')));
  assert.ok(outputs.some(node => node.properties.dataMime === 'text/html' && text(node).includes('Computed total: 36')));
  const inline = nodes.filter(node => node.properties.className?.includes('jupyter-inline'));
  assert.deepEqual(inline.map(text), ['8', '36']);
  assert.ok(inline.every(node => node.tagName === 'span' && node.properties.dataSourceGenerated === 'true'));
  const plot = nodes.find(node => node.properties.dataPlotly);
  assert.deepEqual(JSON.parse(plot.properties.dataPlotly).data[0].y, [1, 3, 6, 10, 15, 21, 28, 36]);
  assert.ok(nodes.some(node => node.tagName === 'jupyter-notebook'));
  assert.ok(nodes.some(node => node.properties.className?.includes('katex')));
  assert.ok(nodes.some(node => node.properties.id === 'triangular-sum'));
});

test('layout constructs render on the authoring page', () => {
  const nodes = elements(pages.get('authoring'));
  const diagram = nodes.find(node => node.tagName === 'pre' && node.properties.className?.includes('mermaid'));
  assert.match(text(diagram), /flowchart LR/);
  const cards = nodes.filter(node => node.tagName === 'a' && node.properties.className?.includes('card'));
  assert.deepEqual(cards.map(node => node.properties.href), [`${base}/walkthrough/`, `${base}/browser/`]);
  assert.ok(cards[0].children.some(node => node.properties?.className?.includes('card-footer')));
  const figure = nodes.find(node => node.tagName === 'figure' && node.properties.id === 'included-figure');
  const image = elements(figure).find(node => node.tagName === 'img');
  assert.match(image.properties.src, new RegExp(`^${base}/_astro/diagram\\.[\\w-]+\\.svg$`));
  assert.equal(image.properties.alt, 'A source box with an arrow to a page box');
  const equations = nodes.filter(node => node.properties.className?.includes('katex-display'));
  assert.ok(equations.some(node => text(node).includes('S_n = ')));
  assert.equal(nodes.filter(node => node.properties.id === 'triangular-sum').length, 0);
  const tabs = nodes.filter(node => node.properties.role === 'tab');
  assert.deepEqual(tabs.map(text), ['Pixi', 'npm']);
  assert.deepEqual(tabs.map(node => node.properties.ariaSelected), ['true', 'false']);
  assert.ok(nodes.some(node => node.tagName === 'dt' && node.properties.id === 'term-kernel'));
  assert.ok(nodes.some(node => node.tagName === 'a' && node.properties.href === '#term-kernel'));
});

test('a Jupyter notebook renders and executes like a MyST page', async () => {
  const nodes = elements(pages.get('notebook'));
  assert.ok(nodes.some(node => node.tagName === 'h1' && text(node) === 'Notebook source'));
  const cells = nodes.filter(node => node.properties.className?.includes('jupyter-cell'));
  assert.equal(cells.length, 2);
  assert.equal(cells[0].properties.dataTags, 'hide-output');
  const outputs = nodes.filter(node => node.properties.className?.includes('jupyter-output'));
  assert.deepEqual(outputs.map(text), ['5', '55']);
  assert.doesNotMatch(text(pages.get('notebook')), /Raw cells are not published/);
  assert.ok(nodes.some(node => node.tagName === 'a' && node.properties.href === `${base}/walkthrough/#triangular-sum`));
  const span = nodes.find(node => node.properties.dataSourceLocation && text(node) === 'notebook.ipynb');
  const origin = JSON.parse(span.properties.dataSourceLocation);
  assert.equal(origin.file, 'docs/src/content/docs/notebook.ipynb');
  assert.equal(origin.representation, 'myst');
  const { notebookToMyst } = await import('../../dist/source-loader.js');
  const source = notebookToMyst(JSON.parse(await readFile(new URL(`../../${origin.file}`, import.meta.url), 'utf8')));
  assert.equal(source.slice(origin.start, origin.end), 'notebook.ipynb');
  const routes = JSON.parse(await readFile(new URL('../node_modules/.astro/notebooks/documents.json', import.meta.url), 'utf8'));
  assert.ok(routes.some(route => route.path.endsWith('notebook.ipynb') && route.url === `${base}/notebook/`));
});

test('includes retain their file identity and are excluded from the page collection', async () => {
  const routes = JSON.parse(await readFile(new URL('../node_modules/.astro/notebooks/documents.json', import.meta.url), 'utf8'));
  assert.equal(routes.length, names.length);
  const span = elements(pages.get('walkthrough')).find(node =>
    node.properties.dataSourceLocation && text(node) === 'included file');
  assert.ok(span);
  const origin = JSON.parse(span.properties.dataSourceLocation);
  assert.equal(origin.file, 'docs/src/content/docs/_partials/_provenance.md');
  assert.equal(origin.kind, 'exact');
  const source = await readFile(new URL(`../../${origin.file}`, import.meta.url), 'utf8');
  assert.equal(source.slice(origin.start, origin.end), 'included file');
});

test('all local page links and fragment targets exist under the deployment base', () => {
  const byPath = new Map([...pages].map(([name, tree]) => [
    `${base}/${name ? name + '/' : ''}`, tree,
  ]));
  for (const [name, tree] of pages) {
    const url = new URL(`${base}/${name ? name + '/' : ''}`, 'https://docs.example');
    for (const node of elements(tree)) {
      if (node.tagName !== 'a' || !node.properties.href) continue;
      const destination = new URL(node.properties.href, url);
      if (destination.origin !== url.origin || destination.protocol !== 'https:') continue;
      const target = byPath.get(destination.pathname);
      assert.ok(target, `${name}: unknown local page ${destination.pathname}`);
      if (destination.hash) {
        const id = decodeURIComponent(destination.hash.slice(1));
        assert.ok(elements(target).some(element => element.properties.id === id),
          `${name}: missing fragment ${destination.pathname}#${id}`);
      }
    }
  }
});

test('the published site includes the browser runtime and source-selection code', async () => {
  for (const asset of ['thebe/index.js', 'thebe/thebe.css', 'thebe/comlink.worker.js', 'thebe/coincident.worker.js', 'thebe/xeus' ]) {
    await access(new URL(asset, output));
  }
  const tree = pages.get('walkthrough');
  const scripts = elements(tree).filter(node => node.tagName === 'script' && node.properties.src);
  assert.ok(scripts.length);
  for (const script of scripts) {
    const path = script.properties.src;
    assert.ok(path.startsWith(`${base}/`));
    await access(new URL(path.slice(base.length + 1), output));
  }
});
