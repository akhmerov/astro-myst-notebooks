import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const moduleName = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;
const pathOf = value => value instanceof URL ? fileURLToPath(value) : value;
const ignored = new Set(['.git', '.astro', '.pixi', '_build', 'dist', 'node_modules', '__pycache__']);

/** Static extraction uses the consumer's selected Python, never imports the API. */
export async function extractApi({ modules, searchPaths, python = 'python', parser = 'numpy', markup = 'myst', documents = {}, docstringWarnings = 'error', timeout = 30000 }) {
  if (!Array.isArray(modules) || !modules.length || modules.some(name => typeof name !== 'string' || !moduleName.test(name))) {
    throw new Error('api.modules must be a nonempty list of Python module names');
  }
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('API extraction timeout must be positive milliseconds');
  return new Promise((resolveModel, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('./autodoc/extract.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostics = '', failed = false;
    const stop = message => { if (failed) return; failed = true; child.kill('SIGKILL'); reject(new Error(message)); };
    const timer = setTimeout(() => stop('Python API extraction deadline exceeded'), timeout);
    child.on('error', error => { clearTimeout(timer); stop(`Cannot start API extraction: ${error.message}`); });
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32 * 1024 * 1024) stop('Python API extraction exceeded its output limit'); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-32768); });
    child.on('close', code => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0) { reject(new Error(diagnostics.trim() || `API extraction exited ${code}`)); return; }
      try { const result = JSON.parse(output); if (result.version !== 1 || !result.objects) throw new Error('Unsupported API extraction format'); resolveModel(result); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', error => { clearTimeout(timer); stop(`API extraction input failed: ${error.message}`); });
    child.stdin.end(JSON.stringify({ modules, searchPaths, parser, markup, documents, docstringWarnings }));
  });
}

async function pythonSources(roots) {
  const paths = new Set();
  async function scan(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await scan(full);
      else if (entry.name.endsWith('.py')) paths.add(full);
    }
  }
  for (const root of roots) await scan(root);
  return [...paths];
}

/**
 * Generate stable API documents as ordinary MyST input. Returned routes retain
 * the public dotted Python namespace; aliases share a canonical object's page.
 * Authored autodoc placements own their targets and suppress duplicate pages.
 */
export async function prepareApi({ root, cache, api, python = 'python', sources = [] }) {
  if (!api) return { toc: [], routeByFile: new Map(), pages: [], pluginOptions: null, dependencies: [] };
  if (api.packages || api.runner) throw new Error('The API configuration changed: use api.modules and api.searchPaths instead of starlight-pydocs packages/runner');
  root = resolve(pathOf(root)); cache = resolve(pathOf(cache));
  if (api.python !== undefined && (typeof api.python !== 'string' || !api.python)) throw new Error('api.python must name an existing Python interpreter');
  const searchPaths = (api.searchPaths ?? ['.']).map(path => resolve(root, pathOf(path)));
  const pluginOptions = { modules: api.modules, searchPaths, python: api.python ?? python,
    parser: api.parser ?? 'numpy', markup: api.markup ?? 'myst', externalReferences: api.externalReferences ?? {}, documents: api.documents ?? {}, docstringWarnings: api.docstringWarnings ?? 'error' };
  const { objects } = await extractApi({ ...pluginOptions, timeout: api.timeout });
  const directory = join(cache, 'api'); await mkdir(directory, { recursive: true });
  const byName = new Map(Object.values(objects).flatMap(object => object.aliases.map(name => [name, object])));
  const authored = new Set();
  for (const file of sources) {
    let text = await readFile(file, 'utf8');
    if (file.endsWith('.ipynb')) {
      const notebook = JSON.parse(text); text = notebook.cells.filter(cell => cell.cell_type === 'markdown').map(cell => Array.isArray(cell.source) ? cell.source.join('') : cell.source).join('\n');
    }
    for (const match of text.matchAll(/(?:`{3,}|:{3,})\{autodoc\}\s+([\w.]+)([^]*?)(?=\n(?:`{3,}|:{3,})|$)/g)) {
      const object = byName.get(match[1]);
      if (!object) continue;
      authored.add(object.canonical);
      if (/:members:\s*\*/.test(match[2])) for (const member of object.members) if (objects[member]) authored.add(objects[member].canonical);
    }
  }
  const canonical = new Map();
  for (const object of Object.values(objects)) {
    if (!['module', 'class', 'function', 'data'].includes(object.kind) || authored.has(object.canonical)) continue;
    const leaf = object.canonical.split('.').at(-1);
    const publicName = object.aliases.filter(name => !name.split('.').some(part => part.startsWith('_')))
      .sort((a, b) => Number(b.split('.').at(-1) === leaf) - Number(a.split('.').at(-1) === leaf)
        || a.split('.').length - b.split('.').length || a.localeCompare(b))[0];
    if (!publicName) continue;
    const previous = canonical.get(object.canonical);
    if (!previous || publicName.length < previous.name.length) canonical.set(object.canonical, { ...object, name: publicName });
  }
  const pages = [], routeByFile = new Map();
  for (const object of [...canonical.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = `api/${object.name.replaceAll('.', '/')}`;
    const file = join(directory, `${object.name}.md`);
    const value = `---\n${stringify({ title: object.name, slug })}---\n\n:::{autodoc} ${object.name}\n${object.kind === 'class' ? ':members: *\n' : ''}:::\n`;
    if (await readFile(file, 'utf8').catch(() => null) !== value) await writeFile(file, value);
    const page = { file, slug, title: object.name, object: object.name, kind: object.kind };
    pages.push(page); routeByFile.set(file, slug);
  }
  // Remove only files owned by this generator, retaining user files elsewhere.
  const current = new Set(pages.map(page => page.file));
  for (const file of await readdir(directory)) {
    if (moduleName.test(file.replace(/\.md$/, '')) && file.endsWith('.md') && !current.has(join(directory, file))) await rm(join(directory, file));
  }
  const nodes = new Map(pages.map(page => [page.object, { file: page.file, children: [] }]));
  const toc = [];
  for (const page of pages) {
    const parent = page.object.split('.'); parent.pop();
    while (parent.length && !nodes.has(parent.join('.'))) parent.pop();
    const node = nodes.get(page.object);
    if (parent.length) nodes.get(parent.join('.')).children.push(node); else toc.push(node);
  }
  const stripEmpty = nodes => nodes.map(node => node.children.length ? { file: node.file, children: stripEmpty(node.children) } : { file: node.file });
  return { toc: stripEmpty(toc), routeByFile, pages, pluginOptions, dependencies: await pythonSources(searchPaths) };
}
