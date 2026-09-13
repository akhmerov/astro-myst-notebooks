import { Inventory } from 'intersphinx';
import { SphinxTransformer } from 'myst-transforms';
import { refRole } from 'myst-roles';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';

// Reuse MyST's explicit-title parsing, retaining case in Python object names.
/** @type {typeof import('myst-roles').refRole} */
export const autolinkRole = {
  ...refRole, name: 'autolink', alias: [],
  run(data) {
    const [reference] = refRole.run(data);
    const label = reference.label;
    const short = label.startsWith('~');
    const target = short ? label.slice(1) : label;
    return [{ type: 'link', url: `xref:auto#${target}`, children: reference.children ?? [
      { type: 'inlineCode', value: short ? target.split('.').at(-1) : target },
    ] }];
  },
};

/** One download per configured inventory per build; an explicit disk cache for offline builds. */
export async function loadInventory(id, options, cacheDir) {
  let source;
  if (options.file) source = fileURLToPath(new URL(options.file));
  else {
    const digest = createHash('sha256').update(options.url).digest('hex');
    const destination = new URL(`${digest}.inv`, cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const cached = await readFile(destination).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!cached || options.refresh) {
      const response = await fetch(options.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Inventory ${id}: HTTP ${response.status}`);
      const temporary = fileURLToPath(destination) + '.tmp';
      await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
      // Validate before publishing a cached file.
      await new Inventory({ path: temporary }).load();
      await rename(temporary, destination);
    }
    source = fileURLToPath(destination);
  }
  const inventory = new Inventory({ id, path: source });
  await inventory.load();
  // Inventory's public path is also the base URL of resolved references.
  inventory.path = (options.base ?? new URL('.', options.url).href).replace(/\/$/, '') || '/';
  return inventory;
}

export function remarkReferences({ references = {}, localInventory, cacheDir } = {}) {
  let loaded;
  return async (tree, file) => {
    const links = [];
    visit(tree, 'link', node => { if (node.url?.startsWith('xref:')) links.push(node); });
    if (!links.length) return;
    try {
      loaded ??= Promise.all([
        ...(localInventory ? [loadInventory('local', { file: localInventory, base: '/' }, cacheDir)] : []),
        ...Object.entries(references).map(([id, options]) => loadInventory(id, options, cacheDir)),
      ]).catch(error => { loaded = undefined; throw error; });
      const inventories = await loaded;
      const transformer = new SphinxTransformer(inventories.map(value => ({
        key: value.id, kind: 'intersphinx', url: value.path, value,
      })));
      for (const link of links) {
        const url = new URL(link.url);
        const name = decodeURIComponent(url.hash.slice(1));
        if (url.pathname === 'auto') {
          // Local definitions take precedence; external ambiguity is an error.
          const matches = inventories.filter(inv => inv.getEntry({ name }));
          const match = matches.find(inv => inv.id === 'local') ?? (matches.length === 1 ? matches[0] : undefined);
          if (!match) file.fail(matches.length ? `Ambiguous API reference: ${name}; use xref:PROJECT#${name}` : `Unknown API reference: ${name}`);
          link.url = `xref:${match.id}#${name}`;
        }
        const project = inventories.find(inv => inv.id === new URL(link.url).pathname);
        if (!project) file.fail(`Unknown reference inventory: ${link.url}`);
        // Preserve the object's name when the inventory has no display label.
        if (!link.children?.length && name) link.children = [{ type: 'text', value: project.getEntry({ name })?.display ?? name }];
        if (!transformer.transform(link, file)) file.fail(`Unresolved reference: ${link.url}`);
        if (project.id === 'local' && link.url.startsWith('//')) link.url = link.url.slice(1);
      }
    } catch (error) { file.fail(error.message); }
  };
}
