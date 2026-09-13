import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Inventory } from 'intersphinx';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { remarkMyst, mystRehype } from '../dist/myst.mjs';
import { remarkReferences, loadInventory } from '../dist/references.mjs';

async function render(source, options) {
  const processor = unified().use(remarkMyst).use(remarkReferences, options).use(remarkRehype, mystRehype);
  const file = { value: source };
  return toHtml(await processor.run(processor.parse(source), file));
}

test('real inventory parsing, non-guessed URLs, labels, local precedence and strict resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notebook-references-'));
  const file = join(directory, 'remote.inv');
  const localFile = join(directory, 'local.inv');
  const remote = new Inventory({ project: 'Example' });
  remote.setEntry({ name: 'demo.CamelCase', type: 'py:class', location: 'odd/location.html#$', display: 'The class' });
  remote.setEntry({ name: 'a-label', type: 'std:label', location: 'guide.html#section', display: 'Read the guide' });
  remote.write(file);
  const local = new Inventory();
  local.setEntry({ name: 'demo.CamelCase.method', type: 'py:method', location: '/preview/api/demo/#demo.CamelCase.method' });
  local.setEntry({ name: 'demo.CamelCase', type: 'py:class', location: '/preview/api/demo/#demo.CamelCase' });
  local.write(localFile);
  const options = {
    cacheDir: pathToFileURL(directory + '/'), localInventory: pathToFileURL(localFile),
    references: { example: { file: pathToFileURL(file), base: 'https://example.org/docs/' } },
  };
  try {
    const result = await render([
      '{autolink}`~demo.CamelCase.method`',
      '{autolink}`My class <demo.CamelCase>`',
      '[](xref:example#demo.CamelCase)',
      '[](xref:example#a-label)',
      '[Custom label](xref:example#a-label)',
    ].join('\n\n'), options);
    assert.match(result, /href="\/preview\/api\/demo\/#demo.CamelCase.method"><code><span[^>]*>method<\/span><\/code>/);
    assert.match(result, /href="\/preview\/api\/demo\/#demo.CamelCase"><span[^>]*>My class/);
    assert.match(result, /https:\/\/example.org\/docs\/odd\/location.html#demo.CamelCase"><span[^>]*>The class/);
    assert.match(result, /guide.html#section"><span[^>]*>Read the guide/);
    assert.match(result, /guide.html#section"><span[^>]*>Custom label/);
    await assert.rejects(render('{autolink}`demo.DoesNotExist`', options), /Unknown API reference/);
    await assert.rejects(render('[](xref:absent#demo.CamelCase)', options), /Unknown reference inventory/);
    await assert.rejects(render('[](xref:example#absent)', options), /Unresolved reference/);
    await assert.rejects(render('{autolink}`demo.CamelCase`', {
      ...options, localInventory: undefined,
      references: { ...options.references, other: options.references.example },
    }), /Ambiguous API reference/);
  } finally { await rm(directory, { recursive: true }); }
});

test('inventory download is validated, cached for offline use, and explicitly refreshable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-cache-'));
  const file = join(directory, 'source.inv');
  const inventory = new Inventory();
  inventory.setEntry({ name: 'Object', type: 'py:class', location: 'objects.html#$' });
  inventory.write(file);
  const payload = await readFile(file);
  let requests = 0;
  let broken = false;
  const server = createServer((_request, response) => {
    requests++;
    response.end(broken ? 'invalid inventory' : payload);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/objects.inv`;
  const cache = pathToFileURL(directory + '/cache/');
  try {
    const first = await loadInventory('test', { url }, cache);
    assert.equal(first.getEntry({ name: 'Object' }).location, url.replace('objects.inv', 'objects.html#Object'));
    await loadInventory('test', { url }, cache);
    assert.equal(requests, 1);
    broken = true;
    await assert.rejects(loadInventory('test', { url, refresh: true }, cache));
    assert.equal(requests, 2);
    await new Promise(resolve => server.close(resolve));
    const offline = await loadInventory('test', { url }, cache);
    assert.equal(offline.numEntries, 1, 'failed refresh must not replace the valid cache');
  } finally {
    server.close();
    await rm(directory, { recursive: true });
  }
});
