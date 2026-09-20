import { build } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const directory = 'dist/notebooks/browser';
await rm(directory, { recursive: true, force: true });
await mkdir(`${directory}/assets`, { recursive: true });
const result = await build({
  entryPoints: ['src/notebooks/client.ts', 'src/notebooks/element.ts'], outdir: directory,
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  // Keep debug maps in the package without linking or deploying them to every site.
  loader: { '.svg': 'text' }, metafile: true, minify: true, sourcemap: 'external',
  plugins: [{ name: 'xeus-assets', setup(build) {
    build.onResolve({filter:/^@jupyterlite\/xeus$/}, () => ({path:resolve('src/notebooks/xeus-kernel.ts')}));
    build.onResolve({filter:/\?text$/}, args => ({path:require.resolve(args.path.replace('?text','.js'), {paths:[args.resolveDir]}),namespace:'raw-text'}));
    build.onLoad({filter:/.*/,namespace:'raw-text'}, async args => ({contents:await readFile(args.path,'utf8'),loader:'text'}));
  } }],
});
const cachePrelude = (await build({
  entryPoints: ['src/notebooks/worker-cache.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', minify: true,
})).outputFiles[0].text;
for (const [name, subdir, pattern] of [
  ['thebe', 'lib', /\.(js|css|txt)$/],
  ['@jupyterlite/xeus', 'lib', /\.worker\.js$/],
  ['@emscripten-forge/mambajs-core', 'lib', /\.wasm$/],
]) {
  const root = dirname(require.resolve(`${name}/package.json`));
  for (const file of await readdir(join(root, subdir))) if (pattern.test(file)) {
    const source = join(root, subdir, file);
    const target = `${directory}/assets/${file}`;
    if (name === '@jupyterlite/xeus') await writeFile(target, cachePrelude + '\n' + await readFile(source, 'utf8'));
    else await copyFile(source, target);
  }
}
await copyFile(require.resolve('mathjax/es5/tex-svg-full.js'), `${directory}/mathjax-tex-svg.js`);
const runtimeHash = createHash('sha256');
for (const folder of ['', 'assets/']) {
  for (const name of (await readdir(directory + '/' + folder)).sort()) {
    if (folder === '' && !name.endsWith('.js')) continue;
    runtimeHash.update(folder + name + '\0').update(await readFile(directory + '/' + folder + name));
  }
}
await writeFile(`${directory}/version.json`, JSON.stringify(runtimeHash.digest('hex').slice(0, 20)));
// Include licenses and exact package identities for all bundled code, not only direct dependencies.
const roots = new Set(Object.keys(result.metafile.inputs).filter(p=>p.includes('node_modules/') && !p.startsWith('(disabled):') && !p.startsWith('raw-text:')).map(p => {
  const pieces = p.split('node_modules/');
  const tail = pieces.pop().split('/');
  const count = tail[0].startsWith('@') ? 2 : 1;
  return pieces.join('node_modules/') + 'node_modules/' + tail.slice(0,count).join('/');
}));
for (const name of ['thebe','@jupyterlite/xeus','@emscripten-forge/mambajs-core','mathjax']) roots.add(dirname(require.resolve(`${name}/package.json`)));
const packages=[];
let notices='Browser dependencies\n====================\n';
for (const root of [...roots].sort()) {
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  packages.push({name:pkg.name,version:pkg.version,license:pkg.license});
  notices+=`\n${pkg.name}@${pkg.version} (${pkg.license})\n`;
  for(const file of await readdir(root)) if (/^(licen[sc]e|notice|copying)(\.|$)/i.test(file)) {
    try { notices+=await readFile(join(root,file),'utf8'); } catch {}
  }
}
await writeFile(`${directory}/DEPENDENCIES.json`,JSON.stringify(packages,null,2)+'\n');
await writeFile(`${directory}/LICENSES.txt`,notices);
