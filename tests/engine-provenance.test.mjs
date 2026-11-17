import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { visit } from 'unist-util-visit';
import { createProvenance, finalizeOrigins, includeSourceSlice } from '../dist/engine/provenance.mjs';
import { notebookToMyst } from '../dist/notebook-source.mjs';
import { parseDocument } from '../scripts/migration-baseline/parse-document.mjs';

const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL('../node_modules/mystmd/dist/myst.cjs', import.meta.url));
const plugin = fileURLToPath(new URL('../dist/engine/provenance.mjs', import.meta.url));
const nodes = (tree, type) => { const found=[]; visit(tree,type,node=>{found.push(node);}); return found; };
async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),'engine-provenance-'));
  try { return await fn(root); } finally { await rm(root,{recursive:true,force:true}); }
}
async function build(root, pages=['index.md']) {
  const template=join(root,'.template');
  await mkdir(template,{recursive:true});
  await writeFile(join(template,'template.yml'),'myst: v1\nkind: site\ntitle: Provenance fixture\nversion: 1.0.0\nlicense: BSD-2-Clause\n');
  await writeFile(join(root,'myst.yml'), `version: 1\nproject:\n  title: Provenance\n  plugins: ${JSON.stringify([plugin])}\n  toc:\n${pages.map(path=>`    - file: ${path}\n`).join('')}site:\n  template: ${JSON.stringify(template)}\n`);
  const result=spawnSync(process.execPath,[cli,'build','--site','--strict','--debug'],{cwd:root,encoding:'utf8',timeout:45000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr+'\n'+(result.error?.message??''));
  const manifest=JSON.parse(await readFile(join(root,'_build/site/config.json'),'utf8'));
  const name=manifest.projects[0].index;
  return JSON.parse(await readFile(join(root,'_build/site/content',name+'.json'),'utf8'));
}
async function assertExact(tree,root) {
  const sources=new Map();
  for(const node of nodes(tree,'text').concat(nodes(tree,'inlineCode'),nodes(tree,'code'))) {
    const origin=node.data?.origin;
    if(!origin) continue;
    if(!sources.has(origin.file)) {
      const raw=await readFile(join(root,origin.file),'utf8');
      sources.set(origin.file,origin.representation==='myst'?notebookToMyst(JSON.parse(raw)):raw);
    }
    const source=sources.get(origin.file);
    if(origin.kind==='exact') assert.equal(source.slice(origin.start,origin.end),node.value,origin.file);
    if(origin.lines) node.value.split('\n').forEach((line,index)=>assert.equal(source.slice(origin.lines[index].start,origin.lines[index].end),line));
  }
}

test('published MyST text keeps exact authored quotes and URL text after project transforms',()=>fixture(async root=>{
  const source=`---\ntitle: Text\n---\n\nThe project's value is "quoted".\n\nVisit https://example.org/path for more.\n`;
  await writeFile(join(root,'index.md'),source);
  const page=await build(root);
  await finalizeOrigins(page.mdast,{root});
  const text=nodes(page.mdast,'text');
  assert.ok(text.some(node=>node.value===`The project's value is "quoted".` && node.data.origin.kind==='exact'));
  assert.ok(text.some(node=>node.value==='https://example.org/path' && node.data.origin.kind==='exact'));
  await assertExact(page.mdast,root);
  const legacy=parseDocument(source,join(root,'index.md'),root).tree;
  const coverage=tree=>nodes(tree,'text').filter(node=>node.data?.origin?.kind==='exact').reduce((n,node)=>n+node.value.length,0);
  assert.ok(coverage(page.mdast)>=coverage(legacy));
}));

test('CSV decoded quotes and Markdown retain narrowed explicitly inexact authored ranges',()=>fixture(async root=>{
  const source='---\ntitle: CSV provenance\n---\n\nUnrelated prose outside the table.\n\n```{csv-table}\n:header: Name,Value\n\n"left, right","a ""quote"""\n"**bold**","amp &amp; value"\n```\n';
  await writeFile(join(root,'index.md'),source);
  const page=await build(root); await finalizeOrigins(page.mdast,{root});
  const table=nodes(page.mdast,'table')[0];
  const values=nodes(table,'text');
  assert.deepEqual(values.map(node=>node.value),['Name','Value','left, right','a "quote"','bold','amp & value']);
  for (const node of values) {
    const origin=node.data.origin;
    if (origin.kind==='exact') {
      assert.equal(source.slice(origin.start,origin.end),node.value);
      continue;
    }
    assert.equal(origin.kind,'range'); assert.equal(origin.transformation,'csv');
    assert.equal(origin.file,'index.md'); assert.equal(origin.start,source.indexOf('```{csv-table}'));
    assert.equal(source.slice(origin.start,origin.end),source.slice(source.indexOf('```{csv-table}')));
    assert.ok(!source.slice(origin.start,origin.end).includes('Unrelated prose'));
  }
  for (const value of ['a "quote"','amp & value']) {
    const origin=values.find(node=>node.value===value).data.origin;
    assert.equal(origin.kind,'range'); assert.equal(origin.transformation,'csv');
  }
  const stable=JSON.stringify(page.mdast);
  await finalizeOrigins(page.mdast,{root}); assert.equal(JSON.stringify(page.mdast),stable);
  values.find(node=>node.value==='a "quote"').value='Invented CSV content';
  await assert.rejects(finalizeOrigins(page.mdast,{root}),/CSV source provenance does not match/);
}));

test('adjacent CSV tables with repeated headers bind to source order and reject a borrowed escaped field',()=>fixture(async root=>{
  const first='```{csv-table}\n:header: Name,Value\n\nitem,"first ""quote"""\n```\n';
  const second='```{csv-table}\n:header: Name,Value\n\nitem,"second ""quote"""\n```\n';
  const source='---\ntitle: Repeated CSV\n---\n\n'+first+'\n'+second;
  await writeFile(join(root,'index.md'),source);
  const page=await build(root);
  const tampered=structuredClone(page.mdast);
  const tables=nodes(page.mdast,'table');
  await finalizeOrigins(page.mdast,{root});
  for (const [index, table] of tables.entries()) {
    for (const node of nodes(table,'text').filter(node=>node.data?.origin?.kind==='range')) {
      const origin=node.data.origin;
      assert.equal(origin.transformation,'csv');
      assert.equal(origin.start,source.indexOf(index?second:first));
      assert.equal(source.slice(origin.start,origin.end),index?second:first);
    }
  }
  nodes(nodes(tampered,'table')[0],'text').find(node=>node.value.includes('first')).value='second "quote"';
  await assert.rejects(finalizeOrigins(tampered,{root}),/Source provenance range does not contain/);
}));

test('contiguous include line filters map selected source and reject noncontiguous ranges',()=>fixture(async root=>{
  await writeFile(join(root,'index.md'),'---\ntitle: Include\n---\n\n```{include} part.md\n:lines: 3-3\n```\n');
  const source='Excluded first line.\n\nSelected third line.\n';
  await writeFile(join(root,'part.md'),source);
  const page=await build(root); await finalizeOrigins(page.mdast,{root});
  const text=nodes(page.mdast,'text').find(node=>node.value==='Selected third line.');
  assert.equal(text.data.origin.file,'part.md'); assert.equal(text.data.origin.position.start.line,3);
  assert.equal(source.slice(text.data.origin.start,text.data.origin.end),text.value);
  assert.throws(()=>includeSourceSlice(source,{lines:[1,3]}),/Noncontiguous/);
  assert.deepEqual(includeSourceSlice(source,{lines:[[3,3]]}),{content:'Selected third line.',offset:22});
}));

test('identical executable cells map independently to their own authored lines',()=>fixture(async root=>{
  await writeFile(join(root,'index.md'),'---\ntitle: Code\n---\n\n```{code-cell} python\nx = 1\n```\n\n```{code-cell} python\nx = 1\n```\n');
  const page=await build(root); await finalizeOrigins(page.mdast,{root});
  const code=nodes(page.mdast,'code').filter(node=>node.executable);
  assert.equal(code.length,2); assert.deepEqual(code.map(node=>node.data.origin.lines[0].position.start.line),[6,10]);
  await assertExact(page.mdast,root);
}));

test('notebook prose and duplicate cells reference the declared deterministic MyST representation',()=>fixture(async root=>{
  const notebook={nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python 3'}},cells:[
    {cell_type:'markdown',metadata:{},source:'# Notebook\n\nFirst **phrase**.'},
    {cell_type:'code',metadata:{},source:'x = 1',outputs:[],execution_count:null,id:'one'},
    {cell_type:'markdown',metadata:{},source:`The notebook's second phrase.`},
    {cell_type:'code',metadata:{},source:'x = 1',outputs:[],execution_count:null,id:'two'},
    {cell_type:'raw',metadata:{},source:'Raw cells are not published.'},
  ]};
  await writeFile(join(root,'notebook.ipynb'),JSON.stringify(notebook));
  const page=await build(root,['notebook.ipynb']); await finalizeOrigins(page.mdast,{root});
  const phrase=nodes(page.mdast,'text').find(node=>node.value==='phrase');
  assert.equal(phrase.data.origin.file,'notebook.ipynb'); assert.equal(phrase.data.origin.representation,'myst'); assert.equal(phrase.data.origin.kind,'exact');
  assert.ok(nodes(page.mdast,'text').some(node=>node.value===`The notebook's second phrase.`));
  assert.ok(!nodes(page.mdast,'code').some(node=>node.value.includes('Raw cells')));
  const codes=nodes(page.mdast,'code').filter(node=>node.executable); assert.equal(codes.length,2); assert.notEqual(codes[0].data.origin.start,codes[1].data.origin.start);
  await assertExact(page.mdast,root);
}));

test('final validation rejects unexplained exact-text changes and changed sources',()=>fixture(async root=>{
  await writeFile(join(root,'index.md'),'A sentence.\n');
  const tree=parseDocument('A sentence.\n',join(root,'index.md'),root).tree;
  nodes(tree,'text')[0].value='Unrelated text';
  await assert.rejects(finalizeOrigins(tree,{root}),/does not match/);
  await writeFile(join(root,'index.md'),'Updated source.\n');
  await assert.rejects(finalizeOrigins(tree,{root}),/Source changed/);
}));

test('included assets and document links resolve relative to their own source file',()=>fixture(async root=>{
  await mkdir(join(root,'parts'));
  await writeFile(join(root,'index.md'),'---\ntitle: Main\n---\n\n```{include} parts/fragment.md\n```\n');
  await writeFile(join(root,'parts/fragment.md'),'![Included image](./icon.svg)\n\n[Target page](../target.md)\n');
  await writeFile(join(root,'parts/icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3"/></svg>');
  await writeFile(join(root,'target.md'),'---\ntitle: Target\n---\n\nTarget body.\n');
  const page=await build(root,['index.md','target.md']); await finalizeOrigins(page.mdast,{root});
  assert.equal(nodes(page.mdast,'image').length,1);
  const target=[...nodes(page.mdast,'crossReference'),...nodes(page.mdast,'link')].find(node=>nodes(node,'text').some(child=>child.value==='Target page'));
  assert.equal(target?.url,'/target');
  assert.equal(nodes(page.mdast,'image')[0].data.origin.file,'parts/fragment.md');
}));


test('range fallback restores repeated quoted text and refuses invented source content',()=>fixture(async root=>{
  const source = 'The "quote" and the "quote".\n';
  await writeFile(join(root,'index.md'), source);
  const tree=parseDocument(source,join(root,'index.md'),root).tree;
  const origin=nodes(tree,'text')[0].data.origin;
  tree.children=[{type:'paragraph',children:[{type:'text',value:'“quote”',data:{origin:{...origin,start:0,end:source.length,kind:'range'}}}]}];
  await finalizeOrigins(tree,{root});
  assert.equal(nodes(tree,'text')[0].value,'"quote"');
  nodes(tree,'text')[0].value='invented';
  await assert.rejects(finalizeOrigins(tree,{root}),/does not contain/);
}));

test('glossary terms with upstream reversed position lines retain real source ranges',()=>fixture(async root=>{
  await writeFile(join(root,'index.md'),'---\ntitle: Glossary\n---\n\n```{glossary}\nKernel\n: The process executing Python.\n\nXeus\n: The browser kernel framework.\n```\n');
  const page=await build(root); await finalizeOrigins(page.mdast,{root});
  for(const term of ['Kernel','Xeus']) {
    const node=nodes(page.mdast,'text').find(node=>node.value===term);
    assert.ok(node.data.origin.start < node.data.origin.end);
  }
  await assertExact(page.mdast,root);
}));

test('notebook canonical origins handle CRLF frontmatter and multiple raw-cell trailing newlines',()=>fixture(async root=>{
  const notebook={nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python 3'}},cells:[
    {cell_type:'markdown',metadata:{},source:'---\r\ntitle: Edge notebook\r\n---\r\n\r\nFirst **phrase**.\r\n'},
    {cell_type:'raw',metadata:{},source:'Raw export-only text.\n\n'},
    {cell_type:'markdown',metadata:{},source:'Second **phrase**.\r\n'},
    {cell_type:'code',metadata:{},source:'x = 1\r\nprint(x)\r\n',outputs:[],execution_count:null,id:'one'},
  ]};
  await writeFile(join(root,'notebook.ipynb'),JSON.stringify(notebook));
  const page=await build(root,['notebook.ipynb']); await finalizeOrigins(page.mdast,{root});
  const phrases=nodes(page.mdast,'text').filter(node=>node.value==='phrase');
  assert.equal(phrases.length,2);assert.ok(phrases.every(node=>node.data?.origin?.kind==='exact'));
  assert.notEqual(phrases[0].data.origin.start,phrases[1].data.origin.start);
  assert.ok(!nodes(page.mdast,'code').some(node=>node.value.includes('Raw export-only')));
  const code=nodes(page.mdast,'code').find(node=>node.executable);
  assert.equal(code.value,'x = 1\nprint(x)');
  assert.equal(code.data.origin.kind,'exact');
  assert.equal(code.data.origin.representation,'myst');
  assert.equal(code.data.origin.lines.length,2);
  await assertExact(page.mdast,root);
}));
