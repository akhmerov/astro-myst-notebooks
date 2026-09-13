import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autodocParts, assertRenderedDocstrings, autodocOutline } from '../dist/autodoc.mjs';
import { resolveDocument } from '../dist/documents.mjs';
import { VFile } from 'vfile';
import { visit } from 'unist-util-visit';
import { execFileSync } from 'node:child_process';

test('autodoc slots survive MyST containers and preserve surrounding source markup', () => {
  const before='<div class="block"><h2 id="series"><span data-source-location="exact">Series</span></h2>';
  const after='<p>Next paragraph</p></div>';
  const html=before+'<template data-myst-autodoc="pkg.Series" data-heading-level="3" data-summary-only="false"></template>'+after;
  const parts=autodocParts(html,{'old-series':'series'});
  assert.equal(parts[1].name,'pkg.Series');
  assert.equal(parts[1].headingLevel,3);
  assert.equal(parts[2].html,after);
  assert.ok(parts[0].html.includes('<span id="old-series"></span><h2'));
  assert.ok(parts[0].html.includes('data-source-location="exact"'));
  assert.throws(()=>autodocParts(html,{old:'missing'}),/Unknown anchor alias target/);
});

test('lost or unsupported docstring prose fails explicitly', () => {
  const doc={path:'pkg.f',canonicalPath:'pkg.f',docstring:{sections:[{kind:'text',value:'Required prose'}]}};
  assert.throws(()=>assertRenderedDocstrings(doc,{objects:{}}),/Missing rendered docstring/);
  assert.doesNotThrow(()=>assertRenderedDocstrings(doc,{objects:{'pkg.f':{sections:{0:{body:'<p>Required prose</p>'}}}}}));
  doc.docstring.sections[0]={kind:'unknown',value:'New format'};
  assert.throws(()=>assertRenderedDocstrings(doc,{objects:{}}),/Unsupported docstring section/);
});

test('MyST numbers labelled equations and anonymous fragments have no fictitious source map', async () => {
  const source='$$x$$\n\n:::{math}\n:label: energy\ny\n:::\n\nSee {eq}`energy`.\n';
  const tree=await resolveDocument(source,new VFile({value:source}));
  const math=[];visit(tree,'math',node=>math.push(node));
  assert.equal(math[0].enumerator,undefined);
  assert.equal(math[1].enumerator,'1');
  visit(tree,node=>assert.equal(node.data?.origin,undefined));
});

test('Griffe preserves constructors, RST references, math, and ordinary variable names', () => {
  const script=String.raw`
from pathlib import Path
from tempfile import TemporaryDirectory
import griffe
with TemporaryDirectory() as d:
    Path(d, 'example.py').write_text('''class Series:
    """A series."""
    def __init__(self, size: int = 1):
        """Construct it.

        Parameters
        ----------
        size :
            Number of terms.
        """

def product(series):
    """Multiply \x60~example.Series\x60; use \x60H.dimension_names\x60.

    Like :math:\x60x^2\x60.
    """
''')
    extensions=griffe.load_extensions({'dist/griffe_myst.py':{}})
    pkg=griffe.load('example',search_paths=[d],docstring_parser='numpy',extensions=extensions)
    sections=pkg['Series'].docstring.parsed
    assert [s.kind.value for s in sections] == ['text','text','parameters']
    assert sections[-1].value[0].description.strip() == 'Number of terms.'
    prose=pkg['product'].docstring.parsed[0].value
    assert '[\x60Series\x60][example.Series]' in prose, prose
    assert '\x60H.dimension_names\x60' in prose, prose
    assert '$x^2$' in prose, prose
`;
  execFileSync('python',['-c',script],{stdio:'pipe'});
});

test('published inventories resolve from the documentation base, including root documents', async () => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {pathToFileURL}=await import('node:url');
  const {Inventory}=await import('intersphinx');
  const {exportInventory}=await import('../dist/inventory.js');
  const directory=await mkdtemp(tmpdir()+'/myst-inventory-');
  const url=name=>pathToFileURL(directory+'/'+name);
  try {
    const api=new Inventory({project:'example'});
    api.setEntry({type:'py:method',name:'example.Series.pop',location:'/preview/api/example/#example.Series.pop'});
    api.write(directory+'/api.inv');
    await writeFile(url('index.md'),'# Overview\n\n(target)=\n## Details\n');
    await writeFile(url('documents.json'),JSON.stringify([{path:directory+'/index.md',url:'/preview/',name:'index',title:'Overview'}]));
    await exportInventory({api:url('api.inv'),documents:url('documents.json'),root:url(''),destination:url('objects.inv'),base:'/preview/'});
    const result=new Inventory({path:directory+'/objects.inv'});await result.load();
    assert.equal(result.data['py:method']['example.Series.pop'].location,'api/example/#example.Series.pop');
    assert.equal(result.data['std:doc'].index.location,'./');
    assert.equal(result.data['std:label'].target.location,'#target');
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('API outlines follow parsed MyST sections and omit module summaries', () => {
  const source = '## Series and `operators`\n\n:::{autodoc} pkg\n:summary-only: true\n:::\n\n```{autodoc} pkg.Series\n```\n\n## Solvers\n\n:::{autodoc} pkg.solve\n:::\n';
  assert.deepEqual(autodocOutline(source), [
    { section: 'Series and operators', name: 'pkg.Series' },
    { section: 'Solvers', name: 'pkg.solve' },
  ]);
});
