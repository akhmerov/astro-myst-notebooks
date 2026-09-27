import { inflateSync } from 'node:zlib';

/** Read Sphinx v2 inventories, preserving case in the `$` URI shorthand.
 * MyST 1.11's bundled reader lowercases it, breaking Python class anchors.
 */
export async function loadPythonInventory(base) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('External Python inventory requires an HTTP(S) URL');
  const inventoryUrl = url.pathname.endsWith('.inv') ? url : new URL('objects.inv', url.href.replace(/\/?$/, '/'));
  const response = await fetch(inventoryUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Unable to fetch Python inventory: ${inventoryUrl} (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  let offset = 0;
  const header = [];
  for (let i = 0; i < 4; i++) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error(`Invalid Sphinx inventory: ${inventoryUrl}`);
    header.push(buffer.subarray(offset, end).toString().trim());
    offset = end + 1;
  }
  if (header[0] !== '# Sphinx inventory version 2' || !header[3].includes('zlib')) {
    throw new Error(`Expected Sphinx v2 inventory: ${inventoryUrl}`);
  }
  const entries = new Map();
  for (const line of inflateSync(buffer.subarray(offset)).toString('utf8').split('\n')) {
    if (!line) continue;
    const match = /^(\S+)\s+(py:\S+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, name, type, , raw] = match;
    const location = raw.endsWith('$') ? raw.slice(0, -1) + name : raw;
    const entry = { name, kind: type.slice(3), url: new URL(location, inventoryUrl).href };
    const list = entries.get(name) ?? [];
    if (!list.some(other => other.kind === entry.kind && other.url === entry.url)) list.push(entry);
    entries.set(name, list);
  }
  return entries;
}
