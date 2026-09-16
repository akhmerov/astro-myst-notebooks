import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
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
const nodes = (tree, type) => { const found = []; visit(tree, type, node => { found.push(node); }); return found; };

test('CSV directives preserve quoted delimiters, escaped quotes, headers and custom delimiters', () => fixture(async root => {
  for (const delimiter of [',', ';']) {
    const source = [
      '```{csv-table}', `:delim: ${delimiter}`, ':header-rows: 1', '',
      `Name${delimiter}Value`, `"left${delimiter} right"${delimiter}"a ""quote"""`, '```',
    ].join('\n');
    const tree = await resolveDocument(source, { path: join(root, 'table.md') }, { root });
    const rows = nodes(tree, 'tableRow');
    assert.deepEqual(rows.map(row => row.children.map(cell => nodes(cell, 'text').map(node => node.value).join(''))),
      [['Name', 'Value'], [`left${delimiter} right`, 'a "quote"']]);
    assert.ok(rows[0].children.every(cell => cell.header === true));
    assert.ok(rows[1].children.every(cell => !cell.header));
  }
}));

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

test('relative assets inside includes are rebased onto the including page', () => fixture(async root => {
  await mkdir(join(root, 'pages', 'parts'), { recursive: true });
  await writeFile(join(root, 'pages', 'parts', 'part.md'), [
    '![alt](./figure.png)', '[data](../data/table.csv#row)', '[page](../other.md)', '[abs](/static.png)', '[site](https://example.org/x.png)',
    '```{iframe} ./frame.html\n```', '```{figure} figure.svg\n\nCaption.\n```',
  ].join('\n\n'));
  await writeFile(join(root, 'other.md'), '---\ntitle: Other\n---\n\nText');
  const path = join(root, 'pages', 'index.md');
  const source = '```{include} parts/part.md\n```\n\n![own](./own.png)';
  await writeFile(path, source);
  const manifest = join(root, 'documents.json');
  await writeFile(manifest, JSON.stringify([{ path, url: '/pages/' }, { path: join(root, 'other.md'), url: '/other/' }]));
  const tree = await resolveDocument(source, { path }, { root, documents: manifest });
  assert.deepEqual(nodes(tree, 'image').map(node => node.url), ['./parts/figure.png', './parts/figure.svg', './own.png']);
  assert.deepEqual(nodes(tree, 'link').map(node => node.url), ['./data/table.csv#row', '/other/', '/static.png', 'https://example.org/x.png']);
  assert.equal(nodes(tree, 'iframe')[0].src, './parts/frame.html');
}));

test('embed copies labelled content across pages and refuses executed cells', () => fixture(async root => {
  const other = '---\ntitle: Other\n---\n\n```{figure} /icon.png\n:name: shared-figure\n\nA **shared** caption.\n```\n\n```{code-cell} python\n:name: shared-cell\n\nx = 1\n```';
  const source = '(local-eq)=\n```{math}\nx = 1\n```\n\n```{embed} #shared-figure\n```\n\n```{embed} local-eq\n```';
  const path = join(root, 'index.md');
  await writeFile(join(root, 'other.md'), other);
  await writeFile(path, source);
  const manifest = join(root, 'documents.json');
  await writeFile(manifest, JSON.stringify([{ path, url: '/' }, { path: join(root, 'other.md'), url: '/other/' }]));
  const tree = await resolveDocument(source, { path }, { root, documents: manifest });
  assert.equal(nodes(tree, 'embed').length, 0);
  const figure = nodes(tree, 'container')[0];
  assert.equal(figure.identifier, undefined);
  assert.equal(nodes(figure, 'text').find(node => node.value === 'shared').data.origin.file, 'other.md');
  assert.equal(nodes(tree, 'math').length, 2);
  assert.equal(nodes(tree, 'math').filter(node => node.identifier === 'local-eq').length, 1);
  for (const [embed, message] of [['```{embed} #shared-cell\n```', /Cannot embed an executed cell/], ['```{embed} #absent\n```', /Unresolved embed target/]]) {
    await writeFile(path, embed);
    await assert.rejects(resolveDocument(embed, { path }, { root, documents: manifest }), message);
  }
}));

test('card links to collection pages resolve through the route manifest', () => fixture(async root => {
  await writeFile(join(root, 'other.md'), '---\ntitle: Other\n---\n\n(target)=\n## Section');
  const manifest = join(root, 'documents.json');
  const path = join(root, 'index.md');
  await writeFile(manifest, JSON.stringify([{ path, url: '/' }, { path: join(root, 'other.md'), url: '/other/' }]));
  const source = ':::{card} Other\n:link: other.md#target\nBody\n:::\n\n:::{card} Page\n:link: other.md\nBody\n:::';
  await writeFile(path, source);
  const tree = await resolveDocument(source, { path }, { root, documents: manifest });
  assert.deepEqual(nodes(tree, 'card').map(node => node.url), ['/other/#target', '/other/']);
  const missing = ':::{card}\n:link: other.md#missing\nBody\n:::';
  await writeFile(path, missing);
  await assert.rejects(resolveDocument(missing, { path }, { root, documents: manifest }), /Unresolved reference/);
}));

test('glossary terms resolve locally and across pages', () => fixture(async root => {
  const glossary = '---\ntitle: Terms\n---\n\n```{glossary}\nKernel\n: The executing process.\n```\n\nA {term}`kernel` and {term}`the kernel <Kernel>`.';
  const other = '---\ntitle: Other\n---\n\nRemote {term}`Kernel`.';
  await writeFile(join(root, 'terms.md'), glossary);
  await writeFile(join(root, 'other.md'), other);
  const manifest = join(root, 'documents.json');
  await writeFile(manifest, JSON.stringify([{ path: join(root, 'terms.md'), url: '/terms/' }, { path: join(root, 'other.md'), url: '/other/' }]));
  const tree = await resolveDocument(glossary, { path: join(root, 'terms.md') }, { root, documents: manifest });
  assert.equal(nodes(tree, 'glossary').length, 1);
  assert.equal(nodes(tree, 'definitionTerm')[0].html_id, 'term-kernel');
  const links = nodes(tree, 'link').filter(node => node.url === '#term-kernel');
  assert.deepEqual(links.map(link => nodes(link, 'text').map(node => node.value).join('')), ['kernel', 'the kernel']);
  const remote = await resolveDocument(other, { path: join(root, 'other.md') }, { root, documents: manifest });
  assert.ok(nodes(remote, 'link').some(node => node.url === '/terms/#term-kernel'));
  await assert.rejects(resolveDocument('{term}`missing`', { path: join(root, 'other.md') }, { root }), /Unresolved reference/);
}));

test('unresolved semantics, missing/cyclic includes and ambiguous labels fail explicitly', () => fixture(async root => {
  const path = join(root, 'main.md');
  for (const source of ['{eq}`missing`', '[](#missing)', '{cite:p}`missing`', '```{include} absent.md\n```', '```{embed} other.md\n```']) {
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


test('links in included text use source files and containing-page routes', () => fixture(async root => {
  await mkdir(join(root, 'docs'));
  const main = '```{include} ../CONTRIBUTING.md\n```';
  await writeFile(join(root, 'docs', 'developer.md'), main);
  await writeFile(join(root, 'CONTRIBUTING.md'), '[Changes](CHANGELOG.md) and [Tutorial](tutorial.md)');
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog');
  await writeFile(join(root, 'docs', 'changes.md'), '```{include} ../CHANGELOG.md\n```');
  await writeFile(join(root, 'docs', 'tutorial.md'), '# Tutorial');
  const documents = join(root, 'routes.json');
  const routes = ['developer', 'changes', 'tutorial'].map(name => ({path:join(root,'docs',name+'.md'),url:`/${name}/`}));
  await writeFile(documents, JSON.stringify(routes));
  const tree = await resolveDocument(main, {path:routes[0].path}, {root, documents});
  assert.deepEqual([...new Set(nodes(tree, 'link').map(node=>node.url))], ['/changes/', '/tutorial/']);
  await writeFile(join(root, 'docs', 'other.md'), '```{include} ../CHANGELOG.md\n```');
  await writeFile(documents, JSON.stringify([...routes, {path:join(root,'docs','other.md'), url:'/other/'}]));
  await assert.rejects(resolveDocument(main, {path:routes[0].path}, {root, documents}), /Ambiguous/);
}));


test('equation anchors survive KaTeX and deployment bases preserve local links', async () => {
  const { unified } = await import('unified');
  const { mystRehype, rehypeDocumentBase, rehypeMathErrors } = await import('../dist/myst.mjs');
  const { default: remarkRehype } = await import('remark-rehype');
  const { default: rehypeKatex } = await import('rehype-katex');
  const tree = {type:'root',children:[
    {type:'math', value:'E=mc^2', identifier:'Energy:law', html_id:'energy', enumerator:'1'},
    {type:'link', url:'/tutorial/',children:[{type:'text',value:'Tutorial'}]},
    {type:'image',url:'/figure.svg',alt:'Figure'},
    {type:'link',url:'/en/latest/api/',children:[]},
  ]};
  const output = await unified().use(remarkRehype, mystRehype).use(rehypeKatex)
    .use(rehypeDocumentBase,{base:'/en/latest/'}).run(tree);
  const elements = nodes(output,'element');
  assert.ok(elements.some(node=>node.properties?.id==='energy'));
  assert.ok(elements.some(node=>node.properties?.className?.includes('katex')));
  assert.ok(elements.some(node=>node.properties?.href==='/en/latest/tutorial/'));
  assert.ok(elements.some(node=>node.properties?.src==='/en/latest/figure.svg'));
  assert.ok(elements.some(node=>node.properties?.href==='/en/latest/api/'));
  await assert.rejects(unified().use(remarkRehype,mystRehype).use(rehypeKatex).use(rehypeMathErrors)
    .run({type:'root',children:[{type:'math',value:'\\unsupportedmath'}]}), /Undefined control sequence/);
});
