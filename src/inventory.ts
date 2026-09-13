import { Inventory } from 'intersphinx';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { documentTargets } from './documents.mjs';

/** Merge API and document inventories after the content collection is rendered. */
export async function exportInventory({ api, documents, root, destination, base = '/', labels = {} }: {
  api: URL; documents: URL; root: URL; destination: URL; base?: string;
  labels?: Record<string, { location: string; display: string }>;
}) {
  const inventory = new Inventory({ path: fileURLToPath(api) });
  await inventory.load();
  const routes: { name: string; title: string; path: string; url: string }[] = JSON.parse(await readFile(documents, 'utf8'));
  const seen = new Map<string, string>();
  for (const route of routes) {
    inventory.setEntry({ type: 'std:doc', name: route.name, display: route.title, location: route.url });
    for (const target of await documentTargets(await readFile(route.path, 'utf8'), route.path, fileURLToPath(root))) {
      const location = `${route.url}#${target.id}`;
      if (seen.has(target.name) && seen.get(target.name) !== location) throw new Error(`Ambiguous exported document label: ${target.name}`);
      seen.set(target.name, location);
      inventory.setEntry({ type: 'std:label', name: target.name, display: target.title, location });
    }
  }
  for (const [name, entry] of Object.entries(labels)) inventory.setEntry({ type: 'std:label', name, ...entry });
  // Public inventory URIs are relative to the inventory's directory. The
  // build-time local inventory instead resolves from the origin root.
  const prefix = base.replace(/^\/|\/$/g, '');
  for (const domain of Object.values(inventory.data)) for (const entry of Object.values(domain)) {
    let location = entry.location.replace(/^\//, '');
    if (prefix && location.startsWith(prefix + '/')) location = location.slice(prefix.length + 1);
    entry.location = location || './';
  }
  inventory.write(fileURLToPath(destination));
}
