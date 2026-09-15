#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const contract = JSON.parse(await readFile(new URL('./environment-contract.json', import.meta.url), 'utf8'));
const exists = async path => { try { await access(path); return true; } catch { return false; } };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. The generated files are retained for inspection.`);
}

export async function initialize({ root = process.cwd(), dir = 'docs', environment = 'docs', api, packageSpec = `astro-myst-notebooks@${packageJson.version}`, install = true, dryRun = false } = {}) {
  root = resolve(root);
  const site = resolve(root, dir);
  const localDir = relative(root, site).split(sep).join('/');
  if (!localDir || /^\.\.(\/|$)/.test(localDir) || !/^[\w./-]+$/.test(localDir)) throw new Error('--dir must be a simple relative directory inside the project');
  if (!/^[a-z][a-z0-9-]*$/.test(environment)) throw new Error('Invalid Pixi environment name');
  if (api && !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(api)) throw new Error('--api must be a Python module name');
  let manifest = join(root, 'pixi.toml');
  let data = {};
  let newManifest = false;
  let initializePyproject = false;
  if (await exists(manifest)) data = parse(await readFile(manifest, 'utf8'));
  else if (await exists(join(root,'pyproject.toml'))) {
    manifest = join(root,'pyproject.toml');
    data = parse(await readFile(manifest,'utf8')).tool?.pixi ?? {};
    initializePyproject = !data.workspace && !data.project;
  } else newManifest = true;
  const env = data.environments?.[environment];
  const feature = environment;
  const envFeatures = Array.isArray(env) ? env : env?.features;
  if (env && !envFeatures?.includes(feature)) throw new Error(`Existing environment ${environment} does not include feature ${feature}; select another name or add that feature first`);
  const taskNames = ['docs-install','docs','docs-dev','docs-preview'];
  for (const name of taskNames) if (data.tasks?.[name] || data.feature?.[feature]?.tasks?.[name]) throw new Error(`Pixi task ${name} already exists; choose a new site in a fresh consumer or configure the preset in the existing site`);
  const parent = relative(site,root).split(sep).join('/') + '/';
  const title = basename(root);
  const apiOptions = api ? `, api: { packages: [{ name: ${JSON.stringify(api)}, search: [${JSON.stringify(parent)}], docstringStyle: 'numpy' }], runner: { command: ['python', '-m', 'griffe'] } }` : '';
  const files = {
    'package.json': JSON.stringify({ name: `${title.replace(/[^a-z0-9-]/gi,'-').toLowerCase()}-docs`, private:true, type:'module',
      scripts:{dev:'astro dev',build:'astro build',preview:'astro preview'},
      allowScripts: Object.fromEntries(Object.entries(packageJson.allowScripts ?? {}).filter(([name]) => name.startsWith('esbuild@'))),
      dependencies:{ 'astro-myst-notebooks': packageSpec, astro:packageJson.peerDependencies.astro, '@astrojs/starlight':packageJson.peerDependencies['@astrojs/starlight'], ...(api?{'starlight-pydocs':packageJson.peerDependencies['starlight-pydocs']}:{}) } },null,2)+'\n',
    'astro.config.mjs': `import { defineConfig } from 'astro/config';\nimport starlight from '@astrojs/starlight';\nimport notebooks from 'astro-myst-notebooks/starlight${api ? '/api' : ''}';\n\nexport default defineConfig({\n  integrations: [starlight({\n    title: ${JSON.stringify(title)},\n    plugins: [notebooks({ execution: { cwd: new URL(${JSON.stringify(parent)}, import.meta.url) }${apiOptions} })],\n  })],\n});\n`,
    'src/content.config.ts': "import { notebookCollections } from 'astro-myst-notebooks/starlight/content';\n\nexport const collections = notebookCollections();\n",
    'src/content/docs/index.md': '---\ntitle: Welcome\n---\n\n```{code-cell} python\nprint("Hello from Jupyter")\n```\n',
    'environment.yml': await readFile(new URL('./templates/environment.yml',import.meta.url),'utf8'),
    '.gitignore':'node_modules/\ndist/\n.astro/\n',
  };
  for (const name of Object.keys(files)) if (await exists(join(site,name))) throw new Error(`Refusing to replace existing ${localDir}/${name}`);
  if (dryRun) return {files:Object.keys(files).map(name=>`${localDir}/${name}`), manifest, environment, contract};
  // Check the tool before writing. Use Pixi itself to preserve manifest comments and syntax.
  run('pixi',['--version'],root);
  if (initializePyproject) run('pixi', ['init', '--format', 'pyproject', root], root);
  if (newManifest) {
    const platform = process.platform === 'darwin' ? (process.arch==='arm64'?'osx-arm64':'osx-64') : process.platform==='win32'?'win-64':'linux-64';
    await writeFile(manifest,`[workspace]\nname = ${JSON.stringify(title)}\nchannels = ["conda-forge"]\nplatforms = [${JSON.stringify(platform)}]\n`);
  }
  for (const [name,contents] of Object.entries(files)) { await mkdir(resolve(site,name,'..'),{recursive:true}); await writeFile(join(site,name),contents,{flag:'wx'}); }
  const common=['--manifest-path',manifest];
  const conda={...contract.conda,...(api?contract.apiConda:{})};
  // Existing dependency constraints remain authoritative; Pixi verifies solvability.
  const declared={...data.dependencies,...data.feature?.[feature]?.dependencies};
  const additions=Object.entries(conda).filter(([name])=>!declared[name]).map(([name,range])=>`${name}${/^[\d*]/.test(range)?'='+range:range}`);
  if(additions.length) run('pixi',['add',...common,'--feature',feature,'--no-install',...additions],root);
  const pypi={...contract.pypi,...(api?contract.apiPypi:{})};
  const declaredPypi={...data['pypi-dependencies'],...data.feature?.[feature]?.['pypi-dependencies']};
  const pythonAdditions=Object.entries(pypi).filter(([name])=>!declaredPypi[name]).map(([name,range])=>name+range);
  if(pythonAdditions.length) run('pixi',['add',...common,'--feature',feature,'--pypi','--no-install',...pythonAdditions],root);
  if(!env) run('pixi',['workspace','environment','add',...common,environment,'--feature',feature],root);
  run('pixi',['task','add',...common,'--feature',feature,'--cwd',localDir,'docs-install','npm ci'],root);
  for(const [name,command] of [['docs','npm run build'],['docs-dev','npm run dev -- --port {{ port }}'],['docs-preview','npm run preview --']]) {
    run('pixi',['task','add',...common,'--feature',feature,'--cwd',localDir,'--depends-on','docs-install',...(name==='docs-dev'?['--arg','port']:[]),'--',name,command],root);
  }
  // Pixi's task CLI accepts positional names; give our generated argument a default.
  const configured = await readFile(manifest, 'utf8');
  await writeFile(manifest, configured.replace(/^(docs-dev = .*?)args = \["port"\]/m,
    '$1args = [{ arg = "port", default = "51300" }]'));
  if(install) run('npm',['install','--prefix',site],root);
  console.log(`Documentation created in ${localDir}.\n${install?'':'Run npm install in that directory first.\n'}Start: pixi run -e ${environment} docs-dev\nBuild: pixi run -e ${environment} docs\nCommit the generated configuration, environment.yml, pixi.lock, and npm lockfile.`);
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try {
    const {values,positionals}=parseArgs({allowPositionals:true,options:{dir:{type:'string'},'pixi-environment':{type:'string'},api:{type:'string'},package:{type:'string'},'no-install':{type:'boolean'},'dry-run':{type:'boolean'},help:{type:'boolean'}}});
    if(values.help || positionals.length===0) console.log('Usage: astro-myst-notebooks init [--dir docs] [--pixi-environment docs] [--api mypackage] [--dry-run] [--no-install]\nDevelopment: --package /absolute/path/to/package.tgz');
    else {
      if(positionals.length!==1 || positionals[0]!=='init') throw new Error('Expected the init command');
      const result=await initialize({dir:values.dir,environment:values['pixi-environment'],api:values.api,packageSpec:values.package,install:!values['no-install'],dryRun:values['dry-run']});
      if(result) console.log(JSON.stringify(result,null,2));
    }
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
