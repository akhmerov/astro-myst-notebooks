import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareApi } from '../dist/engine/api.mjs';

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
