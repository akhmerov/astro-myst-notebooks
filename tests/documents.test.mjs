import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visit } from 'unist-util-visit';
import { resolveDocument } from '../dist/documents.mjs';
import { executePage, checkEnvironment } from '../dist/jupyter.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'myst-documents-'));
  try { await fn(root); } finally { await rm(root, { recursive: true }); }
}
const nodes = (tree, type) => { const found = []; visit(tree, type, node => found.push(node)); return found; };

test('MyST includes, citations, numbered targets and cross-page routes resolve through existing transforms', () => fixture(async root => {
  const main = '---\ntitle: Main\nbibliography: refs.bib\n---\n\n```{include} part.md\n```\n\nSee {eq}`energy` and {numref}`icon` and {cite:p}`example`.\n\n[](./other.md#other-equation)';
  const part = 'An **included phrase** with α and 🧪.\n\n(energy)=\n```{math}\nE=mc^2\n```\n\n```{figure} /icon.png\n:name: icon\n\nAn icon.\n```';
  await writeFile(join(root, 'main.md'), main);
  await writeFile(join(root, 'part.md'), part);
  await writeFile(join(root, 'refs.bib'), '@misc{example, author={Example, Alice}, title={Example work}, year={2026}}');
  await writeFile(join(root, 'other.md'), '---\ntitle: Other\n---\n\n(other-equation)=\n```{math}\nx=1\n```');
  const manifest = join(root, 'documents.json');
  await writeFile(manifest, JSON.stringify([{path:join(root,'main.md'),url:'/main/'},{path:join(root,'other.md'),url:'/custom-other/'}]));
  const tree = await resolveDocument(main, { path: join(root, 'main.md') }, { root, documents: manifest });
  assert.equal(nodes(tree, 'include').length, 0);
  const phrase = nodes(tree, 'text').find(node => node.value === 'included phrase');
  assert.equal(phrase.data.origin.file, 'part.md');
  assert.equal(phrase.data.origin.kind, 'exact');
  assert.equal(part.slice(phrase.data.origin.start, phrase.data.origin.end), 'included phrase');
  assert.equal(nodes(tree, 'math')[0].enumerator, '1');
  assert.ok(nodes(tree, 'link').some(node => node.url === '/custom-other/#other-equation'));
  assert.ok(nodes(tree, 'link').some(node => node.url === '#cite-example'));
  assert.ok(nodes(tree, 'html').some(node => node.value.includes('Example work')));
  await writeFile(join(root, 'part.md'), part.replace('included phrase', 'updated phrase'));
  const updated = await resolveDocument(main, {path:join(root,'main.md')}, {root, documents:manifest});
  assert.ok(nodes(updated, 'text').some(node => node.value === 'updated phrase'));
}));

test('unresolved semantics, missing/cyclic includes and ambiguous labels fail explicitly', () => fixture(async root => {
  const path = join(root, 'main.md');
  for (const source of ['{eq}`missing`', '[](#missing)', '{cite:p}`missing`', '```mermaid\ngraph LR; A-->B;\n```', '```{include} absent.md\n```', '```{embed} other.md\n```']) {
    await assert.rejects(resolveDocument(source, {path}, {root}));
  }
  await writeFile(path, '```{include} main.md\n```');
  await assert.rejects(resolveDocument('```{include} main.md\n```', {path}, {root}), /depends on itself/);
  const routes = [{path,url:'/main/'}, ...['a','b'].map(name=>({path:join(root,name+'.md'),url:`/${name}/`}))];
  for (const {path} of routes.slice(1)) await writeFile(path,'(same)=\n```{math}\nx=1\n```');
  const manifest=join(root,'routes.json'); await writeFile(manifest,JSON.stringify(routes));
  for(const source of ['{eq}`same`','[](a.md#missing)']) {
    await writeFile(path,source);
    await assert.rejects(resolveDocument(source,{path},{root,documents:manifest}), /Ambiguous|Unresolved/);
  }
}));

test('source ranges preserve prose formatting, Unicode, escapes and executable body lines', () => fixture(async root => {
  const source = '---\ntitle: Source\n---\n\nText **bold** and [link](https://example.com), α 🧪 and &amp;.\n\n```{code-cell} python\n:tags: [hide-input]\n\nx=1\n1/0\n```';
  const tree = await resolveDocument(source, {path:join(root,'source.md')}, {root});
  for (const text of nodes(tree, 'text').filter(node => node.data?.origin?.kind === 'exact')) {
    assert.equal(source.slice(text.data.origin.start, text.data.origin.end), text.value);
  }
  for (const value of ['bold','link']) assert.equal(nodes(tree,'text').find(node=>node.value===value).data.origin.kind,'exact');
  const cell = nodes(tree,'code').find(node=>node.executable);
  assert.equal(cell.data.origin.lines[0].position.start.line, 10);
  assert.equal(cell.data.origin.lines[1].position.start.line, 11);
  assert.equal(source.slice(cell.data.origin.lines[1].start,cell.data.origin.lines[1].end),'1/0');
}));

test('Jupyter checks Pixi requirements and returns structured failures with cell source maps', () => fixture(async root => {
  const manifest = join(root, 'pixi.toml');
  await writeFile(manifest, '[feature.docs.dependencies]\nnbclient=">=999"\nnbformat=">=5"\nipykernel=">=6"');
  await assert.rejects(checkEnvironment({cwd:root,pixi:{manifest,feature:'docs'}}), /does not satisfy Pixi requirement/);
  const mismatch = spawnSync('python', [fileURLToPath(new URL('../dist/execute.py', import.meta.url))], {
    input: JSON.stringify({protocol:999,operation:'check'}), encoding:'utf8',
  });
  assert.match(JSON.parse(mismatch.stdout).error.message,/Unsupported execution protocol/);
  const environment = await checkEnvironment({cwd:root});
  assert.equal(environment.protocol,1);
  assert.ok(environment.versions.nbclient);
  const origin = {file:'lesson.md',start:10,end:13,lines:[{position:{start:{line:4,column:1}}}]};
  await assert.rejects(executePage([{id:'failure-cell',source:'1/0',origin}], {cwd:root}), error => {
    assert.equal(error.cell.id,'failure-cell');
    assert.deepEqual(error.cell.origin,origin);
    assert.match(error.message,/ZeroDivisionError/);
    return true;
  });
}));
