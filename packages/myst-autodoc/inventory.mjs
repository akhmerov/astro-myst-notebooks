import { readFile, rename } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { Inventory } from 'intersphinx';

/** Augment a completed MyST site inventory, using resolved targets and URLs. */
export async function augmentInventory({ site = '_build/site', destinations = [], base = '/' } = {}) {
  site = resolve(site);
  const inventory = new Inventory({ path: join(site, 'objects.inv') });
  await inventory.load();
  const xrefs = JSON.parse(await readFile(join(site, 'myst.xref.json'), 'utf8'));
  const prefix = base.replace(/^\/+|\/+$/g, '');
  const relativeUrl = value => {
    if (/^[a-z]+:/i.test(value) || value.startsWith('//')) throw new Error(`Expected a local MyST URL: ${value}`);
    let url = value.replace(/^\/+/, '');
    if (prefix && value.startsWith('/') && (url === prefix || url.startsWith(prefix + '/'))) {
      url = url.slice(prefix.length).replace(/^\/+/, '');
    }
    return url;
  };
  // All entries, including generic document targets, must work below a URL prefix.
  for (const entries of Object.values(inventory.data)) for (const entry of Object.values(entries)) {
    entry.location = relativeUrl(entry.location) || './';
  }
  const symbols = new Map();
  const files = [...new Set(xrefs.references.map(ref => ref.data).filter(Boolean))];
  for (const data of files) {
    const path = resolve(site, data.replace(/^\/+/, ''));
    if (relative(site, path).startsWith('..')) throw new Error(`MyST content path escapes site: ${data}`);
    const page = JSON.parse(await readFile(path, 'utf8'));
    function walk(node) {
      const obj = node.data?.pythonObject;
      if (obj) {
        if (obj.version !== 1) throw new Error('Unsupported Python object metadata');
        const ref = xrefs.references.find(ref => ref.data === data && ref.identifier === node.identifier);
        if (!ref || !node.html_id) throw new Error(`Missing resolved target for ${obj.name}`);
        const location = `${relativeUrl(ref.url)}#${node.html_id}`;
        for (const name of obj.aliases) {
          const entry = { name, type: `py:${obj.kind}`, location, display: name };
          if (symbols.has(name) && symbols.get(name).location !== location) throw new Error(`Ambiguous Python target: ${name}`);
          symbols.set(name, entry);
        }
      }
      for (const child of node.children ?? []) walk(child);
    }
    walk(page.mdast);
  }
  for (const entry of symbols.values()) {
    const existing = inventory.data[entry.type]?.[entry.name];
    if (existing && existing.location !== entry.location) throw new Error(`Conflicting inventory target: ${entry.name}`);
    inventory.setEntry(entry);
  }
  for (const path of [join(site, 'objects.inv'), ...destinations.map(path => resolve(path))]) {
    inventory.write(path + '.tmp');
    await rename(path + '.tmp', path);
  }
  return [...symbols.values()];
}
