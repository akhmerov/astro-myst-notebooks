import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareApi } from '../dist/engine/api.mjs';
import { createAutodoc } from '../dist/engine/autodoc/index.mjs';
import { mystParse } from 'myst-parser';
import { VFile } from 'vfile';

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'astro-api-tree-'));
  try {
    await mkdir(join(root, 'sample_api'));
    await writeFile(join(root, 'sample_api/__init__.py'), `from ._impl import PublicClass, calculate\nfrom ._impl import PublicClass as Alias\nconstant: int = 7\n`);
    await writeFile(join(root, 'sample_api/_impl.py'), `class Base:
    def __init__(self, value: int = 1):
        """Initialize a stored value."""
        self.value = value
    def inherited(self):
        """An inherited method."""
        return self.value
class PublicClass(Base):
    """A public class."""
def calculate(value: int) -> int:
    """Calculate a value."""
    return value
raise RuntimeError("API extraction must not execute the module")
`);
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('API preparation generates stable public routes, module trees and aliases from static extraction', () => fixture(async root => {
  const options = { root, cache: join(root, '.astro/engine'), api: { modules: ['sample_api'], searchPaths: ['.'] } };
  const result = await prepareApi(options);
  assert.ok(result.pages.some(page => page.slug === 'api/sample_api'));
  assert.ok(result.pages.some(page => page.slug === 'api/sample_api/calculate'));
  assert.ok(result.pages.some(page => page.slug === 'api/sample_api/constant' && page.kind === 'data'));
  const classes = result.pages.filter(page => page.kind === 'class');
  assert.equal(classes.length, 1, 'public aliases share one class page');
  assert.equal(classes[0].slug, 'api/sample_api/PublicClass');
  const content = await readFile(classes[0].file, 'utf8');
  assert.match(content, /:members: \*/);
  assert.doesNotMatch(content, /^slug:/m, 'routeByFile owns generated routes without unsupported MyST frontmatter');
  assert.equal(result.routeByFile.get(classes[0].file), classes[0].slug);
  assert.equal(result.toc[0].file, result.pages.find(page => page.object === 'sample_api').file);
  assert.equal(result.toc[0].children.length, 3);
  assert.ok(result.dependencies.some(path => path.endsWith('sample_api/_impl.py')));
  assert.ok(result.pluginOptions.searchPaths.every(path => path.startsWith(root)));
  const again = await prepareApi(options);
  assert.deepEqual(again.pages, result.pages);
  const selected = await prepareApi({ ...options, python: '/missing-execution-python', api: { ...options.api, python: 'python' } });
  assert.equal(selected.pluginOptions.python, 'python', 'an explicit existing static-extraction interpreter is independent of notebook execution');
}));

test('named and wildcard module members suppress their generated pages and ignore fenced examples', () => fixture(async root => {
  const options = { root, cache: join(root, '.astro/engine'), api: { modules: ['sample_api'], searchPaths: ['.'] } };
  const source = join(root, 'guide.md');
  await writeFile(source, '````markdown\n:::{autodoc} sample_api.calculate\n:::\n````\n\n::::{code-block} markdown\n:::{autodoc} sample_api.PublicClass\n:::\n::::\n');
  let result = await prepareApi({ ...options, sources: [source] });
  assert.ok(result.pages.some(page => page.object === 'sample_api.calculate'));
  assert.ok(result.pages.some(page => page.object === 'sample_api.PublicClass'));
  await writeFile(source, '::::{admonition} Public API\n:::{autodoc} sample_api\n:members: calculate, PublicClass\n:::\n::::\n');
  result = await prepareApi({ ...options, sources: [source] });
  assert.deepEqual(result.pages.map(page => page.object), ['sample_api.constant']);
  await writeFile(source, '```{autodoc} sample_api\n:members: *\n```\n');
  result = await prepareApi({ ...options, sources: [source] });
  assert.deepEqual(result.pages, []);
}));

test('notebook authored placements ignore code cells and the plugin reuses this build model without Python', () => fixture(async root => {
  const source = join(root, 'guide.ipynb');
  await writeFile(source, JSON.stringify({ cells: [
    { cell_type: 'markdown', source: ':::{autodoc} sample_api.calculate\n:::', metadata: {} },
    { cell_type: 'code', source: '""":::{autodoc} sample_api.constant\n:::"""', metadata: {} },
  ], metadata: {} }));
  const result = await prepareApi({ root, cache: join(root, '.astro/engine'), api: { modules: ['sample_api'], searchPaths: ['.'] }, sources: [source] });
  assert.ok(!result.pages.some(page => page.object === 'sample_api.calculate'));
  assert.ok(result.pages.some(page => page.object === 'sample_api.constant'));
  assert.equal(JSON.parse(await readFile(result.pluginOptions.modelFile, 'utf8')).version, 1);
  const plugin = createAutodoc({ ...result.pluginOptions, python: '/missing-python-must-not-launch' });
  const nodes = plugin.directives[0].run({ arg: 'sample_api.calculate', options: {} }, new VFile(), { parseMyst: mystParse });
  assert.equal(nodes[0].canonical, 'sample_api._impl.calculate');
}));

test('authored autodoc placements suppress duplicate auto-pages and obsolete generated pages are removed', () => fixture(async root => {
  const options = { root, cache: join(root, '.astro/engine'), api: { modules: ['sample_api'], searchPaths: ['.'] } };
  const before = await prepareApi(options);
  const generated = before.pages.find(page => page.object === 'sample_api.calculate');
  const source = join(root, 'guide.md');
  await writeFile(source, '# Manual API page\n\n:::{autodoc} sample_api.calculate\n:::\n');
  const after = await prepareApi({ ...options, sources: [source] });
  assert.ok(!after.pages.some(page => page.object === 'sample_api.calculate'));
  await assert.rejects(readFile(generated.file), { code: 'ENOENT' });
  await assert.rejects(prepareApi({ ...options, api: { packages: [{ name: 'sample_api' }] } }), /api.modules/);
}));
