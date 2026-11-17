import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visit } from 'unist-util-visit';
import { fromHtml } from 'hast-util-from-html';
import { setTimeout as pause } from 'node:timers/promises';
import { registerEngine, buildEngine, enginePages } from '../dist/engine/project.mjs';
import { renderPage } from '../dist/engine/render.mjs';

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'astro-engine-project-'));
  const root = pathToFileURL(directory + '/');
  const engine = registerEngine({ root, srcDir: root, cacheDir: new URL('.astro/', root), base: '/manual/', trailingSlash: 'always' },
    { myst: { source: root }, execution: { skip: true }, interactive: false });
  try { await callback(directory, engine); } finally { await rm(directory, { recursive: true, force: true }); }
}
const nodes = (tree, type) => { const values = []; visit(tree, type, node => { values.push(node); }); return values; };
async function render(engine, page) {
  return (await renderPage(page, { root: engine.root, base: '/manual/', interactive: false,
    resolvePageUrl: slug => engine.routes.get(slug) ?? engine.routes.get(slug.replace(/^\/+|\/+$/g, '')),
    readAsset: path => readFile(join(engine.site, 'public', path.replace(/^\//, ''))),
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
  assert.match(html, /href="\/manual\/guide\/custom\/#result"/);
  assert.match(html, /href="\/manual\/guide\/custom\/#term-kernel"/);
  assert.match(html, /left, right/);
  assert.match(html, /a "quote"/);
  const image = nodes(fromHtml(html), 'element').find(node => node.tagName === 'img');
  assert.ok(image.properties.src.startsWith('/manual/'));
  const asset = image.properties.src.slice('/manual/'.length);
  assert.equal(await readFile(join(engine.site, 'public', asset), 'utf8'), await readFile(join(root, '_parts/image.svg'), 'utf8'));
}));

test('unresolved semantics and cyclic includes fail the compiler, and invalid deadlines fail before spawning', () => fixture(async (root, engine) => {
  await writeFile(join(root, 'myst.yml'), 'version: 1\nproject:\n  toc:\n    - file: index.md\n');
  for (const source of ['# Missing\n\nSee {ref}`absent`.\n', '# Unsupported\n\n:::{not-a-real-directive}\nBody\n:::\n', '# Cycle\n\n```{include} index.md\n```\n']) {
    await writeFile(join(root, 'index.md'), source);
    await assert.rejects(async () => {
      await buildEngine(engine, { force: true });
      for (const { page } of await enginePages(engine)) await render(engine, page);
    }, /MyST document build failed|Unresolved MyST reference|Unsupported resolved MyST node/);
  }
  engine.options.myst.buildTimeout = 0;
  await assert.rejects(buildEngine(engine, { force: true }), /buildTimeout must be positive/);
}));

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
