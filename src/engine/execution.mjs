import { readFile, writeFile, readdir, mkdir, rename, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { visit } from 'unist-util-visit';
import { executeDocument } from '../jupyter.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ignored = new Set(['.git', '.pixi', '.astro', 'node_modules', '_build', 'dist', '__pycache__', '.venv']);
const environmentFiles = new Set(['pixi.lock', 'pixi.toml', 'pyproject.toml', 'environment.yml', 'environment.yaml', 'requirements.txt']);
const digest = value => createHash('sha256').update(value).digest('hex');
const asPath = value => value instanceof URL ? fileURLToPath(value) : value;
const adapterVersion = digest(readFileSync(new URL('../execute.py', import.meta.url)));
const pools = new Map();

export const isExecutionDependencyFile = name => name.endsWith('.py') || environmentFiles.has(basename(name));

/** Read authored page metadata; MyST does not pass resolved settings to plugins. */
export async function readPageMetadata(filePath) {
  const source = await readFile(filePath, 'utf8');
  const frontmatter = text => {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const value = match ? parse(match[1]) : {};
    if (!object(value)) throw new Error(`Page frontmatter must be an object: ${filePath}`);
    return value;
  };
  if (!filePath.endsWith('.ipynb')) return frontmatter(source);
  const notebook = JSON.parse(source);
  const first = notebook.cells?.find(cell => cell.cell_type === 'markdown');
  return { ...notebook.metadata, ...frontmatter(Array.isArray(first?.source) ? first.source.join('') : first?.source ?? '') };
}

function settings(page, defaults) {
  if (page.execute !== undefined && !object(page.execute)) throw new Error('execute must be an object');
  const execute = { ...page.execute };
  for (const key of Object.keys(execute)) {
    if (!['skip', 'cache', 'depends_on_env'].includes(key)) throw new Error(`Unsupported nbclient execute.${key}`);
  }
  for (const key of ['skip', 'cache']) {
    if (execute[key] !== undefined && typeof execute[key] !== 'boolean') throw new Error(`execute.${key} must be a boolean`);
  }
  if (page.skip_execution !== undefined && typeof page.skip_execution !== 'boolean') throw new Error('skip_execution must be a boolean');
  // Match MyST's documented alias precedence: explicit execute.skip wins.
  execute.skip ??= page.skip_execution ?? defaults.skip;
  execute.cache ??= true;
  if (execute.depends_on_env !== undefined && (!Array.isArray(execute.depends_on_env) || execute.depends_on_env.some(name => typeof name !== 'string' || !name))) {
    throw new Error('execute.depends_on_env must be a list of environment variable names');
  }
  const kernel = page.kernelspec ?? page.jupyter?.kernelspec;
  if (kernel !== undefined && !object(kernel)) throw new Error('kernelspec must be an object');
  if (kernel?.language && !['python', 'python3', 'ipython3'].includes(kernel.language)) throw new Error(`Unsupported execution language: ${kernel.language}`);
  if (kernel?.name && !['python', 'python3', 'ipython3'].includes(kernel.name)) {
    throw new Error(`Unsupported kernelspec.name: ${kernel.name}; nbclient uses the selected Pixi Python interpreter`);
  }
  const custom = page.options ?? page.site ?? {};
  return { ...execute, presentation: custom.presentation ?? page.presentation, thebe: custom.thebe ?? page.thebe };
}

async function dependencyDigest(roots) {
  const hash = createHash('sha256');
  const seen = new Set();
  async function scan(path, explicit = false) {
    const full = resolve(path);
    if (seen.has(full)) return;
    seen.add(full);
    const info = await stat(full);
    if (info.isDirectory()) {
      for (const item of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.isSymbolicLink() || ignored.has(item.name)) continue;
        if (item.isDirectory() || item.name.endsWith('.py') || environmentFiles.has(item.name) || explicit) await scan(join(full, item.name), explicit);
      }
    } else if (explicit || full.endsWith('.py') || environmentFiles.has(basename(full))) {
      hash.update(full); hash.update(await readFile(full));
    }
  }
  for (const { path, explicit } of roots) await scan(path, explicit);
  return hash.digest('hex');
}

function pool(root, concurrency) {
  const key = `${root}:${concurrency}`;
  if (pools.has(key)) return pools.get(key);
  let active = 0;
  const queue = [];
  const run = async callback => {
    if (active >= concurrency) await new Promise(resolve => queue.push(resolve));
    else active++;
    try { return await callback(); }
    finally {
      if (queue.length) queue.shift()();
      else active--;
    }
  };
  pools.set(key, run);
  return run;
}

/**
 * nbclient execution for MyST's document transform. Python sources under the
 * project/kernel cwd are cache inputs; external/data inputs must be listed in
 * dependencies or represented by execute.depends_on_env. Cache entries contain
 * successful outputs only and live outside MyST's public site assets.
 */
export function createDocumentExecution({ root = process.cwd(), python = 'python', timeout = 30,
  cwd, pixi, skip = false, concurrency = 1, cacheDir, dependencies = [], deadline,
  runDocument = executeDocument } = {}) {
  root = resolve(asPath(root));
  const workdir = cwd && resolve(root, asPath(cwd));
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Execution timeout must be positive seconds');
  if (typeof skip !== 'boolean') throw new Error('Execution skip must be a boolean');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Execution concurrency must be a positive integer');
  if (!Array.isArray(dependencies)) throw new Error('Execution dependencies must be a list of file or directory paths');
  const directory = resolve(root, asPath(cacheDir) ?? '.astro/nbclient');
  const memory = new Map();
  const limited = pool(root, concurrency);
  return {
    name: 'nbclient document execution',
    transforms: [{ name: 'nbclient-execution', stage: 'document', plugin: () => async (tree, file) => {
      const page = await readPageMetadata(file.path);
      let policy;
      try { policy = settings(page, { skip }); }
      catch (error) { file.fail(error.message); }
      tree.data = { ...tree.data, astroNotebook: { presentation: policy.presentation, thebe: policy.thebe } };
      const items = [];
      const targets = new Map();
      visit(tree, ['block', 'inlineExpression'], node => {
        if (node.type === 'block' && node.kind !== 'notebook-code') return;
        const code = node.type === 'block' ? node.children?.find(child => child.type === 'code') : node;
        if (!code) file.fail('Notebook block has no executable source');
        if (code.lang && !['python', 'python3', 'ipython3', 'pycon'].includes(code.lang)) file.fail(`Unsupported execution language: ${code.lang}`);
        const tags = node.data?.astroNotebookTags ?? node.data?.tags ?? [];
        if (policy.skip || tags.includes('skip-execution')) {
          if (node.type === 'inlineExpression') file.fail('Inline expressions need execution; remove execute.skip or the {eval} roles');
          const outputs = node.children?.find(child => child.type === 'outputs');
          if (outputs) outputs.children = [];
          return;
        }
        const id = digest(`${file.path}:${items.length}:${code.value}`).slice(0, 32);
        items.push({ id, kind: node.type === 'inlineExpression' ? 'expression' : 'cell', source: code.value, tags, origin: code.data?.origin });
        targets.set(id, node);
      });
      if (!items.length) return;
      const executionCwd = page.kernelspec || page.jupyter?.kernelspec ? dirname(file.path) : workdir ?? dirname(file.path);
      // Scan declared inputs first. A directory already visited by implicit
      // Python-only discovery would otherwise hide its non-Python files.
      const roots = [
        ...dependencies.map(path => ({ path: resolve(root, asPath(path)), explicit: true })),
        { path: root }, ...(executionCwd === root ? [] : [{ path: executionCwd }]),
      ];
      const inputs = await dependencyDigest(roots);
      const key = digest(JSON.stringify({ version: 1, adapterVersion, file: file.path,
        items: items.map(({ origin, ...item }) => item), python, cwd: executionCwd, timeout, deadline, pixi,
        inputs, environment: (policy.depends_on_env ?? []).map(name => [name, process.env[name] ?? null]) }));
      const cachePath = join(directory, `${key}.json`);
      const validResponse = result => {
        const expected = items.filter(item => item.kind === 'cell');
        return Array.isArray(result?.notebook?.cells) && result.notebook.cells.length === expected.length
          && result.notebook.cells.every((cell, index) => cell.id === expected[index].id && Array.isArray(cell.outputs))
          && object(result.expressions) && items.filter(item => item.kind === 'expression').every(item => result.expressions[item.id]?.data);
      };
      const load = async () => {
        if (policy.cache) {
          try {
            const cached = JSON.parse(await readFile(cachePath, 'utf8'));
            if (cached.key === key && validResponse(cached.response)) return cached.response;
          } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        }
        const result = await limited(() => runDocument(items, { python, timeout, cwd: executionCwd, pixi, deadline }));
        if (!validResponse(result)) throw new Error('Invalid nbclient execution response');
        if (policy.cache) {
          await mkdir(directory, { recursive: true });
          const temporary = `${cachePath}.${randomUUID()}.tmp`;
          try { await writeFile(temporary, JSON.stringify({ key, response: result })); await rename(temporary, cachePath); }
          finally { await rm(temporary, { force: true }); }
          const entries = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
          if (entries.length > 128) {
            const dated = await Promise.all(entries.map(async name => ({ name, time: (await stat(join(directory, name))).mtimeMs })));
            for (const entry of dated.sort((a, b) => a.time - b.time).slice(0, dated.length - 128)) await rm(join(directory, entry.name), { force: true });
          }
        }
        return result;
      };
      let response;
      try {
        if (!policy.cache) response = structuredClone(await load());
        else {
          if (!memory.has(key)) memory.set(key, load());
          response = structuredClone(await memory.get(key));
          if (memory.size > 128) memory.delete(memory.keys().next().value);
        }
      } catch (error) {
        memory.delete(key);
        file.fail(`${error.cell?.origin?.file ?? file.path}: ${error.message}`, error.cell?.origin?.position);
      }
      for (const item of items.filter(item => item.kind === 'expression')) {
        const result = response.expressions[item.id];
        if (!result) file.fail(`Missing computed inline expression: ${item.source}`);
        targets.get(item.id).result = { status: 'ok', data: result.data, metadata: result.metadata };
      }
      for (const cell of response.notebook.cells) {
        const block = targets.get(cell.id);
        if (!block || block.type !== 'block') file.fail(`Unexpected computed cell: ${cell.id}`);
        let outputs = block.children.find(child => child.type === 'outputs');
        if (!outputs) { outputs = { type: 'outputs', children: [] }; block.children.push(outputs); }
        outputs.children = cell.outputs.map((bundle, index) => ({ type: 'output', children: [], jupyter_data: bundle,
          ...(outputs.identifier ? { identifier: `${outputs.identifier}-${index}` } : {}) }));
      }
    } }],
  };
}
