import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initialize } from '../dist/cli.mjs';
import { buildEnvironment } from '../dist/notebooks/build-environment.js';
import { parse, stringify } from 'smol-toml';
import { pack } from '../scripts/pack.mjs';

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
test('initializer preserves existing TOML and writes a default port in both manifest formats', async () => {
  const contract = JSON.parse(await readFile(new URL('../dist/environment-contract.json', import.meta.url), 'utf8'));
  for (const name of ['pixi.toml', 'pyproject.toml']) await fixture(async root => {
    const existing = { cmd: 'echo {{ port }}', args: [{ arg: 'port', default: 'unrelated' }] };
    const config = { workspace: { name: 'fixture', channels: ['conda-forge'], platforms: ['linux-64'] },
      dependencies: contract.conda, 'pypi-dependencies': contract.pypi,
      feature: { docs: { tasks: { existing } } }, environments: { docs: ['docs'] } };
    const data = name === 'pyproject.toml' ? { project: { name: 'fixture', version: '0.0.0' }, tool: { pixi: config } } : config;
    await writeFile(join(root, name), '# Retain this project comment.\n' + stringify(data));
    await initialize({ root, install: false });
    const source = await readFile(join(root, name), 'utf8');
    assert.match(source, /# Retain this project comment\./);
    const parsed = parse(source);
    const tasks = (parsed.tool?.pixi ?? parsed).feature.docs.tasks;
    assert.deepEqual(tasks.existing, existing);
    assert.deepEqual(tasks['docs-dev'], { cmd: 'npm run dev -- --port {{ port }}', cwd: 'docs',
      'depends-on': ['docs-install'], args: [{ arg: 'port', default: '51300' }] });
  });
});

test('packing patches an isolated payload and leaves the checkout and previous archive intact on failure', () => fixture(async root => {
  const json = async (path, value) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(value, null, 2));
  };
  const pkg = { name: 'pack-fixture', version: '1.0.0', files: ['dist', 'npm-shrinkwrap.json'],
    dependencies: { 'bundled-engine': '1.0.0' }, bundleDependencies: ['bundled-engine'],
    devDependencies: { 'build-only': '1.0.0' }, scripts: { prepack: 'exit 1', postpack: 'exit 1' } };
  const engine = { name: 'bundled-engine', version: '1.0.0', dependencies: { helper: '^1.0.0' } };
  await json('package.json', pkg);
  await json('node_modules/bundled-engine/package.json', engine);
  await json('node_modules/helper/package.json', { name: 'helper', version: '2.0.0' });
  await json('dist/fixture.json', { ready: true });
  await json('scripts/dependency-patches.json', [
    { package: 'bundled-engine', version: '1.0.0', dependency: 'helper', from: '^1.0.0', to: '^2.0.0' },
  ]);
  await json('package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': { ...pkg },
      'node_modules/bundled-engine': { version: '1.0.0', inBundle: true, dependencies: engine.dependencies },
      'node_modules/helper': { version: '2.0.0', inBundle: true },
      'node_modules/build-only': { version: '1.0.0', dev: true } } });
  const sourcePaths = ['package.json', 'package-lock.json', 'node_modules/bundled-engine/package.json'];
  const before = await Promise.all(sourcePaths.map(path => readFile(join(root, path), 'utf8')));
  const result = await pack({ root });
  const archive = await readFile(result.path);
  assert.deepEqual(await Promise.all(sourcePaths.map(path => readFile(join(root, path), 'utf8'))), before);
  const consumer = join(root, 'consumer');
  await json('consumer/package.json', { name: 'consumer', version: '1.0.0', private: true });
  for (const args of [['install', result.path], ['ci']]) {
    const installed = spawnSync(process.execPath, [process.env.npm_execpath, ...args,
      '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
  }
  const installed = path => readFile(join(consumer, 'node_modules/pack-fixture', path), 'utf8').then(JSON.parse);
  assert.equal((await installed('node_modules/bundled-engine/package.json')).dependencies.helper, '^2.0.0');
  assert.equal((await installed('npm-shrinkwrap.json')).packages['node_modules/bundled-engine'].dependencies.helper, '^2.0.0');
  assert.equal((await installed('package.json')).scripts, undefined);
  assert.equal((await installed('package.json')).devDependencies, undefined);
  // Fail validation after a successful pack: no installed files or published archive may change.
  await json('scripts/dependency-patches.json', [
    { package: 'bundled-engine', version: '1.0.0', dependency: 'helper', from: '^1.0.0', to: '^2.0.0' },
    { package: 'bundled-engine', version: '2.0.0', dependency: 'helper', from: '^1.0.0', to: '^2.0.0' },
  ]);
  await assert.rejects(pack({ root }), /Review the release dependency patch/);
  assert.deepEqual(await readFile(result.path), archive);
  assert.deepEqual(await Promise.all(sourcePaths.map(path => readFile(join(root, path), 'utf8'))), before);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.notebooks-pack-')));
  await assert.rejects(readFile(join(root, 'npm-shrinkwrap.json')), { code: 'ENOENT' });
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

test('browser mounts track file changes and destinations, and reject missing or conflicting inputs', () => fixture(async root => {
  const url = pathToFileURL(root + '/');
  await writeFile(join(root, 'environment.yml'), 'name: test\ndependencies: [xeus-python]');
  await mkdir(join(root, 'data set'));
  await writeFile(join(root, 'data set/readings.csv'), 'value\n42\n');
  await writeFile(join(root, 'description.txt'), 'Measurements');
  const script = join(root, 'builder.mjs');
  await writeFile(script, `import { mkdir, writeFile, readFile } from 'node:fs/promises';
const output = process.argv.find(a => a.startsWith('--output-dir=')).slice(13);
await mkdir(output + '/xeus', { recursive: true });
const count = Number(await readFile('count', 'utf8').catch(() => 0)) + 1;
await writeFile('count', String(count));
await writeFile(output + '/xeus/kernel.json', JSON.stringify(process.argv));`);
  const options = { command: [process.execPath, script], mounts: [
    { source: new URL('data%20set/', url), target: '/data/measurements' },
    { source: new URL('description.txt', url), target: '/data' },
  ] };
  const context = { root: url, cache: new URL('cache/', url), log: () => {} };
  const build = () => buildEnvironment(options, context);
  const initial = await build();
  assert.deepEqual(JSON.parse(await readFile(join(initial.directory, 'xeus/kernel.json'), 'utf8'))
    .filter(arg => arg.startsWith('--XeusAddon.mounts=')), [
      `--XeusAddon.mounts=${root}/data set:/data/measurements`,
      `--XeusAddon.mounts=${root}/description.txt:/data`,
    ]);
  await writeFile(join(root, 'data set/readings.csv'), 'value\n42\n');
  assert.equal((await build()).directory, initial.directory, 'mtime changes do not change the payload');
  await writeFile(join(root, 'data set/readings.csv'), 'value\n43\n');
  assert.notEqual((await build()).directory, initial.directory);
  await rename(join(root, 'data set/readings.csv'), join(root, 'data set/renamed.csv'));
  await build();
  await writeFile(join(root, 'data set/extra.txt'), 'another input');
  await build();
  await rm(join(root, 'data set/renamed.csv'));
  await build();
  options.mounts[0].target = '/relocated';
  await build();
  await writeFile(join(root, 'description.txt'), 'Updated measurements');
  await build();
  assert.equal(await readFile(join(root, 'count'), 'utf8'), '7');
  const invalid = mounts => buildEnvironment({ ...options, mounts }, context);
  for (const target of ['relative', '/data/../files', '/files/data', '/data:other', '/data\\other']) {
    await assert.rejects(invalid([{ source: options.mounts[1].source, target }]), /mount target/);
  }
  await assert.rejects(invalid([{ source: new URL('missing', url), target: '/data' }]), /Cannot read browser mount source/);
  await assert.rejects(invalid([options.mounts[1], options.mounts[1]]), /Overlapping browser mount/);
  await symlink(join(root, 'description.txt'), join(root, 'data set/link'));
  await assert.rejects(build(), /Unsupported browser artifact/);
  await assert.rejects(invalid([{ source: new URL('data%20set/link', url), target: '/data' }]), /regular file or directory/);
  await symlink(join(root, 'data set'), join(root, 'directory-link'));
  await assert.rejects(invalid([{ source: new URL('directory-link/', url), target: '/data' }]), /regular file or directory/);
  await assert.rejects(buildEnvironment({ ...options, mounts: [{ ...options.mounts[1], target: '/opt/wheels' }],
    wheel: { project: url } }, context), /overlaps the package wheel/);
}));
