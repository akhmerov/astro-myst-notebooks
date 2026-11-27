import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visit } from 'unist-util-visit';
import { fromHtml } from 'hast-util-from-html';
import { setTimeout as pause } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Inventory } from 'intersphinx';
import { registerEngine, buildEngine, enginePages, publishEngine } from '../dist/engine/project.mjs';
import { renderPage } from '../dist/engine/render.mjs';

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'astro-engine-project-'));
  const root = pathToFileURL(directory + '/');
  const engine = registerEngine({ root, srcDir: root, cacheDir: new URL('.astro/', root), base: '/manual/', trailingSlash: 'always' },
    { myst: { source: root }, execution: { skip: true }, interactive: false });
  try { await callback(directory, engine); } finally { await rm(directory, { recursive: true, force: true }); }
}
const nodes = (tree, type) => { const values = []; visit(tree, type, node => { values.push(node); }); return values; };
async function render(engine, page, options = {}) {
  return (await renderPage(page, { root: engine.root, base: '/manual/', interactive: false,
    resolvePageUrl: slug => engine.routes.get(slug) ?? engine.routes.get(slug.replace(/^\/+|\/+$/g, '')),
    isPublicAsset: path => engine.publicAssets.has(path.startsWith('/') ? path : '/' + path),
    readAsset: path => readFile(join(engine.site, 'public', path.replace(/^\//, ''))),
    ...options,
  })).html;
}

test('the public compiler resolves includes, glossary, CSV, custom routes and assets before Astro rendering', () => fixture(async (root, engine) => {
  await mkdir(join(root, '_parts'));
  await writeFile(join(root, '_parts', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  await writeFile(join(root, '_parts', 'part.md'), 'Included **phrase** with α and 🧪.\n\n![Included image](image.svg)\n\n[Destination](../other.md#result)\n');
  await writeFile(join(root, 'index.md'), `---\ntitle: Home\n---\n\n\`\`\`{include} _parts/part.md\n\`\`\`\n\nSee {term}\`Kernel\`.\n\n\`\`\`{csv-table}\n:header-rows: 1\n\nName,Value\n"left, right","a ""quote"""\n\`\`\`\n`);
  await writeFile(join(root, 'other.md'), '---\ntitle: Destination\n---\n\n(result)=\n## Result\n\n```{glossary}\nKernel\n: A Python execution process.\n```\n');
  await writeFile(join(root, 'myst.yml'), 'version: 1\nproject:\n  toc:\n    - file: index.md\n    - file: other.md\n');
  engine.sourceOverrides = { 'other.md': { id: 'guide/custom', title: 'Custom title' } };
  await buildEngine(engine);
  const pages = await enginePages(engine);
  assert.deepEqual(pages.map(page => page.id).sort(), ['', 'guide/custom']);
  const page = pages.find(page => page.id === '').page;
  const phrase = nodes(page.mdast, 'text').find(node => node.value === 'phrase');
  assert.equal(phrase.data.origin.file, '_parts/part.md');
  assert.equal(phrase.data.origin.kind, 'exact');
  const source = await readFile(join(root, '_parts/part.md'), 'utf8');
  assert.equal(source.slice(phrase.data.origin.start, phrase.data.origin.end), 'phrase');
  const html = await render(engine, page);
  const table = JSON.parse(html.match(/<template id="myst-source-[a-f0-9]+" data-myst-source-map="1">([^<]*)<\/template>/)[1]);
  assert.ok(table.some(entry => entry.file === '_parts/part.md' && entry.lines[0] === 0));
  assert.match(html, /data-source-location="[a-f0-9]+:\d+:\d+:\d+(?::r)?"/);
  assert.doesNotMatch(await render(engine, page, { sourceMaps: false }), /data-source-location|data-source-generated|data-myst-source-map/);
  assert.match(html, /href="\/manual\/guide\/custom\/#result"/);
  assert.match(html, /href="\/manual\/guide\/custom\/#term-kernel"/);
  assert.match(html, /left, right/);
  assert.match(html, /a "quote"/);
  const image = nodes(fromHtml(html), 'element').find(node => node.tagName === 'img');
  assert.ok(image.properties.src.startsWith('/manual/'));
  const asset = image.properties.src.slice('/manual/'.length);
  assert.equal(await readFile(join(engine.site, 'public', asset), 'utf8'), await readFile(join(root, '_parts/image.svg'), 'utf8'));
  const output = join(root, 'dist');
  await publishEngine(engine, output);
  assert.ok(![...engine.publicAssets.keys()].some(path => /^\/(index|other)-[a-f0-9]+\.md$/.test(path)));
  const inventory = new Inventory({ path: join(output, 'objects.inv') });
  await inventory.load();
  assert.deepEqual(Object.keys(inventory.data['std:doc']).sort(), ['guide/custom', 'index']);
  assert.equal(inventory.data['std:doc']['guide/custom'].location, 'guide/custom/');
  assert.equal(inventory.data['std:doc']['guide/custom'].display, 'Custom title');
  assert.equal(inventory.data['std:doc'].index.location, './');
  const xrefs = JSON.parse(await readFile(join(output, 'myst.xref.json'), 'utf8'));
  const target = xrefs.references.find(ref => ref.identifier === 'result');
  assert.equal(new URL('https://example.org/manual' + target.url).pathname, '/manual/guide/custom/');
  assert.equal(JSON.parse(await readFile(join(output, target.data), 'utf8')).frontmatter.title, 'Destination');
  const search = JSON.parse(await readFile(join(output, 'myst.search.json'), 'utf8'));
  assert.ok(search.records.some(record => record.url === '/manual/guide/custom/#result'));
  assert.ok(search.records.every(record => record.url.startsWith('/manual/')));
  const minimal = join(root, 'minimal');
  await mkdir(minimal);
  engine.options.myst.publishContent = false;
  await publishEngine(engine, minimal);
  await assert.rejects(readFile(join(minimal, 'myst.xref.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(minimal, '_myst/config.json')), { code: 'ENOENT' });
  assert.ok((await readFile(join(minimal, 'objects.inv'))).length);
  assert.ok((await readFile(join(minimal, asset))).length);
  const withoutSources = join(root, 'without-sources');
  engine.options.myst.publishContent = true;
  engine.options.sourceMaps = false;
  await mkdir(withoutSources);
  await publishEngine(engine, withoutSources);
  const data = JSON.parse(await readFile(join(withoutSources, target.data), 'utf8'));
  assert.ok(nodes(data.mdast, 'text').every(node => !node.data?.origin));
}));

test('generated API document names and their relative locations follow Astro routes', () => fixture(async (root, engine) => {
  engine.base = '/api/';
  engine.trailingSlash = 'never';
  engine.options.api = { modules: ['geometry'], searchPaths: [root] };
  await writeFile(join(root, 'index.md'), '# Home\n');
  await writeFile(join(root, 'geometry.py'), '"""Geometry helpers."""\n\ndef area():\n    """Return an area."""\n    return 1\n');
  await buildEngine(engine);
  const output = join(root, 'dist');
  await publishEngine(engine, output);
  const inventory = new Inventory({ path: join(output, 'objects.inv') });
  await inventory.load();
  const docs = inventory.data['std:doc'];
  assert.deepEqual(Object.keys(docs).sort(), ['api/geometry', 'api/geometry/area', 'index']);
  assert.equal(docs['api/geometry/area'].location, 'api/geometry/area');
  assert.match(inventory.data['py:function']['geometry.area'].location, /^api\/geometry\/area#/);
}));

test('links in includes keep fragments and can target repository files without publishing copies', () => fixture(async (root, engine) => {
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'guide', 'index.md'), '# Guide\n');
  await mkdir(join(root, '_notes'));
  await mkdir(join(root, '_data'));
  await writeFile(join(root, '_data', 'table file.tsv'), 'header\n');
  await writeFile(join(root, '_data', 'download.md'), '# Downloadable source\n');
  await writeFile(join(root, '_notes', 'one.md'), '[Note](two.md#section) and [Heading](two.md#a--heading) and [Data](../_data/table%20file.tsv#L1) and [Directory](../_data/).\n\nSee {download}`source <../_data/download.md>`.\n');
  await writeFile(join(root, '_notes', 'two.md'), '(section)=\n## Section\n\n## A — heading\n');
  await writeFile(join(root, 'index.md'), '# Home\n\n[Home](/) [Guide](/guide/) [Relative](guide/)\n\n```{include} _notes/one.md\n```\n');
  await writeFile(join(root, 'target.md'), '---\nslug: some/note\n---\n\n# Target\n\n```{include} _notes/two.md\n```\n');
  engine.options.myst.repositoryLinks = { root: pathToFileURL(root + '/'),
    files: 'https://example.org/blob/rev/', directories: 'https://example.org/tree/rev' };
  const pages = await enginePages(engine);
  const html = await render(engine, pages.find(entry => entry.id === '').page);
  assert.match(html, /href="\/manual\/some\/note\/#section"/);
  assert.match(html, /href="\/manual\/some\/note\/#a-heading"/);
  assert.match(html, /https:\/\/example.org\/blob\/rev\/_data\/table%20file.tsv#L1/);
  assert.match(html, /https:\/\/example.org\/tree\/rev\/_data/);
  assert.doesNotMatch(html, /https:\/\/example.org\/tree\/rev\/guide/);
  assert.match(html, /href="\/manual\/download-[a-f0-9]+\.md"/);
  assert.doesNotMatch([...engine.publicAssets.keys()].join(' '), /two-[a-f0-9]+\.md|\.tsv/);
  await writeFile(join(root, '_notes', 'one.md'), 'See {download}`page source <../target.md>`.\n');
  await buildEngine(engine, { force: true });
  assert.ok([...engine.publicAssets.keys()].some(path => /^\/target-[a-f0-9]+\.md$/.test(path)));
  await writeFile(join(root, '_notes', 'one.md'), '[Heading](two.md#a--heading)\n');
  await writeFile(join(root, 'target.md'), '# Target\n\n```{include} _notes/two.md\n:end-before: ## A — heading\n```\n');
  await assert.rejects(buildEngine(engine, { force: true }), /fragment #a--heading is absent.*_notes\/one.md:1/);
  await writeFile(join(root, 'another.md'), '# Another\n\n```{include} _notes/two.md\n```\n');
  await assert.rejects(buildEngine(engine, { force: true }), /included on multiple pages/);
  await writeFile(join(root, '_notes', 'one.md'), '[Orphan](orphan.md)\n');
  await writeFile(join(root, '_notes', 'orphan.md'), '# Unpublished\n');
  await assert.rejects(buildEngine(engine, { force: true }), /Unresolved local MyST document link: .*orphan.md.*no published page or include/);
}));

test('project-wide DOI opt-out preserves ordinary DOI hyperlinks', () => fixture(async (root, engine) => {
  engine.options.myst.resolveDoiLinks = false;
  await writeFile(join(root, 'index.md'), '# Home\n\n[Paper](https://doi.org/10.1112/jtopol/jtm001)\n');
  const [{ page }] = await enginePages(engine);
  const [link] = nodes(page.mdast, 'link');
  assert.equal(link.url, 'https://doi.org/10.1112/jtopol/jtm001');
  assert.equal(link.protocol, undefined);
  assert.match(await render(engine, page), /href="https:\/\/doi.org\/10\.1112\/jtopol\/jtm001"/);
}));

test('trusted SVG stays inline and simplified math has inexact authored provenance', () => fixture(async (root, engine) => {
  const source = [
    '# Title', '', 'The sign is $\\pm$, the angle is $^{\\circ}$, and the number is $2.50$.',
    '', 'The powers and indices are $2^3$ and $4_{-5}$.', '',
    'Repeated powers $6^7$ and', '$6^7$.', '', 'One formula on', 'a continuation $8^9$.', '', '```{raw-html}',
    '<figure class="theme-figure"><svg viewBox="0 0 20 20"><path class="theme-line" d="M0 0h10"/></svg></figure>',
    '```', '', '```{csv-table}', '', 'price,$5.75$', '```', '',
  ].join('\n');
  await writeFile(join(root, 'index.md'), source);
  const [{ page }] = await enginePages(engine);
  const sign = nodes(page.mdast, 'text').find(node => node.value === '±');
  assert.equal(sign.data.origin.kind, 'range');
  assert.equal(sign.data.origin.transformation, 'markdown');
  for (const [formula, values] of [['$\\pm$', ['±']], ['$^{\\circ}$', ['°']], ['$2.50$', ['2.50']],
    ['$2^3$', ['2', '3']], ['$4_{-5}$', ['4', '-5']], ['$8^9$', ['8', '9']]]) {
    for (const value of values) {
      const { data: { origin } } = nodes(page.mdast, 'text').find(node => node.value === value);
      assert.equal(origin.kind, 'range');
      assert.equal(origin.transformation, 'markdown');
      assert.equal(source.slice(origin.start, origin.end), formula);
    }
  }
  const repeated = nodes(page.mdast, 'text').filter(node => ['6', '7'].includes(node.value));
  assert.equal(repeated.length, 4);
  for (const { data: { origin } } of repeated) {
    assert.equal(origin.kind, 'range');
    assert.equal(source.slice(origin.start, origin.end), 'Repeated powers $6^7$ and\n$6^7$.\n');
  }
  const html = await render(engine, page);
  assert.equal(nodes(page.mdast, 'text').find(node => node.value === '5.75').data.origin.transformation, 'csv');
  assert.match(html, /<figure class="theme-figure"><svg viewBox="0 0 20 20"><path class="theme-line"/);
}));

test('unresolved semantics and cyclic includes fail the compiler, and invalid deadlines fail before spawning', () => fixture(async (root, engine) => {
  await writeFile(join(root, 'myst.yml'), 'version: 1\nproject:\n  toc:\n    - file: index.md\n');
  for (const source of ['# Missing\n\nSee {ref}`absent`.\n', '# Missing page\n\n[missing](absent.md#target)\n', '# Unsupported\n\n:::{not-a-real-directive}\nBody\n:::\n', '# Cycle\n\n```{include} index.md\n```\n']) {
    await writeFile(join(root, 'index.md'), source);
    await assert.rejects(async () => {
      await buildEngine(engine, { force: true });
      for (const { page } of await enginePages(engine)) await render(engine, page);
    }, /MyST document build failed|Unresolved MyST reference|Unresolved local MyST document link|Unsupported resolved MyST node/);
  }
  engine.options.myst.buildTimeout = 0;
  await assert.rejects(buildEngine(engine, { force: true }), /buildTimeout must be positive/);
}));

test('an interrupted or killed Astro process cannot leave MyST or its native kernel running',
  { timeout: 20000, skip: process.platform !== 'linux' }, async () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) await fixture(async (root, engine) => {
      await writeFile(join(root, 'index.md'), [
        '# Shutdown', '', '```{code-cell} python', 'import os, ctypes', 'from pathlib import Path',
        'adapter = os.getppid()',
        'compiler = Path(f"/proc/{adapter}/stat").read_text().split(") ", 1)[1].split()[1]',
        'Path("pids").write_text(f"{os.getpid()} {adapter} {compiler}")',
        'ctypes.CDLL(None).sleep(60)', '```', '',
      ].join('\n'));
      const code = `import { registerEngine, buildEngine } from ${JSON.stringify(new URL('../dist/engine/project.mjs', import.meta.url).href)};
        const root = new URL(${JSON.stringify(pathToFileURL(root + '/').href)});
        await buildEngine(registerEngine({ root, srcDir: root, cacheDir: new URL('.astro/', root) },
          { myst: { source: root }, execution: { timeout: 60 } }));`;
      const astro = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
      const exited = once(astro, 'exit');
      let pids = [];
      try {
        for (let attempt = 0; attempt < 100 && !pids.length; attempt++) {
          if (astro.exitCode !== null) break;
          try {
            const contents = await readFile(join(root, 'pids'), 'utf8');
            if (/^\d+ \d+ \d+$/.test(contents)) pids = contents.split(' ').map(Number);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await pause(50);
        }
        assert.equal(pids.length, 3, 'the kernel must reach its native call before Astro receives the signal');
        astro.kill(signal);
        assert.deepEqual(await exited, [null, signal]);
        for (let attempt = 0; attempt < 60; attempt++) {
          const alive = await Promise.all(pids.map(async pid => {
            try { return !/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8')); }
            catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
          }));
          if (alive.every(value => !value)) return;
          await pause(50);
        }
        assert.fail(`Kernel, adapter or CLI survived Astro ${signal}: ${pids.join(', ')}`);
      } finally {
        astro.kill('SIGKILL');
        for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    });
  });

test('the MyST command deadline also terminates a kernel blocked inside a native call', { timeout: 20000 }, () => fixture(async (root, engine) => {
  engine.options.myst.buildTimeout = 5000;
  engine.options.execution = { timeout: 60 };
  await writeFile(join(root, 'myst.yml'), 'version: 1\nproject:\n  toc:\n    - file: index.md\n');
  await writeFile(join(root, 'index.md'), '# Deadline\n\n```{code-cell} python\nimport os, ctypes\nfrom pathlib import Path\nPath("kernel.pid").write_text(str(os.getpid()))\nctypes.CDLL(None).sleep(60)\n```\n');
  await assert.rejects(buildEngine(engine), /MyST project build deadline exceeded/);
  const pid = Number(await readFile(join(root, 'kernel.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the kernel actually started and reached the native call');
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return;
    } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return; throw error; }
    await pause(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  assert.fail(`Kernel ${pid} survived the MyST command deadline`);
}));
