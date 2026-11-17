/** Exercise the real Pymablock documentation in a disposable packed consumer.
 * The original checkout and both selected Pixi environments remain read-only.
 * Every source adaptation and unexecuted page is reported, never hidden.
 */
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, dirname, relative, delimiter } from 'node:path';
import { readFile, writeFile, appendFile, readdir, mkdir, mkdtemp, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { inflateSync, deflateSync } from 'node:zlib';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { Inventory } from 'intersphinx';

const { values } = parseArgs({ options: {
  archive: { type: 'string' }, source: { type: 'string' },port:{type:'string'},
  python: { type: 'string' }, 'api-python': { type: 'string' }, 'browser-python': { type: 'string' },
  report: { type: 'string' }, 'execute-all': { type: 'boolean' }, browser: { type: 'boolean' },
  'declare-dynamic-properties': { type: 'boolean' },
  timeout: { type: 'string', default: '480' }, 'build-timeout': { type: 'string', default: '1200000' },
} });
if (!values.archive) throw new Error('Use --archive PATH to the tested package archive');
if (!values.source) throw new Error('Use --source PATH to the actual Pymablock checkout to validate read-only');
const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const archive = resolve(values.archive), source = resolve(values.source);
const python = resolve(values.python ?? join(source, '.pixi/envs/docs/bin/python'));
const apiPython = resolve(values['api-python'] ?? join(repo, '.pixi/envs/default/bin/python'));
const browserPython = resolve(values['browser-python'] ?? join(repo, '.pixi/envs/default/bin/python'));
const apiModules=['pymablock','pymablock.block_diagonalization','pymablock.series','pymablock.linalg',
  'pymablock.number_ordered_form','pymablock.second_quantization','pymablock.kpm','pymablock.algorithm_parsing',
  'pymablock.number_ordered_form.LadderOp','pymablock.block_diagonalization.solve_sylvester_KPM',
  'pymablock.block_diagonalization.solve_sylvester_diagonal','pymablock.block_diagonalization.solve_sylvester_direct'];
// Reviewed migration data: these actual class-owned descriptors are generated
// by SymPy and present in the existing Pymablock Sphinx inventory. They are not
// inferred by the framework or by importing scientific packages during a build.
const dynamicProperties=['algebraic','complex','composite','even','extended_negative','extended_nonnegative',
  'extended_nonpositive','extended_nonzero','extended_positive','extended_real','imaginary','integer',
  'irrational','negative','noninteger','nonnegative','nonpositive','nonzero','odd','positive','prime',
  'rational','real','transcendental','zero'].map(name=>'pymablock.number_ordered_form.NumberOrderedForm.is_'+name);
const consumer = await mkdtemp(join(tmpdir(), 'pymablock-astro-consumer-'));
const archiveSnapshot=join(consumer,'astro-myst-notebooks.tgz');
const project = join(consumer, 'project'), sourceDocs = join(source, 'docs/source');
const reportPath = resolve(values.report ?? join(consumer, 'report.json'));
const report = { version: 1, source, consumer, archive, python, apiPython,nodeVersion:process.version,nodeExecutable:process.execPath,
  startedAt: new Date().toISOString(), execution: values['execute-all'] ? 'all-source-pages' : 'getting-started-pilot',
  browserRequested: Boolean(values.browser), adaptations: [], sourcePages: [], requestedExecutionPages: [], executedPages: [], skippedExecutionPages: [],
  stages: {}, blockers: [], fullConsumerGatePassed: false };
const env = { ...process.env, PATH:[...new Set([dirname(process.execPath),dirname(browserPython)])].join(delimiter)+delimiter+(process.env.PATH??''),PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' };
const digest = text => createHash('sha256').update(text).digest('hex');
function groupAt(source,start){
  while(/\s/.test(source[start]??'')&&start<source.length)start++;
  assert.equal(source[start],'{','Expected a braced MathJax toggle argument');
  const first=start+1;let depth=1;
  for(let index=first;index<source.length;index++){
    if(source[index]==='\\'){index++;continue;}
    if(source[index]==='{')depth++;else if(source[index]==='}'&&!--depth)return {value:source.slice(first,index),end:index+1};
  }
  throw new Error('Unclosed MathJax toggle argument');
}
function adaptMathToggles(contents,file){
  const migrate=(original,body)=>{
    const at=body.indexOf('\\toggle');if(at<0)return original;
    const collapsed=groupAt(body,at+'\\toggle'.length),expanded=groupAt(body,collapsed.end);
    assert.equal(body.slice(expanded.end).trim(),'\\endtoggle','Unsupported MathJax toggle tail');
    const label=/^:label:[ \t]*(.+)$/m.exec(body.slice(0,at))?.[1]??null;
    let summary=collapsed.value;
    while(summary.includes('\\texttip')){
      const tip=summary.indexOf('\\texttip'),display=groupAt(summary,tip+'\\texttip'.length),tooltip=groupAt(summary,display.end);
      assert.equal(tooltip.value,'click to expand','Unexpected tooltip text needs explicit migration review');
      summary=summary.slice(0,tip)+display.value+summary.slice(tooltip.end);
    }
    const replacement='```{math}\n'+body.slice(0,at)+summary+'\n```\n\n'+
      ':::{admonition} Click to expand derivation\n:class: dropdown note\n\n```{math}\n'+expanded.value+'\n```\n:::';
    report.adaptations.push({file,kind:'MathJax toggle to labeled summary math plus native dropdown derivation',label,
      original,rendered:replacement,collapsedAuthored:collapsed.value,expandedAuthored:expanded.value,
      collapsedMath:summary,expandedMath:expanded.value,scientificFormulasChanged:false});
    return replacement;
  };
  return contents.replace(/^:::\{math\}\n([^]*?)^:::[ \t]*$/gm,migrate)
    .replace(/^\$\$\n([^]*?)^\$\$[ \t]*$/gm,migrate);
}
async function recordNativeExecution(){
  const directory=join(consumer,'node_modules/.astro/notebooks/engine/execution');
  let executionCaches;try{executionCaches=(await files(directory)).filter(path=>path.endsWith('.json'));}catch{return;}
  const computedCells=(await Promise.all(executionCaches.map(async path=>JSON.parse(await readFile(path,'utf8')).response.notebook.cells))).flat();
  const completedSources=new Set(computedCells.map(cell=>cell.metadata?.source_map?.file));
  report.executedPages=report.requestedExecutionPages.filter(name=>completedSources.has('docs/source/'+name));
  let expected=0;for(const name of report.requestedExecutionPages)expected+=(await readFile(join(sourceDocs,name),'utf8')).match(/(?:`{3,}|:{3,})\{code-cell\}/g)?.length??0;
  report.nativeExecution={requestedPages:report.requestedExecutionPages,executedPages:report.executedPages,
    skippedPages:report.skippedExecutionPages,cellCount:expected,completedCells:computedCells.length,
    outputBundles:computedCells.reduce((sum,cell)=>sum+cell.outputs.length,0),freshCache:true,
    executionCountsValid:computedCells.every(cell=>Number.isInteger(cell.execution_count)&&cell.execution_count>0)};
  const codeDifferences=[];
  for(const cell of computedCells){
    const file=cell.metadata?.source_map?.file;
    if(!file?.startsWith('docs/source/')){codeDifferences.push({cell:cell.id,file,reason:'No original scientific source identity'});continue;}
    if(!(await readFile(join(source,file),'utf8')).includes(cell.source))codeDifferences.push({cell:cell.id,file,reason:'Executed cell is not a verbatim slice of original scientific source'});
  }
  report.nativeExecution.originalAuthoredCodePreserved=codeDifferences.length===0;
  report.nativeExecution.codeDifferences=codeDifferences;
}
function authoredWords(tree){
  const words=new Map();
  function walk(node){
    if(['heading','code','outputs','output'].includes(node.type)||node.data?.autodocGenerated||node.data?.sourceGenerated)return;
    if(['text','inlineCode'].includes(node.type)&&node.data?.origin){
      const file=node.data.origin.file;
      if(!words.has(file))words.set(file,new Map());
      const counts=words.get(file);
      for(const token of node.value.match(/[\p{L}\p{N}_]+/gu)??[])counts.set(token,(counts.get(token)??0)+1);
    }
    for(const child of node.children??[])walk(child);
  }
  walk(tree);return words;
}
function renderedProseWords(tree){
  const words=new Map(),excludedClasses=new Set(['katex','math','jupyter-output','jupyter-static-output','jupyter-live-output','cell_input','cell_output','output_area','highlight']);
  function walk(node){
    if(node.tagName&&(/^(?:h[1-6]|pre|script|style|svg|math|mjx-container)$/.test(node.tagName)||(node.properties?.className??[]).some(name=>excludedClasses.has(name))))return;
    if(node.type==='text')for(const token of node.value.match(/[\p{L}\p{N}_]+/gu)??[])words.set(token,(words.get(token)??0)+1);
    for(const child of node.children??[])walk(child);
  }
  walk(tree);return words;
}
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function run(name, command, args, { cwd = consumer, timeout = 120000, extraEnv = {}, input } = {}) {
  const log = join(consumer, name + '.log');
  await writeFile(log,'');
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, detached: process.platform !== 'win32' });
  let output = '', stdout = '', stderr = '', timedOut = false, writes=Promise.resolve();
  const capture = chunk => { writes=writes.then(()=>appendFile(log,chunk));output += chunk; if (output.length > 32 * 1024 * 1024) output = output.slice(-32 * 1024 * 1024); };
  child.stdout.on('data', chunk=>{stdout+=chunk;capture(chunk);}); child.stderr.on('data', chunk=>{stderr+=chunk;capture(chunk);});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, timeout);
  let code;
  try { code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); }); }
  finally { clearTimeout(timer); await writes; }
  report.stages[name] = { passed: code === 0 && !timedOut, exit: code, timedOut, log };
  return { code, output, stdout, stderr, log, passed: code === 0 && !timedOut };
}
function readInventory(buffer,{allowDisplayContinuations=false}={}) {
  let offset = 0; const header = [];
  for (let i = 0; i < 4; i++) { const end = buffer.indexOf(10, offset); assert.ok(end >= 0); header.push(buffer.subarray(offset, end).toString()); offset = end + 1; }
  assert.equal(header[0], '# Sphinx inventory version 2');
  const entries=[],displayContinuations=[];
  for(const line of inflateSync(buffer.subarray(offset)).toString().trim().split('\n').filter(Boolean)){
    const match = /^(.+?)\s+(\S+:\S+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if(!match){
      if(!allowDisplayContinuations||!entries.length)throw new Error('Malformed inventory entry');
      entries.at(-1).display+=' '+line;
      displayContinuations.push({name:entries.at(-1).name,line});continue;
    }
    entries.push({ name: match[1], kind: match[2], priority: match[3], location: match[4].endsWith('$') ? match[4].slice(0,-1) + match[1] : match[4], display: match[5] });
  }
  return { entries, header,displayContinuations };
}
const externalBases = { python: 'https://docs.python.org/3/', numpy: 'https://numpy.org/doc/stable/',
  scipy: 'https://docs.scipy.org/doc/scipy/', sympy: 'https://docs.sympy.org/dev/', kwant: 'https://kwant-project.org/doc/1/' };
let inventoryServer, browser, preview;
try {
  await access(archive); await access(python); await access(apiPython);
  report.sourceCommit = (await run('source-revision', 'git', ['-C', source, 'rev-parse', 'HEAD'])).output.trim();
  report.sourceStatus = (await run('source-status', 'git', ['-C', source, 'status', '--porcelain=v1'])).output;
  report.sourceLockDigest=digest(await readFile(join(source,'pixi.lock')));
  await cp(archive,archiveSnapshot);
  report.archiveDigest=digest(await readFile(archiveSnapshot));
  report.archiveSnapshot=archiveSnapshot;
  report.apiDocstringWarningPolicy='warn';
  report.apiModules=apiModules;
  report.apiScopeBasis='Original Sphinx autodoc module targets plus explicitly selected LadderOp and Sylvester functions outside module __all__.';
  report.apiDocuments={'../second_quantization':'/second_quantization/'};
  const sourceFiles = await files(sourceDocs);
  report.sourcePages = sourceFiles.filter(path => path.endsWith('.md')).map(path => relative(sourceDocs,path)).sort();
  const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [relative(sourceDocs,path), digest(await readFile(path))])));
  report.sourceDigests = hashes;
  const oldInventoryFile = join(source, 'docs/build/html/objects.inv');
  let oldInventory = { entries: [] };
  try { const previous=await readFile(oldInventoryFile);oldInventory = readInventory(previous); report.previousInventory = oldInventoryFile;report.previousInventoryDigest=digest(previous); }
  catch { report.blockers.push('No previous Pymablock Sphinx inventory available for comparison'); }
  const oldApi = oldInventory.entries.filter(entry => entry.name.startsWith('pymablock') && entry.kind.startsWith('py:'));
  report.previousPublicSymbols = oldApi.length;
  const localNames = [...new Set(oldApi.map(entry => entry.name))];
  const roleAliases={'pymablock.BlockSeries':'pymablock.series.BlockSeries'};
  report.referenceMigrationAliases=roleAliases;
  const localTarget = value => {
    if(roleAliases[value])return roleAliases[value];
    if (value.startsWith('pymablock.')) return value;
    const matches = localNames.filter(name => name === value || name.endsWith('.'+value));
    return matches.length === 1 ? matches[0] : value;
  };
  const adaptAutolinks=(contents,file)=>contents.replace(/\{autolink\}`([^`]+)`/g,(_all,target)=>{
    const short=target.startsWith('~'),raw=target.replace(/^~/,''),name=localTarget(raw),title=short?raw.split('.').at(-1):raw;
    report.adaptations.push({file,kind:'Sphinx Python autolink target qualified for static reference resolution',target,name,displayedTitle:title,
      ...(roleAliases[target.replace(/^~/,'')]?{reason:'Explicit historical source-name migration'}:{})});
    return '{autolink}`'+(name===raw?target:title+' <'+name+'>')+'`';
  });
  const adaptIncludedLinks=(contents,file)=>contents.replace(/(?<!!)(\[[^\]]+\]\()([^\s)]+)(\))/g,(all,start,target,end)=>{
    const match=/^([^?#]+)([^]*)$/.exec(target),path=match?.[1].replace(/^\.\//,'');
    if(!report.sourcePages.includes(path))return all;
    const id=path.replace(/\.md$/,'').replace(/^index$/,''),url='/'+id+(id?'/':'')+match[2];
    report.adaptations.push({file,kind:'Included root Markdown document link mapped to its explicit existing Astro route',from:target,to:url});
    return start+url+end;
  });
  const externalInventories = new Map();
  for (const [name, base] of Object.entries(externalBases)) {
    try {
      const parsed = readInventory(await readFile(join(sourceDocs, '_static/intersphinx-fallback', name+'.inv')),{allowDisplayContinuations:true});
      if(parsed.displayContinuations.length)report.adaptations.push({kind:'Offline external inventory display-label continuations normalized',inventory:name,continuations:parsed.displayContinuations});
      const payload = parsed.entries.map(entry => `${entry.name} ${entry.kind} ${entry.priority} ${new URL(entry.location,base)} ${entry.display}`).join('\n') + '\n';
      externalInventories.set('/'+name+'.inv', Buffer.concat([Buffer.from(parsed.header.join('\n')+'\n'), deflateSync(payload)]));
    } catch(error) { throw new Error(`Unable to adapt offline ${name} inventory: ${error.message}`); }
  }
  inventoryServer = createServer((req,res) => {
    const data = externalInventories.get(new URL(req.url,'http://local').pathname);
    if (data) res.writeHead(200,{'Content-Type':'application/octet-stream'}).end(data); else res.writeHead(404).end();
  });
  await new Promise(done => inventoryServer.listen(0,'127.0.0.1',done));
  const inventoryOrigin = 'http://127.0.0.1:'+inventoryServer.address().port;
  const externalReferences = Object.fromEntries(Object.keys(externalBases).map(name => [name, inventoryOrigin+'/'+name+'.inv']));
  await mkdir(project);
  await cp(join(source,'pymablock'),join(project,'pymablock'),{recursive:true,filter:path=>!path.includes('__pycache__')});
  env.PYTHONPATH=project;
  const scientificProbe=await run('scientific-probe',python,['-c',`import json, sys, numpy as np, pymablock; from pathlib import Path; from importlib.metadata import version; from pymablock import block_diagonalize; assert Path(pymablock.__file__).is_relative_to(${JSON.stringify(project)}); h0=np.diag([-1.,1.]); h1=np.array([[0.,1.],[1.,0.]]); effective,*_=block_diagonalize([h0,h1],subspace_indices=[0,1]); value=float(np.real(effective[0,0,2][0,0])); assert np.isclose(value,-0.5); print(json.dumps({'source':pymablock.__file__,'pymablockVersion':pymablock.__version__,'pythonVersion':sys.version,'packages':{name:version(name) for name in ['numpy','scipy','sympy','nbclient','nbformat','kwant','matplotlib']},'second_order':value}))`],{cwd:project,timeout:30000});
  if(!scientificProbe.passed)throw new Error('Bounded Pymablock scientific probe failed: '+scientificProbe.log);
  report.scientificProbe=JSON.parse(scientificProbe.output.trim().split('\n').at(-1));
  const currentApiProof=await run('current-api-compatibility-proof',python,['-c',[
    'import importlib, inspect, json, sys',
    'result=[]',
    'for entry in json.load(sys.stdin):',
    '    parts=entry["name"].split("."); found=None; error=None',
    '    for end in range(len(parts),0,-1):',
    '        try: found=importlib.import_module(".".join(parts[:end])); break',
    '        except ModuleNotFoundError: pass',
    '    try:',
    '        for name in parts[end:]: found=inspect.getattr_static(found,name)',
    '        owner=None',
    '        if entry["kind"] in ("py:property","py:method","py:attribute"):',
    '            parent=importlib.import_module(".".join(parts[:end]))',
    '            for name in parts[end:-1]: parent=getattr(parent,name)',
    '            if inspect.isclass(parent): owner=next((base.__module__+"."+base.__qualname__ for base in parent.__mro__ if parts[-1] in vars(base)),None)',
    '        result.append({**entry,"present":True,"descriptorType":type(found).__name__,"owner":owner})',
    '    except (AttributeError,TypeError) as exc: result.append({**entry,"present":False,"error":str(exc)})',
    'print(json.dumps(result))',
  ].join('\n')],{cwd:project,timeout:30000,input:JSON.stringify(oldApi.map(({name,kind})=>({name,kind})))});
  if(!currentApiProof.passed)throw new Error('Current source API compatibility proof failed: '+currentApiProof.log);
  report.currentApiCompatibilityProof={validationOnly:true,buildTimeScientificImports:false,
    scope:'Independent runtime descriptor existence in disposable source copy; no generated API prose is inferred from these objects.',
    objects:JSON.parse(currentApiProof.stdout)};
  report.dynamicPropertyDeclarations={enabled:Boolean(values['declare-dynamic-properties']),
    names:values['declare-dynamic-properties']?dynamicProperties:[],frameworkIntrospection:false,
    source:'Explicit consumer migration declarations reviewed against the existing inventory, rendered Sphinx HTML, and current-source runtime descriptor proof.',
    referenceSupport:'Typed exported inventory entries and ordinary MyST heading targets. The framework Python role resolver still resolves its statically extracted model; this plugin does not add dynamic names to that model.',
    presentationDifference:'Preserve property names, typed inventory entries and working anchors; replace 25 identical built-in bool class boilerplate descriptions with an explicit dynamic-property declaration.'};
  if(values['declare-dynamic-properties']){
    const descriptorContract=await run('dynamic-property-contract',python,['-c',
      'import json; from pymablock.number_ordered_form import NumberOrderedForm; print(json.dumps(sorted("pymablock.number_ordered_form.NumberOrderedForm."+name for name,value in vars(NumberOrderedForm).items() if name.startswith("is_") and isinstance(value,property))))'],{cwd:project,timeout:30000});
    if(!descriptorContract.passed)throw new Error('Dynamic property descriptor contract probe failed: '+descriptorContract.log);
    const currentDescriptors=JSON.parse(descriptorContract.stdout);
    report.dynamicPropertyDeclarations.runtimeMatchingDescriptors=currentDescriptors;
    report.dynamicPropertyDeclarations.runtimeMatchPolicy='Exact equality with current class-owned property descriptors whose names begin is_; inherited or non-property attributes are outside this explicit declaration contract.';
    assert.deepEqual(currentDescriptors,[...dynamicProperties].sort(),'Consumer dynamic property declarations must exactly match the current runtime descriptor contract');
    const proof=new Map(report.currentApiCompatibilityProof.objects.map(object=>[object.name,object]));
    for(const name of dynamicProperties){
      assert.ok(oldApi.some(object=>object.name===name&&object.kind==='py:property'),'Declared property missing from previous inventory: '+name);
      assert.equal(proof.get(name)?.present,true,'Declared property missing from current source: '+name);
      assert.equal(proof.get(name)?.descriptorType,'property','Declared object is not a property: '+name);
    }
    const plugin=join(project,'pymablock-dynamic-properties.mjs');
    await writeFile(plugin,`// Consumer-owned, reviewed migration declarations. No runtime Python imports.\nconst names=${JSON.stringify(dynamicProperties)};\nexport default {name:'Pymablock dynamic property declarations',transforms:[{name:'pymablock-dynamic-properties',stage:'document',plugin:()=> (tree,file)=>{\nif(!String(file.path).replaceAll('\\\\','/').endsWith('/docs/source/documentation/pymablock.md'))return;\nconst text=value=>({type:'text',value});\nconst children=[{type:'heading',depth:2,identifier:'pymablock-dynamic-properties',html_id:'pymablock-dynamic-properties',children:[text('Dynamic assumption properties')]},{type:'paragraph',children:[text('SymPy generates these properties on NumberOrderedForm when the class is created.')]}];\nfor(const name of names)children.push({type:'heading',depth:3,identifier:name,label:name,html_id:'py-'+Buffer.from(name).toString('hex'),children:[{type:'inlineCode',value:name}],data:{pythonObject:{version:1,name,canonical:name,kind:'property',aliases:[name]}}});\ntree.children.push({type:'block',children});\n}}]};\n`);
    report.dynamicPropertyDeclarations.plugin=plugin;
    report.adaptations.push({kind:'Consumer-owned explicit dynamic Python property declarations',names:dynamicProperties,
      replacedContent:'25 repetitions of the built-in bool class description; no property-specific scientific prose was present.'});
  }
  await cp(join(source,'docs/source'),join(project,'docs/source'),{recursive:true});
  for (const name of ['CONTRIBUTING.md','CHANGELOG.md','AUTHORS.md','README.md']) {
    await cp(join(source,name),join(project,name));
    const path=join(project,name),contents=await readFile(path,'utf8');
    let adapted=adaptIncludedLinks(adaptAutolinks(contents,name),name);
    if(name==='CONTRIBUTING.md')for(const mention of ['isidora.araya','anton-akhmerov']){
      if(adapted.includes('@'+mention)){adapted=adapted.replaceAll('@'+mention,'\\@'+mention);report.adaptations.push({file:name,kind:'Literal original Sphinx username mention escaped from MyST citation syntax',mention:'@'+mention,originalHadLink:false});}
    }
    await writeFile(path,adapted);
  }
  const sections = [], referencedPages = new Set(['index.md']);
  const sourceHeadings = new Map(await Promise.all(report.sourcePages.map(async name => [name, /^# (.+)$/m.exec(await readFile(join(sourceDocs,name),'utf8'))?.[1] ?? name.replace(/\.md$/,'')])));
  for (const name of report.sourcePages) {
    const path = join(project,'docs/source',name); let contents = await readFile(path,'utf8');
    contents = contents.replace(/```\{toctree\}[^]*?\n```/g, match => {
      const caption = /^:caption:\s*(.*)$/m.exec(match)?.[1] ?? 'Documentation';
      const items = match.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith(':')&&!line.startsWith('```')).map(line=>{
        const titled=/^(.*?)\s*<([^>]+)>$/.exec(line);
        const file=titled?titled[2]:line;
        if(!report.sourcePages.includes(file))throw new Error(`Unsupported toctree target ${file}`);
        referencedPages.add(file);return {file,label:titled?titled[1]:sourceHeadings.get(file)};
      });
      sections.push({label:caption,items});
      report.adaptations.push({ file:name, kind:'Sphinx toctree to Astro sidebar/MyST project toc', source:match }); return '';
    });
    contents = contents.replace(/```\{eval-rst\}\s*\n([^]*?)\n```/g, (all, rst) => {
      const directives = [...rst.matchAll(/^\.\. (automodule|autoclass|autofunction|autodata)::\s*(\S+)/gm)];
      if (!directives.length) throw new Error(`Unsupported eval-rst block in ${name}`);
      const leftover = rst.replace(/^\.\. (automodule|autoclass|autofunction|autodata)::[^\n]*/gm,'').replace(/^\s*:(members|show-inheritance|class-doc-from):[^\n]*/gm,'').trim();
      if (leftover) throw new Error(`Unsupported Sphinx autodoc content in ${name}: ${leftover}`);
      const declarations=directives.map((match,index)=>{
        const body=rst.slice(match.index, directives[index+1]?.index??rst.length);
        const selected=/^[ \t]*:members:[ \t]*([^\n]*)/m.exec(body)?.[1]?.trim();
        const options=Object.fromEntries([...body.matchAll(/^[ \t]*:(members|show-inheritance|class-doc-from):[ \t]*([^\n]*)/gm)].map(option=>[option[1],option[2].trim()||true]));
        return {kind:match[1],target:match[2],members:selected?selected.split(',').map(value=>value.trim()).filter(Boolean):[],options};
      });
      report.adaptations.push({file:name,kind:'Sphinx autodoc moved to generated static Griffe API pages',source:all,directives:declarations,
        presentationDifferences:['API objects move to their own generated pages; overview preserves selected member links.',
          'Sphinx show-inheritance and class-doc-from presentation options are recorded for review; generic generated API layout replaces Sphinx formatting.']});
      return declarations.map(({target,members})=>`- {autolink}\`${target}\``+members.map(member=>`\n  - {autolink}\`${target}.${member}\``).join('')).join('\n');
    });
    contents=adaptAutolinks(contents,relative(project,path));
    contents=contents.replace(/^([:`]{3,})\{Note\}/gm,(_all,fence)=>{
      report.adaptations.push({file:name,kind:'Sphinx case-insensitive admonition name normalized for MyST',from:'Note',to:'note'});
      return fence+'{note}';
    });
    contents=adaptMathToggles(contents,name);
    const executable = /(?:`{3,}|:{3,})\{code-cell\}/.test(contents);
    if (executable && (values['execute-all'] || name === 'tutorial/getting_started.md')) report.requestedExecutionPages.push(name);
    else if (executable) {
      report.skippedExecutionPages.push(name);
      contents = contents.startsWith('---\n') ? contents.replace('---\n','---\nskip_execution: true\n') : '---\nskip_execution: true\n---\n\n'+contents;
    }
    await writeFile(path,contents);
  }
  const additional = report.sourcePages.filter(name=>!referencedPages.has(name));
  if(additional.length)sections.push({label:'Additional source pages',items:additional.map(file=>({file,label:sourceHeadings.get(file)}))});
  const sidebar=[{label:'Pymablock',slug:''},...sections.map(section=>({label:section.label,items:section.items.map(item=>({label:item.label,slug:item.file.replace(/\.md$/,'')}))})),{label:'Python API',items:[{autogenerate:{directory:'api'}}]}];
  const toc=[{file:'project/docs/source/index.md'},...sections.map(section=>({title:section.label,children:section.items.map(item=>({file:'project/docs/source/'+item.file}))}))];
  await writeFile(join(consumer,'myst.yml'),JSON.stringify({version:1,project:{title:'Pymablock',toc,
    ...(values['declare-dynamic-properties']?{plugins:['project/pymablock-dynamic-properties.mjs']}:{})}},null,2));
  report.navigation={sections,additionalPages:additional};
  await mkdir(join(consumer,'src'));
  await mkdir(join(consumer,'public'));
  await cp(join(sourceDocs,'favicon.png'),join(consumer,'public/favicon.png'));
  const originalFavicon=digest(await readFile(join(sourceDocs,'favicon.png'))),copiedFavicon=digest(await readFile(join(consumer,'public/favicon.png')));
  assert.equal(copiedFavicon,originalFavicon,'Consumer favicon must preserve original Pymablock branding bytes');
  report.branding={favicon:{source:'docs/source/favicon.png',destination:'public/favicon.png',sha256:copiedFavicon,byteIdentical:true}};
  report.adaptations.push({kind:'Original Sphinx favicon ported to Astro public assets and configured explicitly',...report.branding.favicon});
  await writeFile(join(consumer,'package.json'),JSON.stringify({name:'pymablock-packed-migration-consumer',type:'module',private:true,
    dependencies:{'astro-myst-notebooks':'file:'+archiveSnapshot,astro:'7.3.2','@astrojs/starlight':'0.42.0'}},null,2));
  const installed = await run('install','npm',['install','--ignore-scripts','--no-audit','--no-fund'],{timeout:180000});
  if (!installed.passed) throw new Error('Packed consumer install failed: '+installed.log);
  await writeFile(join(consumer,'src/content.config.ts'),`import {notebookCollections} from 'astro-myst-notebooks/starlight/content';\nexport const collections=notebookCollections();\n`);
  await writeFile(join(consumer,'astro.config.mjs'),`import {defineConfig} from 'astro/config';\nimport starlight from '@astrojs/starlight';\nimport notebooks from 'astro-myst-notebooks/starlight';\nexport default defineConfig({base:'/manual/',integrations:[starlight({title:'Pymablock packed migration',favicon:'/favicon.png',sidebar:${JSON.stringify(sidebar)},plugins:[notebooks({myst:{source:new URL('./project/docs/source/',import.meta.url),buildTimeout:${Number(values['build-timeout'])}},execution:{python:${JSON.stringify(python)},cwd:new URL('./project/',import.meta.url),timeout:${Number(values.timeout)},concurrency:1},api:{modules:${JSON.stringify(apiModules)},searchPaths:[new URL('./project/',import.meta.url)],python:${JSON.stringify(apiPython)},parser:'numpy',markup:'rst',docstringWarnings:'warn',documents:${JSON.stringify({'../second_quantization':'/second_quantization/'})},externalReferences:${JSON.stringify(externalReferences)}},interactive:false})]})]});\n`);
  const apiDiagnostics = await run('api-diagnostics',apiPython,[join(consumer,'node_modules/astro-myst-notebooks/dist/engine/autodoc/extract.py')],{
    input:JSON.stringify({modules:apiModules,searchPaths:[project],parser:'numpy',markup:'rst',docstringWarnings:'warn',documents:report.apiDocuments}),timeout:60000,
  });
  if(!apiDiagnostics.passed)throw new Error('Packed Pymablock API extraction failed: '+apiDiagnostics.log);
  const apiModel=JSON.parse(apiDiagnostics.stdout);
  report.apiDiagnostics=apiModel.diagnostics??[];
  report.extractedPublicObjects=Object.keys(apiModel.objects).length;
  const astroPackage = JSON.parse(await readFile(join(consumer,'node_modules/astro/package.json'),'utf8'));
  const astroCli = join(consumer,'node_modules/astro',typeof astroPackage.bin === 'string' ? astroPackage.bin : astroPackage.bin.astro);
  const build = await run('build',process.execPath,[astroCli,'build'],{timeout:Number(values['build-timeout'])+30000});
  if (!build.passed) throw new Error('Actual Pymablock documentation build failed: '+build.log);
  report.mystDiagnostics={unknownConstructs:build.output.split('\n').filter(line=>/unknown (?:directive|role):/i.test(line))};
  if(report.mystDiagnostics.unknownConstructs.length)throw new Error('MyST reported unsupported source constructs: '+report.mystDiagnostics.unknownConstructs.join('; '));
  const parityReport=join(consumer,'provenance-parity.json');
  const parity=await run('provenance-parity',process.execPath,[join(repo,'scripts/check-provenance-parity.mjs'),
    '--project',consumer,'--source-root',project,'--baseline-prefix','docs/source/',
    '--output',parityReport,'--require-no-regression'],{timeout:120000});
  report.provenance={report:parityReport,validationOnlyHostScript:true,
    baselineScope:'All original Pymablock docs/source pages after the recorded source adapters; generated API pages excluded from authored baseline, all published origins validated.'};
  try{report.provenance.totals=JSON.parse(await readFile(parityReport,'utf8')).totals;}catch{}
  if(!parity.passed)report.blockers.push('Published Pymablock provenance failed validation or regressed against the adapted-source legacy baseline');
  const output = join(consumer,'dist');
  const htmlFiles = (await files(output)).filter(path=>path.endsWith('.html'));
  const byRoute = new Map(); const anchors = new Map(); const parsedPages = [];
  for (const file of htmlFiles) {
    const html=await readFile(file,'utf8'); const nodes=[];visit(fromHtml(html),'element',n=>{nodes.push(n);});
    const route='/manual/'+relative(output,file).replace(/index\.html$/,'');
    byRoute.set(route,file); anchors.set(route,new Set(nodes.map(n=>n.properties.id).filter(Boolean)));
    parsedPages.push({file,route,nodes});
  }
  const mathPairs=report.adaptations.filter(adaptation=>adaptation.kind==='MathJax toggle to labeled summary math plus native dropdown derivation');
  const contentFiles=(await files(join(consumer,'_build/site/content'))).filter(path=>path.endsWith('.json'));
  let algorithmTree;const resolvedPages=[];
  for(const path of contentFiles){const page=JSON.parse(await readFile(path,'utf8'));resolvedPages.push({data:'/content/'+relative(join(consumer,'_build/site/content'),path),page});if(page.location.endsWith('/algorithms.md'))algorithmTree=page.mdast;}
  assert.ok(algorithmTree,'Actual MyST algorithms page is missing');
  const renderedMath=[];visit(algorithmTree,'math',node=>{renderedMath.push(node);});
  const nodeText=node=>typeof node.value==='string'?node.value:(node.children??[]).map(nodeText).join('');
  const algorithmHtml=parsedPages.find(page=>page.route==='/manual/algorithms/');
  const derivationDisclosures=algorithmHtml?.nodes.filter(node=>node.tagName==='details'&&node.children?.some(child=>child.tagName==='summary'&&nodeText(child).includes('Click to expand derivation')))??[];
  report.mathToggleMigration={expectedPairs:5,migratedPairs:mathPairs.length,collapsibleDerivationCount:derivationDisclosures.length,
    authoredExpandedFormulasPreserved:mathPairs.every(pair=>renderedMath.some(node=>node.value.trim()===pair.expandedMath.trim())),
    authoredCollapsedFormulasPreserved:mathPairs.every(pair=>renderedMath.some(node=>node.value.trim()===pair.collapsedMath.trim())),
    originalLabelsPreserved:mathPairs.filter(pair=>pair.label).every(pair=>renderedMath.some(node=>node.label===pair.label||node.identifier===pair.label.toLowerCase())),
    originalLabeledEquations:mathPairs.map(pair=>pair.label).filter(Boolean),originalUnlabeledEquations:mathPairs.filter(pair=>!pair.label).length};
  report.mathToggleMigration.passed=mathPairs.length===5&&derivationDisclosures.length===5&&report.mathToggleMigration.authoredExpandedFormulasPreserved&&report.mathToggleMigration.authoredCollapsedFormulasPreserved&&report.mathToggleMigration.originalLabelsPreserved;
  const brokenLinks=[];
  for(const {route,nodes} of parsedPages)for(const node of nodes){
    const link=node.tagName==='a'&&node.properties.href;
    if(typeof link!=='string')continue;
    const url=new URL(link,'https://consumer.example'+route);
    if(url.origin!=='https://consumer.example')continue;
    if(!url.pathname.startsWith('/manual/')){brokenLinks.push({route,link,reason:'lost deployment prefix'});continue;}
    if(!byRoute.has(url.pathname)){
      try{await access(join(output,url.pathname.slice('/manual/'.length)));}catch{brokenLinks.push({route,link,reason:'missing page or asset'});}
    }else if(url.hash&&!anchors.get(url.pathname).has(decodeURIComponent(url.hash.slice(1))))brokenLinks.push({route,link,reason:'missing anchor'});
  }
  const brokenAssets=[];let localResources=0,externalResources=0,imageResources=0;
  for(const {route,nodes} of parsedPages)for(const node of nodes){
    const resources=[];
    if(typeof node.properties.src==='string')resources.push(['src',node.properties.src]);
    if(node.tagName==='link'&&typeof node.properties.href==='string')resources.push(['href',node.properties.href]);
    if(typeof node.properties.srcSet==='string'&&!node.properties.srcSet.startsWith('data:'))for(const candidate of node.properties.srcSet.split(','))resources.push(['srcset',candidate.trim().split(/\s+/)[0]]);
    for(const [attribute,value] of resources){
      if(/^(?:data:|blob:)/.test(value))continue;
      const url=new URL(value,'https://consumer.example'+route);
      if(url.origin!=='https://consumer.example'){externalResources++;continue;}
      localResources++;if(node.tagName==='img')imageResources++;
      if(!url.pathname.startsWith('/manual/')){brokenAssets.push({route,tag:node.tagName,attribute,value,reason:'lost deployment prefix'});continue;}
      try{await access(join(output,decodeURIComponent(url.pathname.slice('/manual/'.length))));}catch{brokenAssets.push({route,tag:node.tagName,attribute,value,reason:'missing local resource'});}
    }
  }
  report.resources={checkedLocal:localResources,localImageReferences:imageResources,externalUnverified:externalResources,broken:brokenAssets,
    scope:'All HTML src, srcset and link href resources; data/blob URLs are self-contained, external resources are recorded without asserting remote availability.'};
  const inventory = new Inventory({path:join(output,'objects.inv')});await inventory.load();
  const actualSymbols = new Map(Object.entries(inventory.data).flatMap(([kind,items])=>Object.entries(items).map(([name,e])=>[kind+' '+name,e])));
  const missingSymbols=[],invalidInventoryTargets=[],changedLocations=[];
  for(const old of oldApi){
    const current=actualSymbols.get(old.kind+' '+old.name);
    if(!current){missingSymbols.push(old);continue;}
    if(current.location!==old.location)changedLocations.push({name:old.name,old:old.location,new:current.location});
    const url=new URL(current.location,'https://consumer.example/manual/');
    if(!byRoute.has(url.pathname)||url.hash&&!anchors.get(url.pathname)?.has(decodeURIComponent(url.hash.slice(1))))invalidInventoryTargets.push({name:old.name,location:current.location});
  }
  const invalidGenericTargets=[];let genericChecked=0;
  for(const kind of ['std:doc','std:label'])for(const [name,entry] of Object.entries(inventory.data[kind]??{})){
    genericChecked++;const url=new URL(entry.location,'https://consumer.example/manual/');
    if(!byRoute.has(url.pathname)||url.hash&&!anchors.get(url.pathname)?.has(decodeURIComponent(url.hash.slice(1))))invalidGenericTargets.push({kind,name,location:entry.location});
  }
  const xrefs=JSON.parse(await readFile(join(consumer,'_build/site/myst.xref.json'),'utf8'));
  const invalidHeadings=[];let headingsChecked=0;
  for(const ref of xrefs.references.filter(ref=>ref.kind==='heading')){
    const page=resolvedPages.find(page=>page.data===ref.data)?.page;if(!page){invalidHeadings.push({identifier:ref.identifier,reason:'missing resolved page JSON'});continue;}
    let heading;visit(page.mdast,'heading',node=>{if(node.identifier===ref.identifier)heading=node;});
    const url=new URL(ref.url,'https://consumer.example/manual/');headingsChecked++;
    if(!heading?.html_id||!anchors.get(url.pathname)?.has(heading.html_id))invalidHeadings.push({identifier:ref.identifier,url:ref.url,htmlId:heading?.html_id});
  }
  report.pages={sourceCount:report.sourcePages.length,builtCount:htmlFiles.length,sourceRoutesPresent:report.sourcePages.every(name=>byRoute.has('/manual/'+name.replace(/\.md$/,'').replace(/^index$/,'')+(name==='index.md'?'':'/')))};
  report.links={checked:true,broken:brokenLinks};
  report.inventory={previousPublicCount:oldApi.length,currentPublicCount:[...actualSymbols.keys()].filter(key=>key.startsWith('py:')).length,totalInventoryEntries:actualSymbols.size,missingSymbols,invalidTargets:invalidInventoryTargets,changedLocations,
    generic:{checked:genericChecked,invalidTargets:invalidGenericTargets},headings:{checked:headingsChecked,invalidTargets:invalidHeadings}};
  const {parseDocument:parseBaseline}=await import(pathToFileURL(join(repo,'scripts/migration-baseline/parse-document.mjs')).href);
  const proseFiles=[...report.sourcePages.map(file=>'docs/source/'+file),'CONTRIBUTING.md','CHANGELOG.md','AUTHORS.md'];
  const proseComparisons=[];
  for(const file of proseFiles){
    const path=join(project,file),tree=parseBaseline(await readFile(path,'utf8'),path,project).tree;
    const sourcePage=file.startsWith('docs/source/')?file.slice('docs/source/'.length):({'CONTRIBUTING.md':'developer.md','CHANGELOG.md':'CHANGELOG.md','AUTHORS.md':'authors.md'})[file];
    const route='/manual/'+sourcePage.replace(/\.md$/,'').replace(/^index$/,'')+(sourcePage==='index.md'?'':'/');
    const body=parsedPages.find(page=>page.route===route)?.nodes.find(node=>(node.properties.className??[]).includes('sl-markdown-content'));
    assert.ok(body,'Missing rendered Markdown body for '+file);
    const expected=authoredWords(tree).get(file)??new Map(),actual=renderedProseWords(body);
    const missing=[...expected].filter(([token,count])=>(actual.get(token)??0)<count).map(([token,count])=>({token,expected:count,actual:actual.get(token)??0}));
    const oldHtml=join(source,'docs/build/html',sourcePage.replace(/\.md$/,'.html'));
    let previousSphinx;
    try{
      const oldTree=fromHtml(await readFile(oldHtml,'utf8'));let article;visit(oldTree,'element',node=>{if(node.tagName==='article'&&(node.properties.className??[]).includes('bd-article'))article=node;});
      if(article){
        const oldWords=renderedProseWords(article),missingOld=[...expected].filter(([token,count])=>(oldWords.get(token)??0)<count).map(([token,count])=>({token,expected:count,actual:oldWords.get(token)??0}));
        let snapshotMatchesOriginal=null;
        try{const snapshot=await readFile(join(source,'docs/build/html/_sources',sourcePage+'.txt'));snapshotMatchesOriginal=file.startsWith('docs/source/')?digest(snapshot)===report.sourceDigests[sourcePage]:null;}catch{}
        previousSphinx={html:oldHtml,sourceSnapshotMatchesOriginal:snapshotMatchesOriginal,sourceWordsMissingFromOldHtml:missingOld,
          limitation:'Rendered paragraph/inline-code sample only; source adapters add documented controls/API overview text, generated API descriptions moved to new pages, old notebook outputs/math/headings are excluded. A null snapshot match means no independent archived source identity for this included root document.'};
      }
    }catch{}
    proseComparisons.push({file,route,expectedWords:[...expected.values()].reduce((sum,count)=>sum+count,0),missing,previousSphinx});
  }
  report.sourceContentComparison={validationOnlyHostParser:true,scope:'Unordered Unicode word-count containment from authored lexical paragraph/list/caption text and inline code in all16 adapted source pages and3 included root documents into actual rendered Markdown HTML. Headings/navigation, punctuation, layout/order, math, fenced code and notebook outputs are excluded; heading targets, five formula pairs, verbatim scientific cells and execution outputs are checked separately. Extra generated HTML may add words, so this detects losses rather than proving semantic equivalence. Existing Sphinx HTML and archived-source identity are reported separately; current copied source remains the acceptance baseline. Source adaptations are recorded verbatim where material.',
    pages:proseComparisons,passed:proseComparisons.every(page=>page.missing.length===0)};
  await recordNativeExecution();
  report.archiveBoundary={installedPackage:join(consumer,'node_modules/astro-myst-notebooks'),checkoutImports:false};
  const packageText=await readFile(join(consumer,'astro.config.mjs'),'utf8');
  // Tool interpreters may come from the selected existing Pixi environment;
  // integration/plugin imports must resolve solely through the packed install.
  const importSpecifiers=[...packageText.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match=>match[1]);
  assert.deepEqual(importSpecifiers,['astro/config','@astrojs/starlight','astro-myst-notebooks/starlight']);
  report.archiveBoundary.importSpecifiers=importSpecifiers;
  report.archiveBoundary.packageVersion=JSON.parse(await readFile(join(consumer,'node_modules/astro-myst-notebooks/package.json'),'utf8')).version;
  report.stages.validation={passed:parity.passed&&report.mathToggleMigration.passed&&brokenLinks.length===0&&brokenAssets.length===0&&missingSymbols.length===0&&invalidInventoryTargets.length===0&&invalidGenericTargets.length===0&&invalidHeadings.length===0&&report.sourceContentComparison.passed&&report.pages.sourceRoutesPresent&&report.nativeExecution.completedCells===report.nativeExecution.cellCount&&report.nativeExecution.executionCountsValid&&report.nativeExecution.originalAuthoredCodePreserved};
  if (values.browser) {
    const acceptance = join(project,'docs/source/acceptance'); await mkdir(acceptance);
    const scientificCell = [
      'import numpy as np', 'import pymablock', 'from pymablock import block_diagonalize',
      'h0 = np.diag([-1.0, 1.0])', 'h1 = np.array([[0.0, 1.0], [1.0, 0.0]])',
      'effective, *_ = block_diagonalize([h0, h1], subspace_indices=[0, 1])',
      'coefficient = float(np.real(effective[0, 0, 2][0, 0]))',
      'assert np.isclose(coefficient, -0.5)', 'print(f"Pymablock second-order {coefficient:.1f}")',
    ].join('\n');
    await writeFile(join(acceptance,'browser.md'),'# Scientific browser acceptance\n\n```{code-cell} python\n'+scientificCell+'\n```\n');
    const browserConfig=JSON.parse(await readFile(join(consumer,'myst.yml'),'utf8'));
    browserConfig.project.toc.push({file:'project/docs/source/acceptance/browser.md'});
    await writeFile(join(consumer,'myst.yml'),JSON.stringify(browserConfig,null,2));
    await writeFile(join(consumer,'environment.yml'),['name: pymablock-browser','channels:',
      '  - https://repo.prefix.dev/emscripten-forge-4x','  - https://repo.prefix.dev/conda-forge','dependencies:',
      '  - xeus-python','  - python','  - ipython','  - xeus-python-shell','  - numpy >=2.0','  - scipy >=1.13','  - sympy >=1.13','  - packaging >=22',''].join('\n'));
    const oldConfig = await readFile(join(consumer,'astro.config.mjs'),'utf8');
    const browserSettings = `interactive:{python:${JSON.stringify(browserPython)},command:[${JSON.stringify(browserPython)},'-m','jupyter','lite'],environment:new URL('./environment.yml',import.meta.url),mounts:[{source:new URL('./project/pymablock/',import.meta.url),target:'/pymablock'}],setup:"import sys; sys.path.insert(0, '/')",startupTimeout:180000}`;
    await writeFile(join(consumer,'astro.config.mjs'),oldConfig.replace('interactive:false',browserSettings));
    const builtBrowser = await run('browser-build',process.execPath,[astroCli,'build'],{timeout:Number(values['build-timeout'])+30000});
    if (!builtBrowser.passed) throw new Error('Scientific browser environment build failed: '+builtBrowser.log);
    let port=Number(values.port);
    if(values.port)assert.ok(Number.isInteger(port)&&port>0&&port<=65535,'--port must be a valid TCP port');
    else{
      const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done));
      port=listener.address().port;await new Promise(done=>listener.close(done));
      assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
    }
    const consumerRequire = createRequire(join(consumer,'package.json'));
    const {preview:openPreview}=await import(pathToFileURL(consumerRequire.resolve('astro')).href);
    const {chromium}=await import('@playwright/test');
    preview=await openPreview({root:consumer,base:'/manual/',server:{host:'127.0.0.1',port}});
    browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    const page=await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/manual/acceptance/browser/`);
    const controls=page.locator('[data-thebe-controls]');
    await controls.getByRole('button',{name:'Enable interactivity',exact:true}).click();
    await page.locator('[data-thebe-controls][data-state="ready"]').waitFor({timeout:180000});
    await controls.getByRole('button',{name:'Run all',exact:true}).click();
    await controls.getByRole('status').filter({hasText:'All cells completed.'}).waitFor({timeout:60000});
    const output=await page.locator('.jupyter-live-output').textContent();
    assert.match(output,/Pymablock second-order -0\.5/);
    await page.locator('.CodeMirror').first().evaluate(element=>element.CodeMirror.setValue('while True: pass'));
    await controls.getByRole('button',{name:'Run all',exact:true}).click();
    await page.locator('[data-thebe-controls][data-state="running"]').waitFor();
    await controls.getByRole('button',{name:'Restart Python',exact:true}).click();
    await page.locator('[data-thebe-controls][data-state="ready"]').waitFor({timeout:60000});
    await page.locator('.CodeMirror').first().evaluate((element,code)=>element.CodeMirror.setValue(code),scientificCell);
    await controls.getByRole('button',{name:'Run all',exact:true}).click();
    await page.locator('.jupyter-live-output').filter({hasText:'Pymablock second-order -0.5'}).waitFor({timeout:60000});
    report.browser={passed:false,scientificPassed:true,scientificOutput:output,packageSource:'mounted byte copy of the Pymablock checkout',
      dependencies:['numpy>=2.0','scipy>=1.13','sympy>=1.13','packaging>=22'],infiniteLoopReset:true,port};
    await page.goto(`http://127.0.0.1:${port}/manual/algorithms/`);
    const derivations=page.locator('details > summary').filter({hasText:'Click to expand derivation'});
    assert.equal(await derivations.count(),5);
    for(let index=0;index<5;index++){
      const summary=derivations.nth(index),ancestors=summary.locator('xpath=ancestor::details');
      for(let parent=0;parent<await ancestors.count()-1;parent++)if(!await ancestors.nth(parent).evaluate(element=>element.open))await ancestors.nth(parent).locator(':scope > summary').click();
      const disclosure=summary.locator('..');assert.equal(await disclosure.evaluate(element=>element.open),false);
      await summary.click();assert.equal(await disclosure.evaluate(element=>element.open),true);
      const bounds=await disclosure.locator('.katex').first().boundingBox();assert.ok(bounds?.width>0&&bounds?.height>0,'Expanded authored derivation must be visible');
      await summary.click();assert.equal(await disclosure.evaluate(element=>element.open),false);
    }
    assert.deepEqual(errors,[]);
    report.browser={...report.browser,passed:true,mathDerivationPairs:5};
  }
  report.fullConsumerGatePassed=Boolean(report.stages.validation.passed&&report.skippedExecutionPages.length===0&&report.browser?.passed);
  if(!report.stages.validation.passed){report.blockers.push('Built consumer failed route, internal-link, or API inventory validation');process.exitCode=1;}
} catch(error) { report.error=error.message; report.blockers.push(error.message); process.exitCode=1; }
finally {
  await browser?.close(); await preview?.stop();
  if(inventoryServer)await new Promise(done=>inventoryServer.close(done));
  if(!report.nativeExecution)await recordNativeExecution();
  if(report.sourceDigests){
    const changed=[];
    for(const [name,before] of Object.entries(report.sourceDigests)){
      try{if(digest(await readFile(join(sourceDocs,name)))!==before)changed.push(name);}catch{changed.push(name);}
    }
    report.originalSource={unchanged:changed.length===0,changedFiles:changed};
    if(changed.length){report.blockers.push('Original documentation changed during acceptance run');report.fullConsumerGatePassed=false;process.exitCode=1;}
  }
  report.finishedAt=new Date().toISOString();
  await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:reportPath,consumer,...report.stages,error:report.error,fullConsumerGatePassed:report.fullConsumerGatePassed},null,2));
}
