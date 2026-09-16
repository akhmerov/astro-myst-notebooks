import { readFile } from 'node:fs/promises';
import { parseFrontmatter } from '@astrojs/markdown-remark';

const text = value => Array.isArray(value) ? value.join('') : String(value ?? '');
const fence = source => '`'.repeat(Math.max(3, (source.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length + 1), 0)));

/** Convert an .ipynb document to Jupytext's MyST Markdown representation.
 * The text is deterministic, so a consumer can regenerate it from the notebook
 * to interpret source-map offsets that carry `representation: 'myst'`.
 */
export function notebookToMyst(notebook) {
  const cells = notebook.cells ?? [];
  const kernelspec = notebook.metadata?.kernelspec;
  const language = kernelspec?.language ?? notebook.metadata?.language_info?.name ?? 'python';
  const lang = language === 'python' ? 'ipython3' : language;
  const parts = [];
  let previous;
  let yaml = '';
  for (const [index, cell] of cells.entries()) {
    let source = text(cell.source).replace(/\r\n/g, '\n');
    if (cell.cell_type === 'markdown') {
      if (index === 0) {
        const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
        if (match) { yaml = match[1]; source = source.slice(match[0].length); }
      }
      if (previous === 'markdown') parts.push('+++');
      if (source.trim()) parts.push(source.trim());
    } else if (cell.cell_type === 'code') {
      const tags = cell.metadata?.tags ?? [];
      const ticks = fence(source);
      parts.push([`${ticks}{code-cell} ${lang}`, ...(tags.length ? [`:tags: ${JSON.stringify(tags)}`, ''] : []), source.replace(/\n$/, ''), ticks].join('\n'));
    }
    // Raw cells target other export formats and are not published.
    if (cell.cell_type !== 'raw') previous = cell.cell_type;
  }
  const body = parts.join('\n\n');
  const lines = yaml ? yaml.split('\n') : [];
  // Frontmatter mirrors Jupytext: the notebook's kernelspec and a title from the first heading.
  if (kernelspec && !lines.some(line => /^kernelspec:/.test(line))) lines.push(`kernelspec: ${JSON.stringify(kernelspec)}`);
  const heading = /^# (.+)$/m.exec(body);
  if (!lines.some(line => /^title:/.test(line)) && heading) lines.push(`title: ${JSON.stringify(heading[1].trim())}`);
  return `${lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''}${body}\n`;
}

/** Astro content-entry information for a notebook file's raw JSON text. */
export function notebookEntry(contents) {
  const parsed = parseFrontmatter(notebookToMyst(JSON.parse(contents)));
  return { data: parsed.frontmatter, body: parsed.content.trim(), slug: parsed.frontmatter.slug, rawData: parsed.rawFrontmatter };
}

/** Read a collection source as MyST text, converting notebooks. */
export async function loadSource(path) {
  const contents = await readFile(path, 'utf8');
  return path.endsWith('.ipynb') ? notebookToMyst(JSON.parse(contents)) : contents;
}
