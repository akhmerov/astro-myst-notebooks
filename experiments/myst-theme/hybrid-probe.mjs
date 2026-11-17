import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compare driver ownership without changing the package's public integration.
// This consumer owns astro.config and uses the same experimental JSON loader.
const experiment = dirname(fileURLToPath(import.meta.url));
const repo = resolve(experiment, '../..');
const astroPackage = JSON.parse(await readFile(join(repo, 'node_modules/astro/package.json')));
const astroBin = typeof astroPackage.bin === 'string' ? astroPackage.bin : astroPackage.bin.astro;
const starlightPackage = JSON.parse(await readFile(join(repo, 'node_modules/@astrojs/starlight/package.json')));
const packageInfo = JSON.parse(await readFile(join(repo, 'package.json')));
const archive = join(repo, `astro-myst-notebooks-${packageInfo.version}.tgz`);
const project = await mkdtemp(join(tmpdir(), 'myst-astro-consumer-'));
console.log(`Hybrid fixture: ${project}`);
const output = join(project, '_build/astro-html');
const base = '/manual/';
const sourceFiles = ['index.md', 'second.md', '_included.md', 'api.md', 'theme_api.py'];
for (const path of sourceFiles) await cp(join(experiment, 'project', path), join(project, path));
await mkdir(join(project, 'src/components'), { recursive: true });
await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'pipeline-consumer', type: 'module', private: true,
  dependencies: { 'astro-myst-notebooks': `file:${archive}`, astro: astroPackage.version, '@astrojs/starlight': starlightPackage.version },
}, null, 2) + '\n');
await writeFile(join(project, 'autodoc.mjs'), `import {createAutodoc} from ${JSON.stringify(join(repo, 'packages/myst-autodoc/index.mjs'))};\nexport default createAutodoc({modules:['theme_api'],searchPaths:['.']});\n`);
await writeFile(join(project, 'myst.yml'), `version: 1\nproject:\n  title: MyST document title\n  plugins: [./autodoc.mjs, ${JSON.stringify(join(experiment, 'provenance.mjs'))}, ${JSON.stringify(join(experiment, 'execution.mjs'))}]\n  toc:\n    - file: index.md\n    - file: second.md\n    - file: api.md\nsite:\n  template: ${JSON.stringify(join(experiment, 'theme'))}\n`);
await writeFile(join(project, 'src/components/ReviewBanner.astro'), '<aside id="consumer-banner">A consumer-owned Astro component</aside>\n');
await writeFile(join(project, 'src/content.config.ts'), `import {defineCollection} from 'astro:content';\nimport {docsSchema} from '@astrojs/starlight/schema';\nimport {mystContent} from ${JSON.stringify(join(experiment, 'theme/content.mjs'))};\nexport const collections={docs:defineCollection({loader:mystContent(),schema:docsSchema()})};\n`);
await cp(join(repo, 'docs/environment.yml'), join(project, 'environment.yml'));
// Reuse only the public browser build cache, not MyST/Jupyter logs or runtime
// connection files. Cache reuse is explicit prototype setup.
const browserCache = join(experiment, 'project/_build/.astro/notebooks/browser');
await mkdir(join(project, '_build/.astro/notebooks'), { recursive: true });
await cp(browserCache, join(project, '_build/.astro/notebooks/browser'), { recursive: true });
await writeFile(join(project, 'astro.config.mjs'), `import {defineConfig} from 'astro/config';
import starlight from '@astrojs/starlight';
import notebooks from 'astro-myst-notebooks';
export default defineConfig({base:${JSON.stringify(base)},outDir:${JSON.stringify(output)},cacheDir:'./_build/.astro',integrations:[
starlight({title:'Consumer owns Astro',description:'Independent consumer configuration',components:{Banner:'./src/components/ReviewBanner.astro',PageTitle:'astro-myst-notebooks/starlight/PageTitle.astro'},sidebar:[{label:'Consumer navigation',items:[{label:'Introduction',slug:''},{label:'Second page',slug:'second'},{label:'API',slug:'api'}]}]}),
notebooks({execution:{cwd:new URL('./',import.meta.url)},interactive:{environment:new URL('./environment.yml',import.meta.url)}})
]});\n`);

async function run(script, args, env, command = process.execPath) {
  const child = spawn(command, [script, ...args], { cwd: project, env, detached: true });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 60000);
  let exit;
  try { exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); }
  finally { clearTimeout(timer); }
  // Keep raw build output in memory. Return only whitelisted observations.
  const lines = logs.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const failure = lines.findLastIndex(line => line.includes('[ERROR]'));
  const context = failure >= 0 ? lines.slice(failure, failure + 12) : [];
  return { exit, browserCacheReused: logs.includes('Reusing browser environment'),
    diagnostics: ['Cannot find package', 'Experimental theme does not render', 'Could not resolve', 'Environment'].filter(text => logs.includes(text)),
    ...(exit !== 0 ? { errors: (logs.match(/^.*(?:error|cannot|could not|unable|failed|invalid|not found|not exported).*$/gmi) ?? [])
      .filter(line => !/https?:|token|secret|password|credential|authorization|bearer/i.test(line)).slice(-5) } : {}),
    ...(exit !== 0 ? { context: context.filter(line => !/https?:|token|secret|password|credential|authorization|bearer/i.test(line)) } : {}),
  };
}

const env = { ...process.env, BASE_URL: base, ASTRO_MYST_PROJECT: project, MYST_THEME_EXECUTION: 'document' };
const install = await run('install', ['--ignore-scripts', '--no-audit', '--no-fund'], env, 'npm');
assert.equal(install.exit, 0, JSON.stringify(install));
const documentBuild = await run(join(repo, 'packages/myst-autodoc/cli.mjs'), ['build', '--base', base], env);
assert.equal(documentBuild.exit, 0, JSON.stringify(documentBuild));
const site = join(project, '_build/site');
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\//, '');
  for (const root of [site, join(site, 'public')]) {
    const file = resolve(root, path);
    if (!file.startsWith(root + '/')) continue;
    try { res.writeHead(200).end(await readFile(file)); return; } catch {}
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let astroBuild;
try {
  env.CONTENT_CDN = `http://127.0.0.1:${server.address().port}/`;
  astroBuild = await run(join(project, 'node_modules/astro', astroBin), ['build'], env);
  assert.equal(astroBuild.exit, 0, JSON.stringify(astroBuild));
} finally { await new Promise(resolve => server.close(resolve)); }
const html = await readFile(join(output, 'index.html'), 'utf8');
const second = await readFile(join(output, 'second/index.html'), 'utf8');
const api = await readFile(join(output, 'api/index.html'), 'utf8');
const scripts = await readdir(join(output, '_astro'));
const scriptContents = (await Promise.all(scripts.filter(path => /\.[cm]?js$/.test(path)).map(path => readFile(join(output, '_astro', path), 'utf8')))).join('\n');
const runtimePublished = (await readdir(join(output, 'notebooks'))).length > 0;
const environmentPublished = (await readdir(join(output, 'thebe'))).length > 0;
const result = { date: new Date().toISOString().slice(0, 10), myst: '1.11.0',
  install, documentBuild, astroBuild,
  consumerTitle: html.includes('Consumer owns Astro'),
  consumerComponent: html.includes('id="consumer-banner"'),
  consumerNavigation: html.includes('Consumer navigation'),
  computedCell: html.includes('The triangular number is 21'),
  inlineResult: /computed value in prose[^]*?21/.test(html),
  prefixedReference: html.includes('href="/manual/second#triangle"'),
  sharedOutput: second.includes('The triangular number is 21'),
  apiContent: api.includes('The last integer to include'),
  sourceProvenance: html.includes('data-source-location='),
  runtimeAssets: runtimePublished && environmentPublished && scriptContents.includes('/manual/notebooks/') && scriptContents.includes('/manual/thebe/'),
  readerExecutionTested: false, publishedInventoriesTested: false,
  installation: 'package archive and pinned Astro/Starlight; checkout-local JSON loader/plugins; copied public browser cache',
};
for (const key of ['consumerTitle','consumerComponent','consumerNavigation','computedCell','inlineResult','prefixedReference','sharedOutput','apiContent','sourceProvenance','runtimeAssets']) assert.equal(result[key], true, key);
await writeFile(resolve(process.argv[2] ?? join(project, 'results.json')), JSON.stringify(result, null, 2) + '\n');
console.log(`Hybrid consumer build validated; fixture: ${project}`);
