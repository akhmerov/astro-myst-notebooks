import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseDocument, baselineRevision } from './migration-baseline/parse-document.mjs';
import { loadSource } from '../dist/notebook-source.mjs';
import { finalizeOrigins } from '../dist/engine/provenance.mjs';

// Inspect the actual finalized engine JSON, never a reconstruction of the new
// pipeline. The legacy parser is used only as an independently generated lexical
// baseline, not to establish whether a new origin points at the right source.
const repo=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
const option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1]};
const project=resolve(option('--project',join(repo,'docs')));
const root=resolve(option('--source-root',repo));
const site=resolve(option('--site',join(project,'_build/site')));
const output=resolve(option('--output','/tmp/astro-provenance-parity.json'));
const baselinePrefix=option('--baseline-prefix',null);
const sources=new Map();
const require=createRequire(import.meta.url);
const mystPackage=JSON.parse(await readFile(require.resolve('mystmd/package.json'),'utf8'));
const parserPackage=JSON.parse(await readFile(join(repo,'node_modules/myst-parser/package.json'),'utf8'));
const posix=value=>value.replaceAll('\\','/');
const point=(source,offset)=>{const before=source.slice(0,offset).split('\n');return{line:before.length,column:before.at(-1).length+1,offset}};
async function sourceFor(file){const path=resolve(root,file);if(!sources.has(path))sources.set(path,await loadSource(path));return sources.get(path)}
const unionLength=ranges=>{
  const sorted=ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let total=0,start,end;
  for(const [a,b] of sorted){if(start===undefined){start=a;end=b}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b}}
  return total+(start===undefined?0:end-start);
};
function treeNodes(tree){const result=[];function walk(node,generated=false){const declared=generated||node.data?.autodocGenerated||node.data?.sourceGenerated===true||['outputs','output','captionNumber','numbering'].includes(node.type);result.push({node,generated:Boolean(declared)});for(const child of node.children??[])walk(child,declared)}walk(tree);return result}
function coverage(tree,ownFile){
  const own={proseNodes:0,exactCharacters:0,rangeCharacters:0,exactSourceIntervals:[],unmappedPositionedCharacters:0,unclassifiedCharacters:0,declaredGeneratedCharacters:0,unclassifiedExamples:[]};
  const included=new Map();
  for(const {node,generated} of treeNodes(tree)){
    if(!['text','inlineCode'].includes(node.type)||typeof node.value!=='string')continue;
    const origin=node.data?.origin;
    if(generated){own.declaredGeneratedCharacters+=node.value.length;continue}
    if(!origin){
      if(node.position)own.unmappedPositionedCharacters+=node.value.length;
      else {own.unclassifiedCharacters+=node.value.length;if(own.unclassifiedExamples.length<30)own.unclassifiedExamples.push({type:node.type,value:node.value})}
      continue;
    }
    let group=own;
    if(origin.file!==ownFile){if(!included.has(origin.file))included.set(origin.file,{proseNodes:0,exactCharacters:0,rangeCharacters:0,exactSourceIntervals:[]});group=included.get(origin.file)}
    group.proseNodes++;
    if(origin.kind==='exact'){group.exactCharacters+=node.value.length;group.exactSourceIntervals.push([origin.start,origin.end])}
    else group.rangeCharacters+=node.value.length;
  }
  const finish=entry=>{const {exactSourceIntervals,...counts}=entry;return{...counts,uniqueExactSourceCharacters:unionLength(exactSourceIntervals)}};
  return{own:finish(own),included:Object.fromEntries([...included].map(([name,entry])=>[name,finish(entry)]))};
}
async function validate(tree){
  const failures=[];let origins=0,exactValues=0,rangeValues=0,codeLines=0,declaredMarkdownRanges=0,declaredCsvRanges=0;
  const finalized=structuredClone(tree);
  try{
    await finalizeOrigins(finalized,{root});
    if(JSON.stringify(finalized)!==JSON.stringify(tree))failures.push({rule:'published-finalization',message:'Published page JSON still requires source-text or provenance finalization'});
  }catch(error){failures.push({rule:'range-finalization',message:error.message})}
  for(const {node,generated} of treeNodes(tree)){
    const origin=node.data?.origin;if(!origin)continue;origins++;
    let source;
    try{source=await sourceFor(origin.file)}catch(error){failures.push({rule:'source-loads',file:origin.file,message:error.message});continue}
    const fail=(rule,message)=>failures.push({rule,file:origin.file,node:node.type,start:origin.start,end:origin.end,text:typeof node.value==='string'?node.value.slice(0,160):undefined,message});
    if(!Number.isInteger(origin.start)||!Number.isInteger(origin.end)||origin.start<0||origin.end<origin.start||origin.end>source.length){fail('valid-range','Offsets must identify a real canonical source slice');continue}
    if(origin.version!==1||origin.encoding!=='utf-16')fail('source-identity','Expected version 1 UTF-16 source-map contract');
    if(origin.digest!==createHash('sha256').update(source).digest('hex'))fail('source-digest','Digest differs from canonical source text');
    for(const side of ['start','end']){
      const expected=point(source,origin[side]);const actual=origin.position?.[side];
      if(!actual||actual.line!==expected.line||actual.column!==expected.column||actual.offset!==expected.offset)fail('position-offsets',`${side} position disagrees with UTF-16 offsets`);
    }
    if(generated)fail('generated-origin','Declared generated prose must not claim authored source');
    if(typeof node.value==='string'){
      const slice=source.slice(origin.start,origin.end);
      if(origin.kind==='exact'){exactValues++;if(slice!==node.value)fail('exact-value','Canonical source slice differs from the node value')}
      else if(['text','inlineCode'].includes(node.type)){rangeValues++;if(!slice.includes(node.value)){if(origin.transformation==='markdown')declaredMarkdownRanges++;else if(origin.transformation==='csv')declaredCsvRanges++;else fail('range-contains-text','Range does not contain the rendered text and declares no validated transformation')}}
    }
    if(node.type==='code'&&node.executable&&!origin.lines)fail('code-line-map','Executable cells require exact source mapping for every line');
    if(origin.lines){
      const values=typeof node.value==='string'?node.value.split('\n'):[];
      if(origin.lines.length!==values.length)fail('code-line-count','Per-line map length differs from executable source');
      origin.lines.forEach((line,index)=>{codeLines++;if(line.kind!=='exact'||line.start<origin.start||line.end>origin.end||source.slice(line.start,line.end)!==values[index])fail('code-line-value',`Line ${index+1} does not match its authored source`)});
    }
  }
  return{origins,exactValues,rangeValues,codeLines,declaredMarkdownRanges,declaredCsvRanges,failures};
}
const pages=[];
for(const name of (await readdir(join(site,'content'))).filter(name=>name.endsWith('.json')).sort()){
  const page=JSON.parse(await readFile(join(site,'content',name),'utf8'));
  const path=resolve(project,page.location.replace(/^\//,''));
  const ownFile=posix(relative(root,path));
  const result={page:name,source:ownFile};
  result.validation=await validate(page.mdast);
  result.engine=coverage(page.mdast,ownFile);
  if(baselinePrefix&&!ownFile.startsWith(baselinePrefix)){
    result.baselineClassification={included:false,reason:'outside explicitly selected authored source prefix',prefix:baselinePrefix};
    pages.push(result);continue;
  }
  result.baselineClassification={included:true,...(baselinePrefix?{prefix:baselinePrefix}:{})};
  try{
    const source=await loadSource(path);
    const baseline=parseDocument(source,path,root).tree;
    result.legacy=coverage(baseline,ownFile);
    const denominator=result.legacy.own.exactCharacters+result.legacy.own.rangeCharacters;
    result.comparison={
      denominatorLegacyOwnMappedProseCharacters:denominator,
      engineExactOverLegacyMapped:denominator?result.engine.own.exactCharacters/denominator:null,
      legacyExactOverLegacyMapped:denominator?result.legacy.own.exactCharacters/denominator:null,
      exactCharacterDifference:result.engine.own.exactCharacters-result.legacy.own.exactCharacters,
      uniqueExactSourceCharacterDifference:result.engine.own.uniqueExactSourceCharacters-result.legacy.own.uniqueExactSourceCharacters,
    };
  }catch(error){result.baselineError=error.message}
  pages.push(result);
}
const sum=key=>pages.reduce((n,page)=>n+(key(page)??0),0);
const legacyMapped=sum(page=>(page.legacy?.own.exactCharacters??0)+(page.legacy?.own.rangeCharacters??0));
const report={
  project,sourceRoot:root,site,created:new Date().toISOString(),versions:{engineMystmd:mystPackage.version,legacyMystParser:parserPackage.version,lexicalBaselineRevision:baselineRevision},
  contract:{offsets:'UTF-16 code units in actual Markdown, or notebookToMyst text with representation:myst',
    denominator:'Legacy parseDocument own-page text and inlineCode characters carrying authored origins; excludes included-file contributions and declared generated nodes. Unmapped and unclassified characters are reported separately, never treated as authored coverage.',
    rangeProof:'Literal ranges must contain their rendered text. Declared transformation:markdown and transformation:csv ranges additionally pass finalizeOrigins lexical validation and remain inexact; CSV fields are decoded from the authored enclosing directive. The published JSON must already equal its finalized form.',
    baselineScope:'Legacy parseDocument/loadSource lexical baseline. It does not expand includes or resolve the whole project. Engine included-file contributions are reported separately; exact source intervals are deduplicated for a second coverage measure.',
    ...(baselinePrefix?{baselinePrefix,baselineExclusions:'Pages outside the selected authored source prefix remain subject to all origin validation but are excluded from the authored lexical denominator.'}:{}),
    acceptance:'All validation failures fail the script. No coverage floor is assumed; differences are reported for review. --require-no-regression additionally requires no decrease in per-page unique exact authored source characters.'},
  totals:{pages:pages.length,baselinePages:pages.filter(page=>page.baselineClassification.included).length,baselineExcludedPages:pages.filter(page=>!page.baselineClassification.included).length,validationFailures:sum(page=>page.validation.failures.length),baselineFailures:pages.filter(page=>page.baselineError).length,
    origins:sum(page=>page.validation.origins),exactValues:sum(page=>page.validation.exactValues),rangeValues:sum(page=>page.validation.rangeValues),codeLines:sum(page=>page.validation.codeLines),declaredMarkdownRanges:sum(page=>page.validation.declaredMarkdownRanges),declaredCsvRanges:sum(page=>page.validation.declaredCsvRanges),
    legacyMappedProseCharacters:legacyMapped,legacyExactCharacters:sum(page=>page.legacy?.own.exactCharacters),engineExactCharacters:sum(page=>page.baselineClassification.included?page.engine.own.exactCharacters:0),
    legacyExactOverLegacyMapped:legacyMapped?sum(page=>page.legacy?.own.exactCharacters)/legacyMapped:null,engineExactOverLegacyMapped:legacyMapped?sum(page=>page.baselineClassification.included?page.engine.own.exactCharacters:0)/legacyMapped:null,
    legacyUniqueExactSourceCharacters:sum(page=>page.legacy?.own.uniqueExactSourceCharacters),engineUniqueExactSourceCharacters:sum(page=>page.baselineClassification.included?page.engine.own.uniqueExactSourceCharacters:0),
    engineUnmappedPositionedCharacters:sum(page=>page.engine.own.unmappedPositionedCharacters),engineUnclassifiedCharacters:sum(page=>page.engine.own.unclassifiedCharacters)},
  pages,
};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,...report.totals}));
for(const page of pages)if(page.comparison?.uniqueExactSourceCharacterDifference<0)console.log(`Coverage regression: ${page.source}: ${page.comparison.uniqueExactSourceCharacterDifference} unique exact source characters`);
if(report.totals.validationFailures||report.totals.baselineFailures||args.includes('--require-no-regression')&&pages.some(page=>page.comparison?.uniqueExactSourceCharacterDifference<0))process.exitCode=1;
