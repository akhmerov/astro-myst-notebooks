import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { finalizeOrigins } from './provenance.mjs';
import { Inventory } from 'intersphinx';
import { readPageMetadata } from './execution.mjs';
import { prepareApi } from './api.mjs';
import { isDocumentPath, localTarget } from './document-inputs.mjs';
import { visit } from 'unist-util-visit';

const require = createRequire(import.meta.url);
const registry = globalThis[Symbol.for('astro-myst-notebooks.engines')] ??= new Map();
const pathOf = value => value instanceof URL ? fileURLToPath(value) : value;
const posix = value => value.split(sep).join('/');
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const isProjectPage = (project, slug) => slug === project.index || project.pages.some(entry => entry.slug === slug);

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
  const isIndex = path => dirname(path) === root && /(?:^|\/)index\.(?:md|ipynb)$/.test(posix(path));
  return files.sort((a, b) => Number(isIndex(b)) - Number(isIndex(a)) || a.localeCompare(b));
}

export function registerEngine(config, options = {}, logger) {
  const root = resolve(pathOf(config.root));
  const previous = registry.get(root);
  const engine = previous ?? { root, revision: 0 };
  engine.options = options;
  engine.logger = logger;
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

function resolveDocumentDownloads(documents, root) {
  const routes = new Map(documents.filter(entry => entry.published).map(entry => [entry.file, entry.url]));
  const includes = new Map();
  const anchors = new Map();
  for (const { page, file, url, published } of documents) {
    if (!published) continue;
    const bySource = new Map();
    anchors.set(url, bySource);
    function walk(node, source) {
      if (node.type === 'include') {
        const target = localTarget(root, source, node.file);
        if (target && !node.literal) {
          source = target.path;
          if (!includes.has(source)) includes.set(source, new Set());
          includes.get(source).add(url);
        }
      }
      const id = node.html_id ?? (node.type === 'heading' ? node.identifier : undefined);
      if (id) {
        if (!bySource.has(source)) bySource.set(source, new Set());
        bySource.get(source).add(id);
      }
      for (const child of node.children ?? []) walk(child, source);
    }
    walk(page.mdast, file);
  }
  const obsolete = new Set(), used = new Set();
  for (const { page, file, published } of documents) {
    visit(page.mdast, node => {
      if (published && ['link', 'card'].includes(node.type) && node.static && !node.data?.astroExplicitDownload && node.urlSource) {
        const target = localTarget(root, file, node.urlSource);
        if (target && isDocumentPath(target.path)) {
          const owners = includes.get(target.path);
          const destination = routes.get(target.path) ?? (owners?.size === 1 ? owners.values().next().value : undefined);
          const fail = reason => {
            const origin = node.data?.origin;
            throw new Error(`Unresolved local MyST document link: ${node.urlSource} (${reason}) at ${origin?.file ?? relative(root, file)}:${origin?.position?.start.line ?? node.position?.start.line ?? 1}`);
          };
          if (!destination) fail(owners?.size ? 'included on multiple pages' : 'no published page or include; use {download} for a source file');
          // MyST collapses repeated hyphens in heading ids, unlike the slugs
          // used by GitHub Markdown. Keep an exact id whenever one exists.
          const [, query, fragment] = /^([^#]*)#(.+)$/.exec(target.suffix) ?? [];
          const ids = anchors.get(destination)?.get(target.path);
          let suffix = target.suffix;
          if (fragment) {
            let decoded;
            try { decoded = decodeURIComponent(fragment); } catch { fail('malformed fragment'); }
            if (!ids?.has(decoded)) {
              const normalized = decoded.replace(/-{2,}/g, '-');
              if (!ids?.has(normalized)) fail(`fragment #${fragment} is absent from ${destination}`);
              suffix = query + '#' + encodeURIComponent(normalized);
            }
          }
          obsolete.add(node.url);
          node.url = destination + suffix;
          delete node.static;
          delete node.protocol;
        }
      }
      for (const value of [node.url, node.src]) if (typeof value === 'string') used.add(value.split(/[?#]/, 1)[0]);
    });
  }
  return [...obsolete].filter(url => !used.has(url));
}

function unreferencedPageSources(documents, manifest) {
  const candidates = new Set();
  for (const { page, file } of documents) {
    // MyST prepends a source download to each page's authored exports.
    const exports = page.frontmatter?.exports;
    const source = exports?.[0];
    if (source?.filename !== basename(file) || source.format !== extname(file).slice(1)) continue;
    candidates.add(source.url);
    exports.shift();
  }
  function retainReferences(value) {
    if (typeof value === 'string' && value.startsWith('/')) {
      candidates.delete(value.split(/[?#]/, 1)[0]);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) retainReferences(child);
    }
  }
  for (const { page } of documents) retainReferences(page);
  retainReferences(manifest);
  return candidates;
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
    for (const diagnostic of api.diagnostics ?? []) engine.logger?.warn(diagnostic.message);
    for (const [file, id] of api.routeByFile) engine.routeByFile.set(file, id);
    engine.dependencies = api.dependencies;
    const plugin = join(engine.cache, 'plugins.mjs');
    const settings = { root: engine.root, ...options.execution, cwd: pathOf(options.execution?.cwd ?? engine.root),
      dependencies: options.execution?.dependencies?.map(pathOf),
      pixi: options.execution?.pixi && { ...options.execution.pixi, manifest: pathOf(options.execution.pixi.manifest) },
      cacheDir: join(engine.cache, 'execution') };
    const repositoryLinks = options.myst?.repositoryLinks;
    if (repositoryLinks) {
      for (const url of [repositoryLinks.files, repositoryLinks.directories].filter(value => value !== undefined)) {
        if (!/^https?:\/\//i.test(url)) throw new Error('myst.repositoryLinks URLs must use HTTP or HTTPS');
      }
    }
    const from = name => JSON.stringify(new URL(name, import.meta.url).href);
    await writeChanged(plugin, `import {createDocumentExecution} from ${from('./execution.mjs')};
import {createProvenance} from ${from('./provenance.mjs')};
import {createDocumentInputs, createDoiLinkPolicy} from ${from('./document-inputs.mjs')};
${api.pluginOptions ? `import {createAutodoc} from ${from('./autodoc/index.mjs')};\n` : ''}
const execution = createDocumentExecution(${JSON.stringify(settings)});
const provenance = createProvenance(${JSON.stringify({ root: pathOf(options.execution?.cwd ?? engine.root), generated: api.pages.map(page => page.file) })});
const inputs = createDocumentInputs(${JSON.stringify(engine.root)}, ${JSON.stringify(repositoryLinks && { ...repositoryLinks, root: fileURLToPath(repositoryLinks.root) })}, ${JSON.stringify(repositoryLinks?.directories ? [...engine.routeByFile] : [])});
const plugins = [${api.pluginOptions ? `createAutodoc(${JSON.stringify(api.pluginOptions)}), ` : ''}inputs, provenance, execution${options.myst?.resolveDoiLinks === false ? ', createDoiLinkPolicy()' : ''}];
export default {
  name: 'Astro MyST pipeline',
  directives: plugins.flatMap(plugin => plugin.directives ?? []),
  roles: plugins.flatMap(plugin => plugin.roles ?? []),
  transforms: plugins.flatMap(plugin => plugin.transforms ?? []),
};
`);
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
      const guard = new URL('./parent-guard.mjs', import.meta.url);
      guard.searchParams.set('owner', String(process.pid));
      const child = spawn(process.execPath, ['--import', guard.href, cli, '--config', '.astro-myst.generated.yml', 'build', '--site', '--strict'], {
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
      const stopOnExit = () => stop('SIGTERM');
      process.once('exit', stopOnExit);
      const timer = setTimeout(() => {
        timedOut = true;
        stop('SIGTERM');
        killTimer = setTimeout(() => stop('SIGKILL'), 2000);
      }, buildTimeout);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.off('exit', stopOnExit);
      };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        if (timedOut) reject(new Error(`MyST project build deadline exceeded (${buildTimeout} ms):\n${output}`));
        else code === 0 ? resolveBuild() : reject(new Error(`MyST document build failed (${code}):\n${output}`));
      });
    });
    const manifest = JSON.parse(await readFile(join(engine.site, 'config.json'), 'utf8'));
    if (manifest.version !== 3) throw new Error(`Unsupported MyST manifest version ${manifest.version}`);
    engine.routes = new Map();
    const contentRoutes = new Map();
    const documentEntries = [];
    const documentInputs = new Set();
    const compiled = [];
    const prefix = String(engine.base ?? '/').replace(/\/$/, '');
    for (const name of await readdir(join(engine.site, 'content'))) {
      if (!name.endsWith('.json')) continue;
      const path = join(engine.site, 'content', name);
      const page = JSON.parse(await readFile(path, 'utf8'));
      if (page.mdast?.data?.astroEngine?.version !== 1) throw new Error(`MyST did not apply the Astro document plugin: ${page.location}`);
      for (const input of page.mdast.data.astroEngine.inputs) documentInputs.add(resolve(engine.root, input));
      delete page.mdast.data.astroEngine.inputs;
      await finalizeOrigins(page.mdast, { root: pathOf(options.execution?.cwd ?? engine.root) });
      const file = resolve(engine.root, page.location.replace(/^\//, ''));
      const id = engine.routeByFile.get(file) ?? page.slug;
      const url = `${prefix}/${id}${id && engine.trailingSlash !== 'never' ? '/' : ''}`;
      contentRoutes.set(`/content/${name}`, url);
      engine.routes.set(page.slug, url);
      const published = isProjectPage(manifest.projects[0], page.slug);
      compiled.push({ path, page, file, url, published });
      if (published) {
        const override = engine.sourceOverrides?.[posix(relative(engine.source, file))];
        documentEntries.push({ name: id || 'index', type: 'std:doc',
          display: override?.title ?? page.frontmatter?.title ?? (id || 'index'),
          location: url.slice(prefix.length + 1) || './' });
      }
    }
    const obsoleteDownloads = resolveDocumentDownloads(compiled, engine.root);
    const obsoleteSources = unreferencedPageSources(compiled, manifest);
    for (const { path, page } of compiled) await writeFile(path, JSON.stringify(page));
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
    inventory.data['std:doc'] = Object.create(null);
    for (const entries of Object.values(inventory.data)) for (const entry of Object.values(entries)) {
      const [page, fragment] = entry.location.split('#');
      const url = engine.routes.get('/' + page.replace(/^\//, '').replace(/\/$/, '')) ?? engine.routes.get(page);
      if (url) entry.location = url.slice(prefix.length).replace(/^\//, '') + (fragment ? '#' + fragment : '') || './';
    }
    for (const entry of documentEntries) {
      if (inventory.data['std:doc']?.[entry.name]) throw new Error(`Duplicate document inventory name: ${entry.name}`);
      inventory.setEntry(entry);
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
    for (const path of [...obsoleteDownloads, ...obsoleteSources]) {
      const file = publicAssets.get(path);
      if (!file) continue;
      await rm(file, { force: true });
      publicAssets.delete(path);
    }
    engine.publicAssets = publicAssets;
    engine.documentInputs = documentInputs;
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
    if (!isProjectPage(project, page.slug)) continue;
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
  if (await exists(join(engine.site, 'public'))) await cp(join(engine.site, 'public'), out, { recursive: true });
  await cp(join(engine.site, 'objects.inv'), join(out, 'objects.inv'));
  const prefix = String(engine.base ?? '/').replace(/\/$/, '');
  if (engine.options.myst?.publishContent !== false) {
    // Keep machine-readable documents separate from website routes.
    const content = join(out, '_myst/content');
    const source = join(engine.site, 'content');
    await mkdir(content, { recursive: true });
    if (engine.options.sourceMaps === false) {
      for (const name of await readdir(source)) {
        if (!name.endsWith('.json')) continue;
        const page = JSON.parse(await readFile(join(source, name), 'utf8'));
        visit(page.mdast, node => { if (node.data) delete node.data.origin; });
        await writeFile(join(content, name), JSON.stringify(page));
      }
    } else await cp(source, content, { recursive: true });
    await cp(join(engine.site, 'config.json'), join(out, '_myst/config.json'));
    const xrefs = JSON.parse(await readFile(join(engine.site, 'myst.xref.json'), 'utf8'));
    for (const ref of xrefs.references ?? []) {
      if (ref.data?.startsWith('/content/')) ref.data = ref.data.replace('/content/', '/_myst/content/');
      // Consumers append this path to the project URL and its deployment base.
      if (prefix && ref.url?.startsWith(`${prefix}/`)) ref.url = ref.url.slice(prefix.length);
    }
    await writeFile(join(out, 'myst.xref.json'), JSON.stringify(xrefs));
  }

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
