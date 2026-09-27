import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadPythonInventory } from './references.mjs';

const pythonKinds = { func: ['function'], class: ['class'], meth: ['method'],
  attr: ['attribute', 'property'], mod: ['module'], data: ['data'], obj: null };
const text = value => ({ type: 'text', value });
const code = value => ({ type: 'inlineCode', value });
const anchor = name => `py-${Buffer.from(name).toString('hex')}`;

function walk(node, fn) {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

/** A MyST plugin factory. Python extraction is lazy, static, and cached per build. */
export function createAutodoc({ modules, searchPaths = ['.'], python = 'python',
  parser = 'numpy', markup = 'myst', externalReferences = {} } = {}) {
  if (!Array.isArray(modules) || !modules.length) throw new Error('autodoc requires modules');
  const config = { modules, searchPaths: searchPaths.map(path => resolve(path)), parser, markup };
  let objects;
  const byName = new Map();
  const placements = new Map();
  const inventories = new Map();
  function load() {
    if (objects) return;
    const result = spawnSync(python, [fileURLToPath(new URL('./extract.py', import.meta.url))], {
      input: JSON.stringify(config), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw new Error(`autodoc could not launch ${python}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'autodoc extraction failed');
    const model = JSON.parse(result.stdout);
    if (model.version !== 1) throw new Error('Unsupported autodoc model version');
    objects = model.objects;
    const identifiers = new Map();
    for (const obj of Object.values(objects)) for (const name of obj.aliases) {
      const previous = identifiers.get(name.toLowerCase());
      if (previous && previous !== obj.canonical) {
        throw new Error(`MyST labels are case insensitive: conflicting Python name ${name}`);
      }
      identifiers.set(name.toLowerCase(), obj.canonical);
      byName.set(name, objects[name] ?? obj);
    }
  }

  async function resolveReference(node, file) {
    load();
    let target = node.target.replace(/^~/, '').replace(/\(\)$/, '');
    const [head, ...tail] = target.split('.');
    if (node.scope?.[head]) target = [node.scope[head], ...tail].join('.');
    const obj = byName.get(target);
    if (obj) {
      const accepted = pythonKinds[node.role];
      if (accepted && !accepted.includes(obj.kind)) file.fail(`Python ${node.role} reference has wrong kind: ${target} (${obj.kind})`);
      return { type: 'crossReference', identifier: obj.canonical.toLowerCase(),
        label: obj.canonical, children: [code(node.title)] };
    }
    const prefix = Object.keys(externalReferences).sort((a, b) => b.length - a.length)
      .find(name => target === name || target.startsWith(name + '.'));
    if (prefix) {
      const url = externalReferences[prefix];
      if (!inventories.has(url)) inventories.set(url, loadPythonInventory(url));
      const inventory = await inventories.get(url);
      const accepted = pythonKinds[node.role];
      const matches = (inventory.get(target) ?? []).filter(entry => !accepted || accepted.includes(entry.kind));
      if (matches.length !== 1) file.fail(`${matches.length ? 'Ambiguous' : 'Missing'} external Python ${node.role} reference: ${target}`);
      return { type: 'link', url: matches[0].url, children: [code(node.title)] };
    }
    file.fail(`Unresolved Python reference: ${target}${node.source ? ` (${node.source.file}:${node.source.line})` : ''}`);
  }

  function render(obj, level, ctx, file, summary = false) {
    const prose = source => {
      const nodes = ctx.parseMyst(source).children;
      for (const node of nodes) walk(node, child => {
        // These locations belong to generated prose, not the directive's Markdown file.
        delete child.position;
        if (child.type === 'pythonReference') {
          child.scope = obj.scope;
          child.source = obj.source;
        }
      });
      return nodes;
    };
    const children = [{ type: 'heading', depth: level, identifier: obj.canonical.toLowerCase(),
      label: obj.canonical, html_id: anchor(obj.canonical), children: [code(obj.name)],
      data: { pythonObject: { version: 1, name: obj.name, canonical: obj.canonical,
        kind: obj.kind, aliases: obj.aliases, source: obj.source } } }];
    if (!summary) children.push({ type: 'code', lang: 'python', value: obj.overloads.length ? obj.overloads.join('\n') : obj.signature });
    for (const section of obj.sections) {
      if (section.kind === 'text') children.push(...prose(section.text));
      else if (section.kind === 'examples') {
        children.push({ type: 'paragraph', children: [{ type: 'strong', children: [text(section.title || 'Examples')] }] });
        for (const block of section.blocks) {
          if (block.kind === 'text') children.push(...prose(block.text));
          else if (block.kind === 'examples') children.push({ type: 'code', lang: 'pycon', value: block.text });
          else file.fail(`Unsupported example block: ${block.kind}`);
        }
      } else if (section.entries) {
        children.push({ type: 'paragraph', children: [{ type: 'strong', children: [text(section.title || section.kind[0].toUpperCase() + section.kind.slice(1))] }] });
        children.push({ type: 'list', ordered: false, spread: true, children: section.entries.map(entry => ({
          type: 'listItem', spread: true, children: [
            { type: 'paragraph', children: [code([entry.name, entry.annotation].filter(Boolean).join(': '))] },
            ...prose(entry.description),
          ],
        })) });
      } else if (['admonition', 'deprecated'].includes(section.kind)) {
        children.push({ type: 'blockquote', children: [
          { type: 'paragraph', children: [{ type: 'strong', children: [text(section.title || section.annotation || section.kind)] }] },
          ...prose(section.text),
        ] });
      } else file.fail(`Unsupported docstring section: ${section.kind}`);
    }
    return { type: 'pythonObject', canonical: obj.canonical, aliases: obj.aliases, children };
  }

  return {
    name: 'Python autodoc', license: 'BSD-2-Clause',
    directives: [{
      name: 'autodoc', doc: 'Document a Python object using static Griffe analysis.',
      arg: { type: String, required: true },
      options: {
        members: { type: String, doc: 'Comma-separated direct member names, or * for public members.' },
        'heading-level': { type: Number }, 'summary-only': { type: Boolean },
      },
      run(data, file, ctx) {
        load();
        const obj = byName.get(data.arg);
        if (!obj) file.fail(`Unknown Python object: ${data.arg}`);
        const level = data.options?.['heading-level'] ?? 2;
        if (!Number.isInteger(level) || level < 2 || level > 6) file.fail('autodoc heading-level must be 2–6');
        const selected = data.options?.members;
        if (selected && data.options?.['summary-only']) file.fail('autodoc members and summary-only cannot be combined');
        const nodes = [render(obj, level, ctx, file, data.options?.['summary-only'])];
        if (selected) {
          if (level === 6) file.fail('autodoc members need heading-level below 6');
          const members = selected.trim() === '*' ? obj.members : selected.split(',').map(name => `${obj.name}.${name.trim()}`);
          for (const name of members) {
            if (!obj.members.includes(name)) file.fail(`Unknown public member: ${name}`);
            nodes.push(render(objects[name], level + 1, ctx, file));
          }
        }
        return nodes;
      },
    }],
    roles: Object.keys(pythonKinds).map(role => ({
      name: `py:${role}`, alias: [role], body: { type: String, required: true },
      run(data) {
        const value = data.body.trim();
        const match = /^(.*?)\s+<([^>]+)>$/.exec(value);
        const target = match ? match[2] : value;
        const title = match ? match[1] : target.startsWith('~') ? target.slice(1).split('.').at(-1) : target;
        return [{ type: 'pythonReference', role, target, title }];
      },
    })),
    transforms: [{ name: 'python-autodoc', stage: 'document', plugin: () => async (tree, file) => {
      const local = new Set();
      const expand = async parent => {
        if (!parent.children) return;
        parent.children = await Promise.all(parent.children.map(async node => {
          if (node.type === 'pythonReference') return resolveReference(node, file);
          if (node.type === 'pythonObject') {
            const previous = placements.get(node.canonical);
            if (local.has(node.canonical) || (previous && previous !== file.path)) {
              file.fail(`Python object documented more than once: ${node.canonical}`);
            }
            local.add(node.canonical);
            placements.set(node.canonical, file.path);
            await expand(node);
            let block = { type: 'block', data: { autodocGenerated: true }, children: node.children };
            // Alias blocks expose ordinary MyST targets, including in myst.xref.json.
            for (const alias of node.aliases.filter(name => name.toLowerCase() !== node.canonical.toLowerCase())) {
              block = { type: 'block', data: { autodocGenerated: true }, identifier: alias.toLowerCase(), label: alias,
                html_id: anchor(alias), children: [block] };
            }
            return block;
          }
          if (node.children) await expand(node);
          return node;
        }));
      };
      await expand(tree);
    } }],
  };
}
