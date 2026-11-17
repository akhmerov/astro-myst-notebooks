import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { Inventory } from 'intersphinx';
import { augmentInventory } from '../inventory.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const sphinx = join(root, '.pixi/envs/interop/bin/python');

function run(command, args, cwd, { fails = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', status => {
      if (fails ? status === 0 : status !== 0) reject(new Error(`${command} exited ${status}\n${output}`));
      else resolve(output);
    });
  });
}

function nodes(tree) {
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

test('packed plugin interoperates with isolated Sphinx and MyST consumers', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(root, '.autodoc-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = join(directory, 'package');
  const project = join(directory, 'project');
  const site = join(project, '_build/site');
  await cp(join(fixtures, 'project'), project, { recursive: true });
  await cp(join(fixtures, 'python'), join(directory, 'python'), { recursive: true });
  const pack = JSON.parse(await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], dirname(new URL('../package.json', import.meta.url).pathname)))[0];
  await run('tar', ['xf', join(directory, pack.filename), '-C', directory], root);
  assert.ok(pack.files.some(file => file.path === 'extract.py'));
  assert.ok(!pack.files.some(file => file.path.startsWith('tests/')));
  await writeFile(join(project, 'autodoc.mjs'), `import {createAutodoc} from '../package/index.mjs';
export default createAutodoc({modules: ['sample_api'], searchPaths: ['../python']});\n`);
  await writeFile(join(project, 'myst.yml'), `version: 1
project:
  title: API fixture
  plugins: [autodoc.mjs]
  toc:
    - file: index.md
    - file: api.md
    - file: classes.md
site:
  template: book-theme
`);
  const cli = join(packed, 'cli.mjs');
  const build = () => run(process.execPath, [cli, 'build'], project);
  await t.test('standard AST, real signatures, references, and aliases', async () => {
    const output = await build();
    assert.doesNotMatch(output, /⚠️/);
    const page = JSON.parse(await readFile(join(site, 'content/api.json'), 'utf8'));
    const all = nodes(page.mdast);
    assert.ok(all.some(node => node.type === 'code' && node.value === 'sample_api.solve(value: int, /, *, offset: int = 1) -> Result'));
    assert.ok(all.some(node => node.type === 'strong' && node.children[0].value === 'an offset'));
    assert.ok(all.some(node => node.type === 'code' && node.value.includes('>>> solve(2).value')));
    assert.ok(all.some(node => node.type === 'crossReference' && node.resolved && node.url === '/classes'));
    assert.ok(!all.some(node => ['pythonObject', 'pythonReference'].includes(node.type)));
    assert.ok(all.filter(node => node.data?.pythonObject).every(node => !node.position));
    const inv = new Inventory({ path: join(site, 'objects.inv') });
    await inv.load();
    assert.match(inv.data['py:function']['sample_api.solve'].location, /^api#py-/);
    assert.equal(inv.data['py:function']['sample_api.solve'].location, inv.data['py:function']['sample_api._impl.solve'].location);
    assert.ok(inv.data['py:class']['sample_api.Result']);
    assert.ok(inv.data['py:method']['sample_api.Result.scale']);
    assert.ok(inv.data['py:property']['sample_api.Result.doubled']);
    assert.ok(inv.data['py:attribute']['sample_api.Result.value']);
    assert.ok(inv.data['py:module']['sample_api']);
    assert.ok(inv.data['std:label']['overview-details']);
    // Every published Python destination has a real target in resolved content.
    for (const [kind, entries] of Object.entries(inv.data).filter(([kind]) => kind.startsWith('py:'))) {
      for (const entry of Object.values(entries)) {
        const [slug, id] = entry.location.split('#');
        const target = JSON.parse(await readFile(join(site, `content/${slug || 'index'}.json`), 'utf8'));
        assert.ok(nodes(target.mdast).some(node => node.html_id === id), `${kind}: ${entry.location}`);
      }
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      const base = path.startsWith('/preview/') ? site : path.startsWith('/foreign/') ? join(directory, 'sphinx-consumer/_build') : null;
      if (!base) { res.writeHead(404).end(); return; }
      const file = resolve(base, path.replace(/^\/(preview|foreign)\//, ''));
      if (!file.startsWith(base + '/')) { res.writeHead(404).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': extname(file) === '.json' ? 'application/json' : 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/preview/`;

  await t.test('Sphinx 9 resolves typed Python names and aliases under a URL prefix', async () => {
    const consumer = join(directory, 'sphinx-consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'conf.py'), `extensions = ['sphinx.ext.intersphinx']
project = 'Independent Sphinx consumer'
nitpicky = True
intersphinx_mapping = {'api': (${JSON.stringify(url)}, None)}
`);
    await writeFile(join(consumer, 'index.rst'), `Consumer
========

:py:func:\`sample_api.solve\`
:py:func:\`sample_api._impl.solve\`
:py:class:\`sample_api.Result\`
:py:meth:\`sample_api.Result.scale\`
:py:attr:\`sample_api.Result.doubled\`
:py:attr:\`sample_api.Result.value\`
:py:mod:\`sample_api\`

.. py:class:: foreign.Widget

   An independently documented class.
`);
    await run(sphinx, ['-m', 'sphinx', '-b', 'html', '-W', '--keep-going', consumer, join(consumer, '_build')], consumer);
    const html = await readFile(join(consumer, '_build/index.html'), 'utf8');
    assert.match(html, /href="http:\/\/127\.0\.0\.1:\d+\/preview\/api#py-/);
    assert.match(html, /href="http:\/\/127\.0\.0\.1:\d+\/preview\/classes#py-/);
  });

  await t.test('a plain MyST consumer resolves public and canonical API references', async () => {
    const consumer = join(directory, 'myst-consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'myst.yml'), `version: 1
project:
  references:
    api: ${url}
  toc:
    - file: index.md
site:
  template: book-theme
`);
    await writeFile(join(consumer, 'index.md'), `# Consumer

[Solve](xref:api#sample_api.solve), [Result](xref:api#sample_api.Result),
[Canonical](xref:api#sample_api._impl.solve).
`);
    await run(process.execPath, [join(root, 'node_modules/mystmd/dist/myst.cjs'), 'build', '--site', '--strict'], consumer);
    const page = JSON.parse(await readFile(join(consumer, '_build/site/content/index.json'), 'utf8'));
    const links = nodes(page.mdast).filter(node => node.type === 'crossReference' || node.type === 'link');
    assert.equal(links.length, 3);
    assert.ok(links.every(node => node.resolved && node.remoteBaseUrl === url.slice(0, -1)), JSON.stringify(links));
    assert.deepEqual(links.map(node => node.url), ['/api', '/classes', '/api']);
  });

  await t.test('Python edits refresh the build; inventory merge is repeatable', async () => {
    const source = join(directory, 'python/sample_api/_impl.py');
    await writeFile(source, (await readFile(source, 'utf8')).replace('offset: int = 1', 'offset: int = 7'));
    await build();
    const page = JSON.parse(await readFile(join(site, 'content/api.json'), 'utf8'));
    assert.ok(nodes(page.mdast).some(node => node.value?.includes('offset: int = 7')));
    const before = await readFile(join(site, 'objects.inv'));
    await augmentInventory({ site, base: '/preview/' });
    assert.deepEqual(await readFile(join(site, 'objects.inv')), before);
  });

  await t.test('autolink resolves qualified and unambiguous public Python names', async () => {
    const index = join(project, 'index.md');
    const previous = await readFile(index, 'utf8');
    await writeFile(index, previous + '\n\n{autolink}`~sample_api.solve` and {autolink}`solve`.\n');
    await build();
    const page = JSON.parse(await readFile(join(site, 'content/index.json'), 'utf8'));
    const matches = nodes(page.mdast).filter(node => node.type === 'crossReference' && node.label === 'sample_api._impl.solve'
      && node.children?.some(child => child.type === 'inlineCode' && child.value === 'solve'));
    assert.equal(matches.length, 2);
    assert.ok(matches.every(node => node.resolved && node.url === '/api'));
    await writeFile(index, previous);
  });

  await t.test('Python targets differing only in case remain distinct', async () => {
    const consumer = join(directory, 'case-consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'cases.py'), 'def value():\n    """Lowercase function."""\n\ndef Value():\n    """Uppercase function."""\n');
    await writeFile(join(consumer, 'autodoc.mjs'), "import {createAutodoc} from '../package/index.mjs';\nexport default createAutodoc({modules:['cases'],searchPaths:['.']});\n");
    await writeFile(join(consumer, 'myst.yml'), 'version: 1\nproject:\n  plugins: [autodoc.mjs]\n  toc:\n    - file: index.md\nsite:\n  template: book-theme\n');
    await writeFile(join(consumer, 'index.md'), '# Cases\n\n:::{autodoc} cases.value\n:::\n\n:::{autodoc} cases.Value\n:::\n\n{autolink}`cases.value` and {autolink}`cases.Value`.\n');
    await run(process.execPath, [cli, 'build'], consumer);
    const page = JSON.parse(await readFile(join(consumer, '_build/site/content/index.json'), 'utf8'));
    const links = nodes(page.mdast).filter(node => node.type === 'crossReference');
    assert.equal(links.length, 2);
    assert.ok(links.every(node => node.resolved));
    assert.notEqual(links[0].html_id, links[1].html_id);
    const inventory = new Inventory({ path: join(consumer, '_build/site/objects.inv') });
    await inventory.load();
    assert.notEqual(inventory.data['py:function']['cases.value'].location, inventory.data['py:function']['cases.Value'].location);
  });

  await t.test('class bases link known local definitions and preserve unavailable external bases as code', async () => {
    const consumer = join(directory, 'inheritance-consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'inheritance.py'), 'from unavailable_library import External as ExternalBase\n\nclass Base:\n    """Local base."""\n\nclass Sub(Base, ExternalBase):\n    """Derived class."""\n');
    await writeFile(join(consumer, 'autodoc.mjs'), "import {createAutodoc} from '../package/index.mjs';\nexport default createAutodoc({modules:['inheritance'],searchPaths:['.']});\n");
    await writeFile(join(consumer, 'myst.yml'), 'version: 1\nproject:\n  plugins: [autodoc.mjs]\n  toc:\n    - file: index.md\nsite:\n  template: book-theme\n');
    await writeFile(join(consumer, 'index.md'), '# Inheritance\n\n:::{autodoc} inheritance.Base\n:::\n\n:::{autodoc} inheritance.Sub\n:::\n');
    await run(process.execPath, [cli, 'build'], consumer);
    const page = JSON.parse(await readFile(join(consumer, '_build/site/content/index.json'), 'utf8'));
    const bases = nodes(page.mdast).find(node => node.type === 'paragraph' && node.children?.[0]?.type === 'strong'
      && node.children[0].children?.[0]?.value === 'Bases:');
    assert.ok(bases, 'base classes must be displayed');
    const local = bases.children.find(node => node.type === 'crossReference');
    assert.ok(local?.resolved && local.identifier === 'inheritance.Base');
    assert.equal(local.children[0].value, 'Base');
    assert.ok(bases.children.some(node => node.type === 'inlineCode' && node.value === 'ExternalBase'));
    assert.ok(!nodes(bases).some(node => node.url?.includes('unavailable_library') || node.url?.startsWith('http')));
  });

  await t.test('RST docstrings resolve local names and an external Sphinx inventory', async () => {
    const source = join(directory, 'python/sample_api/_impl.py');
    await writeFile(source, (await readFile(source, 'utf8'))
      .replaceAll('{py:class}', ':class:').replaceAll('{py:func}', ':func:')
      .replace('with **an offset**.', 'with **an offset**. See :class:`foreign.Widget`.'));
    await writeFile(join(project, 'autodoc.mjs'), `import {createAutodoc} from '../package/index.mjs';
export default createAutodoc({modules: ['sample_api'], searchPaths: ['../python'], markup: 'rst', externalReferences: {foreign: ${JSON.stringify(url.replace('/preview/', '/foreign/'))}}});\n`);
    const output = await build();
    assert.doesNotMatch(output, /⚠️/);
    const page = JSON.parse(await readFile(join(site, 'content/api.json'), 'utf8'));
    const all = nodes(page.mdast);
    assert.ok(all.some(node => node.url?.endsWith('/foreign/index.html#foreign.Widget')), JSON.stringify(all.filter(node => node.url)));
    assert.ok(all.some(node => node.type === 'crossReference' && node.resolved && node.url === '/classes'));
  });

  await t.test('unknown names, wrong kinds, duplicate placements, and missing members fail', async () => {
    const index = join(project, 'index.md');
    for (const [source, message] of [
      ['{py:func}`sample_api.missing`', /Unresolved Python reference/],
      ['{py:class}`sample_api.solve`', /wrong kind/],
      ['{py:func}`foreign.Widget`', /Missing external Python func/],
      [':::{autodoc} sample_api.solve\n:::', /documented more than once/],
      [':::{autodoc} sample_api.Result\n:members: missing\n:::', /Unknown public member/],
    ]) {
      await writeFile(index, '# Invalid\n\n' + source + '\n');
      const output = await run(process.execPath, [cli, 'build'], project, { fails: true });
      assert.match(output, message);
    }
  });
});
