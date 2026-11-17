import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { renderPage, pagesFromManifest, navigationFromManifest } from '../dist/engine/render.mjs';
import { hydrateOutput } from '../dist/engine/notebook.mjs';
import { renderEngine } from './helpers/engine.mjs';

const require = createRequire(import.meta.url);
const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const mystManifest = require.resolve('mystmd/package.json');
const myst = join(dirname(mystManifest), 'dist/myst.cjs');
const elements = html => {
  const result = [];
  visit(fromHtml(html, { fragment: true }), 'element', node => { result.push(node); });
  return result;
};
const text = node => node.type === 'text' ? node.value : (node.children ?? []).map(text).join('');
let root, site, pages, manifest;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'myst-engine-render-'));
  site = join(root, '_build/site');
  await mkdir(join(root, 'guide'));
  await writeFile(join(root, 'bridge.mjs'), `import {createProvenance} from ${JSON.stringify(join(repo, 'dist/engine/provenance.mjs'))};\nimport {createDocumentExecution} from ${JSON.stringify(join(repo, 'dist/engine/execution.mjs'))};\nconst p=createProvenance({root:${JSON.stringify(root)}});\nconst e=createDocumentExecution({root:${JSON.stringify(root)},python:${JSON.stringify(join(dirname(process.execPath), 'python'))},timeout:15});\nexport default {name:'fixture',transforms:[...p.transforms,...e.transforms]};\n`);
  await writeFile(join(root, 'myst.yml'), `version: 1\nproject:\n  title: Renderer fixture\n  plugins: [./bridge.mjs]\n  toc:\n    - file: index.md\n    - title: Guide\n      children:\n        - file: guide/next.md\nsite:\n  template: ${JSON.stringify(join(repo, 'tests/fixtures/data-template'))}\n`);
  await writeFile(join(root, 'index.md'), `---\nbibliography: refs.bib\n---\n# Renderer fixture\n\nSee {cite:p}\`example\` and {cite:t}\`example\`.\n\n::::{tab-set}\n:::{tab-item} First\nFirst panel.\n:::\n:::{tab-item} Second\n:selected:\nSecond panel.\n:::\n::::\n\n:::{admonition} Details\n:class: dropdown tip custom\n\nHidden details.\n:::\n\n- Tight one\n- Tight two\n\n1. Loose one\n\n2. Loose two\n\n:::{card} Continue\n:link: guide/next.md\n\nContinue the guide.\n:::\n\n\`\`\`{code-cell} python\n:tags: [hide-input]\n:label: result\n\nprint('Computed 42')\ndisplay(43)\nprint('Tail output')\n\`\`\`\n\nInline result is {eval}\`6 * 7\`.\n\nSee [](#equation).\n\n\`\`\`{bibliography}\n\`\`\`\n`);
  await writeFile(join(root, 'refs.bib'), '@misc{example, author={Example, Alice}, title={Example work}, year={2026}}\n');
  await writeFile(join(root, 'guide/next.md'), '# Next\n\n```{math}\n:label: equation\n\nx = 42\n```\n\n![](#result)\n');
  const built = spawnSync(process.execPath, [myst, 'build', '--site', '--strict'], {
    cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  manifest = JSON.parse(await readFile(join(site, 'config.json')));
  pages = new Map(await Promise.all(pagesFromManifest(manifest).map(async entry => [entry.id,
    JSON.parse(await readFile(join(site, 'content', entry.slug + '.json')))])));
});
after(async () => { if (root && !process.env.ASTRO_ENGINE_KEEP_FIXTURE) await rm(root, { recursive: true, force: true }); else if (root) console.log(`Renderer fixture: ${root}`); });
const render = (page, opts = {}) => renderPage(page, { root, base: '/manual/',
  readAsset: path => readFile(join(site, 'public', path.replace(/^\//, ''))), ...opts });

test('actual MyST citations, tabs, themed disclosures, tight lists, and page links render faithfully', async () => {
  const { html } = await render(pages.get(''));
  const nodes = elements(html);
  const cites = nodes.filter(node => node.properties.href === '#cite-example');
  assert.equal(cites.length, 2);
  assert.deepEqual(cites.map(text), ['Example, 2026', 'Example (2026)']);
  const bibliographyEntry = nodes.find(node => node.properties.id === 'cite-example');
  assert.ok(bibliographyEntry && /Example work/.test(text(bibliographyEntry)));
  assert.ok(bibliographyEntry.children.some(node => node.tagName === 'i' && text(node) === 'Example work'));
  assert.doesNotMatch(html, /class="block" class=/);
  const tabs = nodes.filter(node => node.properties.role === 'tab');
  assert.deepEqual(tabs.map(text), ['First', 'Second']);
  assert.deepEqual(tabs.map(node => node.properties.ariaSelected), ['false', 'true']);
  assert.equal(nodes.filter(node => node.properties.role === 'tabpanel').length, 2);
  assert.ok(nodes.some(node => node.tagName === 'details' && node.properties.className?.includes('starlight-aside--tip')));
  assert.ok(nodes.some(node => node.tagName === 'summary' && text(node) === 'Details'));
  const tight = nodes.find(node => node.tagName === 'ul' && text(node).includes('Tight one'));
  assert.equal(tight.children.flatMap(n => n.children ?? []).filter(n => n.tagName === 'p').length, 0);
  const loose = nodes.find(node => node.tagName === 'ol' && text(node).includes('Loose one'));
  assert.equal(loose.children.flatMap(n => n.children ?? []).filter(n => n.tagName === 'p').length, 2);
  assert.ok(nodes.some(node => node.tagName === 'a' && node.properties.className?.includes('card') && node.properties.href.startsWith('/manual/')));
  assert.ok(nodes.some(node => node.tagName === 'a' && /equation$/.test(node.properties.href ?? '') && node.properties.href.startsWith('/manual/')));
});

test('browser-decoded citation and footnote fragments select their generated anchors', async () => {
  const label = 'https://doi.org/10.48550/arxiv.1909.09649';
  const page = structuredClone(pages.get(''));
  page.references.cite.data[label] = page.references.cite.data.example;
  page.references.cite.order = [label];
  visit(page.mdast, 'cite', node => { node.label = label; });
  const citation = elements((await render(page)).html);
  const footnotes = elements(await renderEngine('A note [^1^].\n\n[^1^]: The footnote.\n'));
  for (const [document, prefix, count] of [[citation, '#cite-', 2], [footnotes, '#user-content-fn', 2]]) {
    const links = document.filter(node => node.properties.href?.startsWith(prefix));
    assert.equal(links.length, count);
    for (const link of links) {
      const target = decodeURIComponent(link.properties.href.slice(1));
      assert.ok(document.some(node => node.properties.id === target), `Missing fragment destination ${target}`);
    }
  }
});

test('computed notebook markup retains controls, presentation layers, inline values, and output-only embeds', async () => {
  const { html } = await render(pages.get(''), { presentation: { stderr: 'remove' }, frontmatter: { presentation: { input: 'hide' } } });
  const nodes = elements(html);
  const cell = nodes.find(node => node.properties.className?.includes('jupyter-cell'));
  assert.ok(cell);
  assert.equal(JSON.parse(cell.properties.dataPresentation).input, 'hide');
  assert.equal(JSON.parse(cell.properties.dataPresentation).stderr, 'remove');
  assert.ok(nodes.some(node => node.properties.className?.includes('jupyter-input-disclosure')));
  assert.ok(nodes.some(node => Object.hasOwn(node.properties, 'dataThebeActivate')));
  assert.ok(nodes.some(node => node.properties.className?.includes('jupyter-output') && text(node).includes('Computed 42')));
  assert.ok(nodes.some(node => node.properties.className?.includes('jupyter-output') && text(node).trim() === '43'));
  assert.ok(nodes.some(node => node.properties.className?.includes('jupyter-output') && text(node).includes('Tail output')));
  assert.match(text(fromHtml(html, { fragment: true })), /Inline result is 42\./);
  const next = [...pages.entries()].find(([id]) => id !== '')[1];
  const embedded = elements((await render(next)).html);
  assert.ok(embedded.some(node => node.properties.className?.includes('jupyter-output') && text(node).includes('Computed 42')));
  assert.equal(embedded.filter(node => node.tagName === 'jupyter-notebook').length, 0);
  const disabled = elements((await render(pages.get(''), { frontmatter: { thebe: false } })).html);
  assert.equal(disabled.filter(node => node.tagName === 'jupyter-notebook').length, 0);
});

test('grouped MyST navigation preserves group headers without treating them as pages', () => {
  assert.equal(pagesFromManifest(manifest).length, 2);
  const nav = navigationFromManifest(manifest);
  const group = nav.find(entry => entry.label === 'Guide');
  assert.ok(group?.items?.some(entry => entry.label === 'Next'));
  const explicit = structuredClone(manifest);
  explicit.projects[0].pages = [{ title: 'Section', level: 1 }, { slug: 'guide/nested', title: 'Nested', level: 2 }];
  assert.equal(pagesFromManifest(explicit)[1].id, 'guide/nested');
  assert.equal(navigationFromManifest(explicit)[1].items[0].slug, 'guide/nested');
});

test('remote reference bases remain external and unsupported semantics fail explicitly', async () => {
  const page = structuredClone(pages.get(''));
  page.mdast = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'crossReference', resolved: true,
    identifier: 'target', html_id: 'target', url: '/chapter', remoteBaseUrl: 'https://remote.example/book', children: [{ type: 'text', value: 'Remote' }] }] }] };
  const html = (await render(page)).html;
  assert.match(html, /href="https:\/\/remote\.example\/book\/chapter#target"/);
  assert.doesNotMatch(html, /\/manual\/chapter/);
  delete page.mdast.children[0].children[0].remoteBaseUrl;
  page.mdast.children[0].children[0].url = '/next?view=full#chosen';
  const mapped = (await render(page, { resolvePageUrl: value => value === '/next' ? '/manual/guide/next/' : undefined })).html;
  assert.match(mapped, /href="\/manual\/guide\/next\/\?view=full#chosen"/);
  delete page.mdast.children[0].children[0].url;
  const local = (await render(page, { resolvePageUrl: () => undefined })).html;
  assert.match(local, /href="#target"/);
  page.mdast.children[0].children[0].type = 'notSupportedHere';
  await assert.rejects(render(page), /Unsupported resolved MyST node: notSupportedHere/);
});

test('MIME hydration preserves nbformat JSON data and reads stored binary assets', async () => {
  const data = await hydrateOutput({ output_type: 'display_data', data: {
    'application/vnd.plotly.v1+json': { data: [{ x: [1], y: [2] }] },
    'image/png': { path: '/figure.png', content_type: 'image/png' },
  } }, async () => new Response(new Uint8Array([137, 80, 78, 71])));
  assert.deepEqual(data.data['application/vnd.plotly.v1+json'], { data: [{ x: [1], y: [2] }] });
  assert.equal(data.data['image/png'], 'iVBORw==');
});
