import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { VFile } from 'vfile';
import { remarkMyst, mystRehype } from '../../dist/myst.mjs';
import { renderPage, pagesFromManifest } from './theme/content.mjs';

// These probes compare the existing document renderer with the resolved trees
// produced by the real MyST driver. They record gaps, rather than changing them.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/mystmd/dist/myst.cjs');
const theme = fileURLToPath(new URL('./theme/', import.meta.url));
const provenance = fileURLToPath(new URL('./provenance.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'myst-pipeline-probes-'));
const results = { myst: '1.11.0', date: new Date().toISOString().slice(0, 10), probes: [] };
const walk = (node, fn) => { fn(node); for (const child of node.children ?? []) walk(child, fn); };

async function fixture(name, source, { plugins = [], extra = '', toc = '    - file: index.md\n' } = {}) {
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, 'index.md'), source);
  await writeFile(join(directory, 'myst.yml'), `version: 1\nproject:\n  title: Pipeline probe\n  plugins: ${JSON.stringify(plugins)}\n${extra}  toc:\n${toc}site:\n  template: ${JSON.stringify(theme)}\n`);
  return directory;
}

async function build(directory, exports = false) {
  const child = spawn(process.execPath, [cli, 'build', ...(exports ? ['index.md', '--docx'] : []), '--site', '--strict'], {
    cwd: directory,
    env: { ...process.env, MYST_THEME_EXECUTION: 'document' },
  });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  let exit;
  try { exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); }
  finally { clearTimeout(timer); }
  // Never retain full tool logs. These fixtures do not launch Jupyter kernels.
  return { exit, filteredIncludesRejected: text.includes('does not support filtered includes') };
}

async function baseline(source, directory) {
  const processor = unified().use(remarkMyst, { root: directory }).use(remarkRehype, mystRehype);
  const file = new VFile({ path: join(directory, 'index.md'), value: source });
  return toHtml(await processor.run(processor.parse(file), file));
}

async function custom(directory) {
  const page = JSON.parse(await readFile(join(directory, '_build/site/content/index.json')));
  const types = new Set();
  walk(page.mdast, node => types.add(node.type));
  try {
    return { rendered: true, nodeTypes: [...types].sort(), html: (await renderPage(page, { root: directory })).html };
  } catch (error) {
    return { rendered: false, nodeTypes: [...types].sort(), error: error.message };
  }
}

for (const [name, source, files, expected] of [
  ['tabs', '# Tabs\n\n::::{tab-set}\n:::{tab-item} First\nFirst panel.\n:::\n:::{tab-item} Second\nSecond panel.\n:::\n::::\n', {}, /role="tablist"/],
  ['citations', '---\nbibliography: refs.bib\n---\n# Citations\n\nSee {cite:p}`example`.\n',
    { 'refs.bib': '@misc{example, author={Example, Alice}, title={Example work}, year={2026}}' }, /Example work/],
]) {
  const directory = await fixture(name, source);
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content);
  assert.match(await baseline(source, directory), expected);
  const driver = await build(directory);
  assert.equal(driver.exit, 0, `${name}: MyST driver failed`);
  const rendered = await custom(directory);
  assert.equal((await build(directory, true)).exit, 0, `${name}: Word export failed`);
  const exported = spawnSync('python', ['-c', 'import sys,zipfile,xml.etree.ElementTree as ET; root=ET.fromstring(zipfile.ZipFile(sys.argv[1]).read("word/document.xml")); print("".join(node.text or "" for node in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")))', join(directory, '_build/exports/index.doc')], { encoding: 'utf8' });
  assert.equal(exported.status, 0);
  results.probes.push({ name, baselineRendered: true, driverComputed: true,
    customRendered: rendered.rendered, error: rendered.error,
    wordContainsContent: exported.stdout.includes(name === 'tabs' ? 'First panel.' : 'Example work'),
    wordText: exported.stdout.trim(),
    resolvedNodeTypes: rendered.nodeTypes });
}

const filteredSource = '# Include\n\n```{include} part.md\n:start-line: 1\n```\n';
for (const enabled of [false, true]) {
  const directory = await fixture(`filtered-${enabled}`, filteredSource, { plugins: enabled ? [provenance] : [] });
  await writeFile(join(directory, 'part.md'), 'Excluded line.\nSelected line.\n');
  if (!enabled) assert.match(await baseline(filteredSource, directory), /Selected line/);
  const driver = await build(directory);
  assert.equal(driver.exit === 0, !enabled);
  if (enabled) assert.equal(driver.filteredIncludesRejected, true);
  results.probes.push({ name: `filtered include, provenance ${enabled ? 'on' : 'off'}`, ...driver });
}

const grouped = await fixture('grouped-toc', '# Home\n', { toc: '    - file: index.md\n    - title: Guide\n      children:\n        - file: first.md\n        - file: second.md\n' });
await writeFile(join(grouped, 'first.md'), '# First\n');
await writeFile(join(grouped, 'second.md'), '# Second\n');
assert.equal((await build(grouped)).exit, 0);
const manifest = JSON.parse(await readFile(join(grouped, '_build/site/config.json')));
const groupedResult = { name: 'grouped table of contents', driverComputed: true,
  driverPages: manifest.projects[0].pages };
try {
  groupedResult.themeSidebar = pagesFromManifest(manifest).map(page => ({ label: page.title, slug: page.id }));
} catch (error) { groupedResult.themeError = error.message; }
results.probes.push(groupedResult);

const publisher = await fixture('publisher', '# Publisher\n\n(shared-target)=\n## Shared result\n\nPublished content.\n');
assert.equal((await build(publisher)).exit, 0);
const site = join(publisher, '_build/site');
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (!path.startsWith('/published/')) { res.writeHead(404).end(); return; }
    const file = resolve(site, path.slice('/published/'.length));
    if (!file.startsWith(site + '/')) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/published/`;
  const consumer = await fixture('consumer', '# Consumer\n\n[Shared result](xref:remote#shared-target).\n', {
    extra: `  references:\n    remote: ${url}\n`,
  });
  assert.equal((await build(consumer)).exit, 0);
  const page = JSON.parse(await readFile(join(consumer, '_build/site/content/index.json')));
  let reference;
  walk(page.mdast, node => { if (node.type === 'crossReference') reference = node; });
  assert.equal(reference.resolved, true);
  assert.equal(reference.remoteBaseUrl, url.slice(0, -1));
  const rendered = await custom(consumer);
  assert.equal(rendered.rendered, true);
  const href = /href="([^"]+)"/.exec(rendered.html)?.[1];
  results.probes.push({ name: 'external MyST reference', driverResolved: true,
    resolvedUrl: reference.url, remoteBaseUrlPresent: true, renderedHref: href,
    themeLinksToPublisher: href?.startsWith(url) ?? false });
} finally { await new Promise(resolve => server.close(resolve)); }

const output = resolve(process.argv[2] ?? join(root, 'results.json'));
await writeFile(output, JSON.stringify(results, null, 2) + '\n');
console.log(`Pipeline probes: ${results.probes.length}; results: ${output}; fixtures: ${root}`);
