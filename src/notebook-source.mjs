import { readFile } from 'node:fs/promises';

const text = value => Array.isArray(value) ? value.join('') : String(value ?? '');
const fence = source => '`'.repeat(Math.max(3, (source.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length + 1), 0)));

/** Convert an .ipynb document to Jupytext's MyST Markdown representation.
 * The text is deterministic, so a consumer can regenerate it from the notebook
 * to interpret source-map offsets that carry `representation: 'myst'`.
 */
export function notebookSourceMap(notebook) {
  const cells = notebook.cells ?? [];
  const kernelspec = notebook.metadata?.kernelspec;
  const language = kernelspec?.language ?? notebook.metadata?.language_info?.name ?? 'python';
  const lang = language === 'python' ? 'ipython3' : language;
  const parts = [];
  const segments = [];
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
      if (source.trim()) {
        const part = source.trim();
        segments.push({ cell: index, type: 'markdown', body: part, part, lineOffset: text(cell.source).replace(/\r\n/g, '\n').slice(0, text(cell.source).replace(/\r\n/g, '\n').indexOf(part)).split('\n').length - 1 });
        parts.push(part);
      }
    } else if (cell.cell_type === 'code') {
      const tags = cell.metadata?.tags ?? [];
      const ticks = fence(source);
      const part = [`${ticks}{code-cell} ${lang}`, ...(tags.length ? [`:tags: ${JSON.stringify(tags)}`, ''] : []), source.replace(/\n$/, ''), ticks].join('\n');
      segments.push({ cell: index, type: 'code', body: source.replace(/\n$/, ''), part });
      parts.push(part);
    }
    // Raw cells target other export formats and are not published.
    if (cell.cell_type !== 'raw') previous = cell.cell_type;
  }
  const body = parts.join('\n\n');
  const lines = yaml ? yaml.split('\n') : [];
  // Frontmatter mirrors Jupytext: the notebook's kernelspec and a title from the first heading.
  if (kernelspec && !lines.some(line => /^kernelspec:/.test(line))) lines.push(`kernelspec: ${JSON.stringify(kernelspec)}`);
  if (notebook.metadata?.presentation && !lines.some(line => /^presentation:/.test(line))) lines.push(`presentation: ${JSON.stringify(notebook.metadata.presentation)}`);
  const heading = /^# (.+)$/m.exec(body);
  if (!lines.some(line => /^title:/.test(line)) && heading) lines.push(`title: ${JSON.stringify(heading[1].trim())}`);
  const prefix = lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
  let from = 0;
  for (const segment of segments) {
    const offset = body.indexOf(segment.part, from);
    segment.start = prefix.length + offset;
    from = offset + segment.part.length;
  }
  return { source: `${prefix}${body}\n`, segments };
}

export function notebookToMyst(notebook) {
  return notebookSourceMap(notebook).source;
}

/** Read a collection source as MyST text, converting notebooks. */
export async function loadSource(path) {
  const contents = await readFile(path, 'utf8');
  return path.endsWith('.ipynb') ? notebookToMyst(JSON.parse(contents)) : contents;
}
