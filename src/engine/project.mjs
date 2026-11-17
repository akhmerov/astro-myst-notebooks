import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { finalizeOrigins } from './provenance.mjs';
import { Inventory } from 'intersphinx';
import { readPageMetadata } from './execution.mjs';
import { prepareApi } from './api.mjs';

const require = createRequire(import.meta.url);
const registry = globalThis[Symbol.for('astro-myst-notebooks.engines')] ??= new Map();
const pathOf = value => value instanceof URL ? fileURLToPath(value) : value;
const posix = value => value.split(sep).join('/');
const exists = async path => { try { await access(path); return true; } catch { return false; } };

async function writeChanged(path, value) {
  if (await readFile(path, 'utf8').catch(() => null) === value) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

export const sourceMetadata = readPageMetadata;

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(md|ipynb)$/.test(entry.name)) files.push(path);
  }
  return files.sort((a, b) => /(?:^|\/)index\.(?:md|ipynb)$/.test(a) ? -1 : /(?:^|\/)index\.(?:md|ipynb)$/.test(b) ? 1 : a.localeCompare(b));
}

export function registerEngine(config, options = {}) {
  const root = resolve(pathOf(config.root));
  const previous = registry.get(root);
  const engine = previous ?? { root, revision: 0 };
  engine.options = options;
  engine.manifest = undefined;
  engine.publicAssets = new Map();
  engine.base = config.base;
  engine.trailingSlash = config.trailingSlash;
  engine.source = resolve(pathOf(options.myst?.source ?? new URL('content/docs/', config.srcDir)));
  engine.cache = resolve(pathOf(new URL('notebooks/engine/', config.cacheDir)));
  engine.site = join(root, '_build/site');
  engine.configFile = resolve(pathOf(options.myst?.config ?? new URL('myst.yml', config.root)));
  if (dirname(engine.configFile) !== root) throw new Error('myst.config must be beside astro.config in the Astro project root so relative MyST paths retain their meaning');
  registry.set(root, engine);
  return engine;
}

export function getEngine(root) {
  const engine = registry.get(resolve(pathOf(root)));
  if (!engine) throw new Error('Register the astro-myst-notebooks integration before using its resolved-document loader.');
  return engine;
}

/** Run the public CLI; neither integration nor plugins access a MyST Session. */
export async function buildEngine(engine, { force = false } = {}) {
  if (engine.building) return engine.building;
  if (engine.manifest && !force) return engine;
  engine.manifest = undefined;
  engine.building = (async () => {
    const options = engine.options;
    const buildTimeout = options.myst?.buildTimeout ?? 180000;
    if (!Number.isFinite(buildTimeout) || buildTimeout <= 0) throw new Error('myst.buildTimeout must be positive milliseconds');
    const config = await exists(engine.configFile) ? parse(await readFile(engine.configFile, 'utf8')) : { version: 1, project: {} };
    if (config.site?.projects?.length > 1) throw new Error('The Astro adapter currently supports one MyST project per site.');
    const project = config.project ?? {};
    const files = await sourceFiles(engine.source);
    engine.sourcePaths = files;
    engine.routeByFile = new Map();
    for (const file of files) {
      const metadata = await sourceMetadata(file);
      const override = engine.sourceOverrides?.[posix(relative(engine.source, file))];
      const id = String(override?.id ?? metadata.slug ?? posix(relative(engine.source, file)).replace(/\.(md|ipynb)$/, '').replace(/(^|\/)index$/, ''));
      engine.routeByFile.set(resolve(file), id);
    }
    const api = await prepareApi({ root: engine.root, cache: engine.cache, api: options.api,
      python: options.execution?.python, sources: files });
    for (const [file, id] of api.routeByFile) engine.routeByFile.set(file, id);
    engine.dependencies = api.dependencies;
    const plugin = join(engine.cache, 'plugins.mjs');
    const settings = { root: engine.root, ...options.execution, cwd: pathOf(options.execution?.cwd ?? engine.root),
      dependencies: options.execution?.dependencies?.map(pathOf),
      pixi: options.execution?.pixi && { ...options.execution.pixi, manifest: pathOf(options.execution.pixi.manifest) },
      cacheDir: join(engine.cache, 'execution') };
    await writeChanged(plugin, `import {createDocumentExecution} from ${JSON.stringify(new URL('./execution.mjs', import.meta.url).href)};\nimport {createProvenance} from ${JSON.stringify(new URL('./provenance.mjs', import.meta.url).href)};\n${api.pluginOptions ? `import {createAutodoc} from ${JSON.stringify(new URL('./autodoc/index.mjs', import.meta.url).href)};\n` : ''}const execution=createDocumentExecution(${JSON.stringify(settings)});\nconst provenance=createProvenance(${JSON.stringify({ root: pathOf(options.execution?.cwd ?? engine.root), generated: api.pages.map(page => page.file) })});\nconst plugins=[${api.pluginOptions ? `createAutodoc(${JSON.stringify(api.pluginOptions)}),` : ''}provenance,execution];\nexport default {name:'Astro MyST pipeline',directives:plugins.flatMap(p=>p.directives??[]),roles:plugins.flatMap(p=>p.roles??[]),transforms:[...plugins.flatMap(p=>p.transforms??[]),{name:'astro-engine-contract',stage:'document',plugin:()=>async(tree,file)=>{tree.data={...tree.data,astroEngine:{version:1}}}}]};\n`);
    // Keep the generated config beside the authored config so its relative paths
    // retain their meaning. It is generated input, never a replacement for myst.yml.
    const generated = join(engine.root, '.astro-myst.generated.yml');
    const toc = [...(project.toc ?? files.map(file => ({ file: posix(relative(engine.root, file)) }))),
      ...(api.toc.length ? [{ title: 'Python API', children: api.toc }] : [])];
    if (!toc.length) throw new Error(`No MyST documents found in ${engine.source}`);
    const template = join(engine.cache, 'template');
    await writeChanged(join(template, 'template.yml'), 'myst: v1\nkind: site\ntitle: Astro document data\nversion: 1.0.0\nlicense: BSD-2-Clause\n');
    await writeChanged(generated, stringify({ ...config, version: config.version ?? 1,
      project: { ...project, toc, plugins: [...(project.plugins ?? []), plugin] },
      site: { ...config.site, template, options: { ...config.site?.options, folders: true } },
    }));
    // A fresh public directory prevents obsolete source exports or assets from
    // being published by a later build. Execution cache lives elsewhere.
    await rm(join(engine.site, 'public'), { recursive: true, force: true });
    await rm(join(engine.site, 'content'), { recursive: true, force: true });
    const manifestPath = require.resolve('mystmd/package.json');
    const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
    const cli = join(dirname(manifestPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.myst);
    await new Promise((resolveBuild, reject) => {
      const child = spawn(process.execPath, [cli, '--config', '.astro-myst.generated.yml', 'build', '--site', '--strict'], {
        cwd: engine.root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let output = '', timedOut = false, killTimer;
      const collect = chunk => { output = (output + chunk).slice(-1024 * 1024); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const stop = signal => {
        try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop('SIGTERM');
        killTimer = setTimeout(() => stop('SIGKILL'), 2000);
      }, buildTimeout);
      child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (timedOut) reject(new Error(`MyST project build deadline exceeded (${buildTimeout} ms):\n${output}`));
        else code === 0 ? resolveBuild() : reject(new Error(`MyST document build failed (${code}):\n${output}`));
      });
    });
    const manifest = JSON.parse(await readFile(join(engine.site, 'config.json'), 'utf8'));
    if (manifest.version !== 3) throw new Error(`Unsupported MyST manifest version ${manifest.version}`);
    engine.routes = new Map();
    const contentRoutes = new Map();
    const prefix = String(engine.base ?? '/').replace(/\/$/, '');
    for (const name of await readdir(join(engine.site, 'content'))) {
      if (!name.endsWith('.json')) continue;
      const path = join(engine.site, 'content', name);
      const page = JSON.parse(await readFile(path, 'utf8'));
      if (page.mdast?.data?.astroEngine?.version !== 1) throw new Error(`MyST did not apply the Astro document plugin: ${page.location}`);
      await finalizeOrigins(page.mdast, { root: pathOf(options.execution?.cwd ?? engine.root) });
      await writeFile(path, JSON.stringify(page));
      const file = resolve(engine.root, page.location.replace(/^\//, ''));
      const id = engine.routeByFile.get(file) ?? page.slug;
      const url = `${prefix}/${id}${id && engine.trailingSlash !== 'never' ? '/' : ''}`;
      contentRoutes.set(`/content/${name}`, url);
      engine.routes.set(page.slug, url);
    }
    const xrefPath = join(engine.site, 'myst.xref.json');
    const xrefs = JSON.parse(await readFile(xrefPath, 'utf8'));
    for (const ref of xrefs.references ?? []) {
      const url = contentRoutes.get(ref.data);
      if (url) { engine.routes.set(ref.url, url); ref.url = url; }
    }
    await writeFile(xrefPath, JSON.stringify(xrefs));
    engine.routes.set('', `${prefix}/`);
    const inventory = new Inventory({ path: join(engine.site, 'objects.inv') });
    await inventory.load();
    for (const entries of Object.values(inventory.data)) for (const entry of Object.values(entries)) {
      const [page, fragment] = entry.location.split('#');
      const url = engine.routes.get('/' + page.replace(/^\//, '').replace(/\/$/, '')) ?? engine.routes.get(page);
      if (url) entry.location = url.slice(prefix.length).replace(/^\//, '') + (fragment ? '#' + fragment : '') || './';
    }
    inventory.write(join(engine.site, 'objects.inv'));
    if (api.pluginOptions) {
      const { augmentInventory } = await import('./autodoc/inventory.mjs');
      await augmentInventory({ site: engine.site, base: engine.base });
    }
    const publicRoot = join(engine.site, 'public');
    const publicPaths = JSON.parse(await readFile(join(engine.site, 'public.json'), 'utf8'));
    const publicAssets = new Map();
    for (const path of publicPaths) {
      const file = resolve(publicRoot, path.replace(/^\//, ''));
      if (!file.startsWith(publicRoot + sep)) throw new Error(`Invalid MyST public asset path: ${path}`);
      publicAssets.set(new URL(path, 'http://localhost').pathname, file);
    }
    engine.publicAssets = publicAssets;
    engine.manifest = manifest;
    engine.revision++;
    return engine;
  })();
  try { return await engine.building; } finally { engine.building = undefined; }
}

export async function enginePages(engine) {
  await buildEngine(engine);
  const pages = [];
  for (const name of await readdir(join(engine.site, 'content'))) {
    if (!name.endsWith('.json')) continue;
    const page = JSON.parse(await readFile(join(engine.site, 'content', name), 'utf8'));
    const file = resolve(engine.root, page.location.replace(/^\//, ''));
    // MyST may include dependency documents in its build. Only TOC pages are
    // routes, and no emitted slug is allowed to overwrite an engine asset.
    const project = engine.manifest.projects[0];
    if (page.slug !== project.index && !project.pages.some(entry => entry.slug === page.slug)) continue;
    const id = engine.routeByFile.get(file) ?? page.slug;
    if (pages.some(entry => entry.id === id)) throw new Error(`Duplicate Astro document route: ${id}`);
    const frontmatter = await sourceMetadata(file);
    pages.push({ id, file, page, frontmatter });
  }
  engine.pages = pages;
  return pages;
}

export async function publishEngine(engine, destination) {
  const { cp } = await import('node:fs/promises');
  const out = pathOf(destination);
  // Keep machine-readable documents in their own namespace: a page called
  // config cannot overwrite the site's manifest or static assets.
  await mkdir(join(out, '_myst'), { recursive: true });
  await cp(join(engine.site, 'content'), join(out, '_myst/content'), { recursive: true });
  await cp(join(engine.site, 'config.json'), join(out, '_myst/config.json'));
  if (await exists(join(engine.site, 'public'))) await cp(join(engine.site, 'public'), out, { recursive: true });
  await cp(join(engine.site, 'objects.inv'), join(out, 'objects.inv'));
  const prefix = String(engine.base ?? '/').replace(/\/$/, '');
  const xrefs = JSON.parse(await readFile(join(engine.site, 'myst.xref.json'), 'utf8'));
  for (const ref of xrefs.references ?? []) {
    if (ref.data?.startsWith('/content/')) ref.data = ref.data.replace('/content/', '/_myst/content/');
    // A MyST consumer appends these paths to the project URL, which already
    // includes the deployment prefix.
    if (prefix && ref.url?.startsWith(`${prefix}/`)) ref.url = ref.url.slice(prefix.length);
  }
  await writeFile(join(out, 'myst.xref.json'), JSON.stringify(xrefs));

  const searchPath = join(engine.site, 'myst.search.json');
  if (await exists(searchPath)) {
    const search = JSON.parse(await readFile(searchPath, 'utf8'));
    for (const record of search.records) {
      const [path, fragment] = record.url.split('#', 2);
      const url = engine.routes.get(path) ?? engine.routes.get(path.slice(1));
      if (url) record.url = fragment ? `${url}#${fragment}` : url;
    }
    await writeFile(join(out, 'myst.search.json'), JSON.stringify(search));
  }
}
