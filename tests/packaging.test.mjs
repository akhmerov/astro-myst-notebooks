import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initialize } from '../dist/cli.mjs';
import { buildEnvironment } from '../dist/notebooks/build-environment.js';

async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),'notebooks-packaging-'));
  try {await fn(root);} finally {await rm(root,{recursive:true,force:true});}
}
test('initializer previews changes and rejects conflicting files before modifying a project',()=>fixture(async root=>{
  const plan=await initialize({root,dryRun:true});
  assert.ok(plan.files.includes('docs/environment.yml'));
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'docs/astro.config.mjs'),'// existing project');
  await assert.rejects(initialize({root}),/Refusing to replace/);
  assert.equal(await readFile(join(root,'docs/astro.config.mjs'),'utf8'),'// existing project');
  await assert.rejects(initialize({root,dir:'../outside'}),/inside the project/);
}));
test('browser cache reuses completed builds, detects changed inputs and corruption, and preserves a good cache after failure',()=>fixture(async root=>{
  const url=pathToFileURL(root+'/');
  await writeFile(join(root,'environment.yml'),'name: test\ndependencies: [xeus-python]');
  const script=join(root,'builder.mjs');
  await writeFile(script,`import {mkdir,writeFile,readFile} from 'node:fs/promises';
const output=process.argv.find(a=>a.startsWith('--output-dir=')).slice(13);
await mkdir(output+'/xeus',{recursive:true});
const count=Number(await readFile('count','utf8').catch(()=>0))+1;
await writeFile('count',String(count)); await writeFile(output+'/xeus/kernel.json',JSON.stringify({count}));`);
  const options={command:[process.execPath,script]};
  const context={root:url,cache:new URL('cache/',url),log:()=>{}};
  const first=await buildEnvironment(options,context);
  await writeFile(join(root,'prose.md'),'An edit that does not affect Python.');
  assert.equal((await buildEnvironment(options,context)).directory,first.directory);
  assert.equal(await readFile(join(root,'count'),'utf8'),'1');
  await writeFile(join(first.directory,'xeus/kernel.json'),'corrupt');
  await buildEnvironment(options,context);
  assert.equal(await readFile(join(root,'count'),'utf8'),'2');
  await writeFile(script,'process.exit(1)');
  await assert.rejects(buildEnvironment({...options,refresh:true},context));
  assert.equal((await buildEnvironment(options,context)).directory,first.directory);
  await writeFile(join(root,'environment.yml'),'name: changed\ndependencies: [xeus-python]');
  await assert.rejects(buildEnvironment(options,context));
}));
