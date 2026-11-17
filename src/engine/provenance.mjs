import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';
import { createTokenizer, tokensToMyst } from 'myst-parser';
import { parse as parseCsv } from 'csv-parse/sync';
import { attachOrigins, authoredTextEquivalent, authoredTextInRange, markdownRangeContains } from '../source-map.mjs';
import { notebookSourceMap, loadSource } from '../notebook-source.mjs';
import { resolvePresentation } from '../presentation.js';

const text = value => Array.isArray(value) ? value.join('') : String(value ?? '');
const local = value => typeof value === 'string' && value && !/^(\/|#|[a-z][a-z0-9+.-]*:)/i.test(value);
const point = (source, offset) => {
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1, offset };
};

/** Filters map a single contiguous source slice, never a concatenated guess. */
export function includeSourceSlice(source, filter, path = 'include') {
  if (!filter || !Object.keys(filter).length) return { content: source, offset: 0 };
  const allowed = new Set(['lines', 'startAt', 'startAfter', 'endAt', 'endBefore']);
  for (const key of Object.keys(filter)) if (!allowed.has(key)) throw new Error(`Unsupported include filter ${key}: ${path}`);
  const lines = source.split('\n');
  let first = 0, last = lines.length - 1;
  if (filter.lines) {
    const selected = filter.lines.flatMap(range => {
      const index = value => value > 0 ? value - 1 : lines.length + value;
      if (typeof range === 'number') return [index(range)];
      const start = index(range[0]);
      const end = index(range[1] ?? lines.length);
      return Array.from({ length: Math.max(0, end - start + 1) }, (_, n) => start + n);
    });
    if (!selected.length || selected.some((line, index) => line < 0 || line >= lines.length || index > 0 && line !== selected[index - 1] + 1)) {
      throw new Error(`Noncontiguous or invalid include filter cannot preserve source provenance: ${path}`);
    }
    first = selected[0]; last = selected.at(-1);
  } else {
    if (filter.startAt || filter.startAfter) {
      first = lines.findIndex(line => line.includes(filter.startAt ?? filter.startAfter));
      if (first < 0) throw new Error(`Include start marker not found: ${path}`);
      if (filter.startAfter) first++;
    }
    if (filter.endAt || filter.endBefore) {
      const match = lines.slice(first + 1).findIndex(line => line.includes(filter.endAt ?? filter.endBefore));
      if (match < 0) throw new Error(`Include end marker not found: ${path}`);
      last = first + match + (filter.endAt ? 1 : 0);
    }
  }
  const content = lines.slice(first, last + 1).join('\n');
  const offset = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0);
  if (source.slice(offset, offset + content.length) !== content) throw new Error(`Include filter is not a contiguous source slice: ${path}`);
  return { content, offset };
}

function codeOrigins(tree, source, path, root, fullSource, sourceOffset) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const raw = tokensToMyst(source, createTokenizer({ extensions: { smartquotes: false } }).parse(source, {}));
  const bodies = [];
  visit(raw, 'mystDirective', node => {
    if (!['code-cell', 'code_cell'].includes(node.name)) return;
    const body = node.children?.find(child => child.type === 'mystDirectiveBody');
    if (body?.position) bodies.push({ start: starts[body.position.start.line - 1], value: body.value });
  });
  let next = 0;
  visit(tree, 'code', node => {
    if (!node.executable) return;
    const body = bodies[next++];
    if (!body || typeof body.start !== 'number' || !body.value.includes(node.value)) throw new Error(`Executable code cannot be mapped to its authored cell: ${path}`);
    const start = sourceOffset + body.start + body.value.indexOf(node.value);
    if (fullSource.slice(start, start + node.value.length) !== node.value) throw new Error(`Executable source differs from its authored cell: ${path}`);
    const identity = node.data?.origin ?? { version: 1, file: relative(root, path).replaceAll('\\', '/'),
      digest: createHash('sha256').update(fullSource).digest('hex'), encoding: 'utf-16', ...(path.endsWith('.ipynb') ? { representation: 'myst' } : {}) };
    const origin = (start, end) => ({ ...identity, start, end, kind: 'exact',
      position: { start: point(fullSource, start), end: point(fullSource, end) } });
    let offset = start;
    const lines = node.value.split('\n').map(line => {
      const mapped = origin(offset, offset + line.length); offset += line.length + 1; return mapped;
    });
    node.data = { ...node.data, origin: { ...origin(start, start + node.value.length), lines } };
  });
}

async function annotate(tree, path, root, { source, fullSource = source, sourceOffset = 0, includedFrom } = {}) {
  source ??= await loadSource(path);
  fullSource ??= source;
  const detached = [];
  function detach(node) {
    const generated = Boolean(node.data?.autodocGenerated) || ['outputs', 'output', 'captionNumber', 'numbering'].includes(node.type);
    if (generated || node.type === 'include') {
      detached.push({ node, children: node.children, generated });
      node.children = [];
    } else for (const child of node.children ?? []) detach(child);
  }
  detach(tree);
  attachOrigins(tree, source, path, root, fullSource, { sourceOffset, restoreTypography: true });
  visit(tree, node => {
    if (['text', 'inlineCode'].includes(node.type) && !node.position && node.data) delete node.data.origin;
    // MyST consumes presentation tags later; retain our namespaced contract.
    if (node.type === 'block' && node.kind === 'notebook-code') {
      const tags = node.data?.tags ?? [];
      resolvePresentation({}, {}, tags);
      node.data = { ...node.data, astroNotebookTags: [...tags] };
    }
    if (includedFrom) {
      for (const key of node.type === 'image' || node.type === 'link' || node.type === 'card' ? ['url'] : node.type === 'iframe' ? ['src'] : []) {
        if (!local(node[key])) continue;
        const boundary = node[key].search(/[?#]/);
        const target = boundary < 0 ? node[key] : node[key].slice(0, boundary);
        const suffix = boundary < 0 ? '' : node[key].slice(boundary);
        const rebased = relative(dirname(includedFrom), resolve(dirname(path), target)).replaceAll('\\', '/');
        node[key] = `${rebased.startsWith('.') ? '' : './'}${rebased}${suffix}`;
      }
    }
  });
  codeOrigins(tree, source, path, root, fullSource, sourceOffset);
  for (const { node, children, generated } of detached) {
    node.children = children;
    if (generated) {
      visit(node, child => { if (child.data) delete child.data.origin; });
      continue;
    }
    const includedPath = resolve(dirname(path), node.file);
    const includedSource = await loadSource(includedPath);
    const selection = includeSourceSlice(includedSource, node.filter, includedPath);
    await annotate({ type: 'root', children: children ?? [] }, includedPath, root, {
      source: selection.content, fullSource: includedSource, sourceOffset: selection.offset, includedFrom: includedFrom ?? path,
    });
  }
}

async function annotateNotebook(tree, path, root) {
  const notebook = JSON.parse(await readFile(path, 'utf8'));
  const { source: fullSource, segments } = notebookSourceMap(notebook);
  let cursor = 0;
  const removed = new Set();
  for (const [index, cell] of notebook.cells.entries()) {
    const segment = segments.find(entry => entry.cell === index);
    const block = tree.children[cursor];
    if (cell.cell_type === 'raw') {
      if (block?.children?.some(child => child.type === 'code' && !child.executable && child.value.replace(/\r\n/g, '\n').replace(/\n+$/, '') === text(cell.source).replace(/\r\n/g, '\n').replace(/\n+$/, ''))) {
        removed.add(block); cursor++;
      }
      continue;
    }
    if (!segment) continue;
    if (!block) throw new Error(`Notebook cell ${index} has no resolved source block: ${path}`);
    if (cell.cell_type === 'code') {
      const code = block.children?.find(child => child.type === 'code' && child.executable);
      // Notebook cell values retain their original line endings and terminal
      // newline, whereas notebookToMyst normalizes CRLF and removes exactly one
      // terminal newline before placing code inside its fence. Accept only that
      // declared canonical conversion, never a trim of executable whitespace.
      if (code && typeof code.value === 'string' && code.value.replace(/\r\n/g, '\n').replace(/\n$/, '') === segment.body) code.value = segment.body;
      if (!code || code.value !== segment.body) throw new Error(`Notebook executable cell ${index} cannot be mapped: ${path}`);
      await annotate({ type: 'root', children: [block] }, path, root, {
        source: segment.part, fullSource, sourceOffset: segment.start,
      });
    } else {
      // MyST positions each Markdown cell independently. Position metadata is
      // lexical input only; resulting origins index our declared canonical text.
      const positions = [];
      visit(block, node => {
        if (node.position) {
          positions.push([node, node.position]);
          node.position = structuredClone(node.position);
          node.position.start.line -= segment.lineOffset;
          node.position.end.line -= segment.lineOffset;
        }
      });
      try {
        await annotate({ type: 'root', children: [block] }, path, root, {
          source: segment.body, fullSource, sourceOffset: segment.start,
        });
      } finally { for (const [node, position] of positions) node.position = position; }
    }
    cursor++;
  }
  tree.children = tree.children.filter(node => !removed.has(node));
}

/** Namespaced source metadata attached without accessing MyST Session internals. */
export function createProvenance({ root = process.cwd(), generated = [] } = {}) {
  root = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const generatedFiles = new Set(generated.map(path => resolve(path)));
  return { name: 'Astro MyST source provenance', transforms: [{ name: 'astro-source-provenance', stage: 'document',
    plugin: () => async (tree, file) => {
      if (generatedFiles.has(resolve(file.path))) return;
      if (file.path.endsWith('.ipynb')) await annotateNotebook(tree, file.path, root);
      else await annotate(tree, file.path, root);
    } }] };
}

// CSV fields are parsed as inline Markdown by MyST. Their synthetic positions
// are record numbers, not authored line numbers; quoted/doubled fields also do
// not have a literal source substring. Prove their text independently from the
// lexical directive and retain an explicitly inexact enclosing directive range.
function csvDirectives(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const tokenizer = createTokenizer({ extensions: { smartquotes: false } });
  const raw = tokensToMyst(source, tokenizer.parse(source, {}));
  const directives = [], tables = [];
  function walk(node) {
    if (node.type === 'table' || node.type === 'mystDirective' && node.name === 'list-table') { tables.push(null); return; }
    if (node.type !== 'mystDirective' || node.name !== 'csv-table') {
      for (const child of node.children ?? []) walk(child);
      return;
    }
    const options = node.options ?? {};
    const delimiter = options.delim ?? ',';
    const csvOptions = { delimiter: delimiter === 'tab' ? '\t' : delimiter === 'space' ? ' ' : delimiter,
      ltrim: options.keepspace === undefined || options.keepspace === false || options.keepspace === 'false',
      escape: options.escape ?? '"', quote: options.quote ?? '"' };
    const rows = [];
    for (const content of [options.header, node.value].filter(value => value !== undefined)) {
      for (const row of parseCsv(content, csvOptions)) rows.push(row.map(field => {
        const lexical = tokensToMyst(field, tokenizer.parse(field, {})), values = [];
        visit(lexical, ['text', 'inlineCode'], text => { values.push({ type: text.type, value: text.value }); });
        return values;
      }));
    }
    const directive = { start: starts[node.position.start.line - 1],
      end: starts[node.position.end.line] ?? source.length, rows };
    directives.push(directive); tables.push(directive);
  }
  walk(raw);
  return { directives, tables };
}

function csvTableBindings(table, directives, narrow) {
  const rows = (table.children ?? []).map(row => (row.children ?? []).map(cell => {
    const values = [];
    visit(cell, ['text', 'inlineCode'], node => { values.push(node); });
    return values;
  }));
  const matches = directives.filter(directive => rows.length === directive.rows.length &&
    rows.every((row, r) => row.length === directive.rows[r].length && row.every((cell, c) =>
      cell.length === directive.rows[r][c].length && cell.every((node, i) => {
        const value = directive.rows[r][c][i], origin = node.data?.origin;
        const inRange = origin && (origin.kind === 'exact'
          ? origin.start >= directive.start && origin.end <= directive.end
          : directive.start >= origin.start && directive.end <= origin.end);
        return inRange &&
          node.type === value.type && authoredTextEquivalent(node.value, value.value);
      }))));
  const bindings = new Map();
  if (!matches.length) return bindings;
  rows.forEach((row, r) => row.forEach((cell, c) => cell.forEach((node, i) => {
    const values = new Set(matches.map(directive => directive.rows[r][c][i].value));
    if (values.size === 1) bindings.set(node, { value: [...values][0],
      // Only source order plus a complete table comparison identifies a
      // particular directive. Content equality alone cannot locate duplicates.
      ...(narrow && matches.length === 1 ? { start: matches[0].start, end: matches[0].end } : {}) });
  })));
  return bindings;
}

/** Validate the contract after project transformations and before publishing DOM markers. */
export async function finalizeOrigins(tree, { root = process.cwd() } = {}) {
  root = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const sources = new Map();
  const csvSources = new Map();
  const tableText = new Set();
  const tables = [];
  visit(tree, 'table', table => { tables.push(table); visit(table, ['text', 'inlineCode'], node => { tableText.add(node); }); });
  const csvBindings = new Map();
  const tablesByFile = new Map();
  for (const table of tables) {
    const origins = [];
    visit(table, ['text', 'inlineCode'], node => { if (node.data?.origin) origins.push(node.data.origin); });
    const files = new Set(origins.map(origin => origin.file));
    if (files.size !== 1) continue;
    const path = resolve(root, [...files][0]);
    if (!tablesByFile.has(path)) tablesByFile.set(path, []);
    tablesByFile.get(path).push(table);
    if (!sources.has(path)) sources.set(path, await loadSource(path));
    if (!csvSources.has(path)) csvSources.set(path, csvDirectives(sources.get(path)));
  }
  for (const [path, fileTables] of tablesByFile) {
    const lexical = csvSources.get(path);
    const ordered = lexical.tables.length === fileTables.length;
    fileTables.forEach((table, index) => {
      const candidates = ordered ? (lexical.tables[index] ? [lexical.tables[index]] : []) : lexical.directives;
      for (const [node, binding] of csvTableBindings(table, candidates, ordered)) csvBindings.set(node, binding);
    });
  }
  const nodes = [];
  visit(tree, node => { if (node.data?.origin) nodes.push(node); });
  for (const node of nodes) {
    const origin = node.data.origin;
    const path = resolve(root, origin.file);
    if (!sources.has(path)) sources.set(path, await loadSource(path));
    const source = sources.get(path);
    if (!Number.isInteger(origin.start) || !Number.isInteger(origin.end) || origin.start < 0 || origin.end < origin.start || origin.end > source.length) {
      throw new Error(`Invalid source provenance range: ${origin.file}`);
    }
    if (origin.digest !== createHash('sha256').update(source).digest('hex')) throw new Error(`Source changed after the MyST document build: ${origin.file}`);
    if (tableText.has(node) && origin.kind === 'range') {
      const csv = csvBindings.get(node);
      if (csv) {
        node.value = csv.value;
        Object.assign(origin, { transformation: 'csv', ...(csv.start === undefined ? {} : {
          start: csv.start, end: csv.end, position: { start: point(source, csv.start), end: point(source, csv.end) } }) });
        continue;
      }
      if (origin.transformation === 'csv') throw new Error(`CSV source provenance does not match a decoded authored field: ${origin.file}`);
    }
    if (typeof node.value === 'string' && origin.kind === 'exact') {
      const authored = source.slice(origin.start, origin.end);
      if (authored !== node.value) {
        if (!authoredTextEquivalent(authored, node.value)) throw new Error(`Exact source provenance does not match rendered text: ${origin.file}:${origin.position?.start?.line ?? '?'}`);
        node.value = authored;
      }
    }
    if (['text', 'inlineCode'].includes(node.type) && origin.kind === 'range' && !source.slice(origin.start, origin.end).includes(node.value)) {
      const authored = authoredTextInRange(node.value, source.slice(origin.start, origin.end));
      if (authored !== undefined) node.value = authored;
      else if (markdownRangeContains(source, node.value, node.type, origin)) {
        origin.transformation = 'markdown';
      } else throw new Error(`Source provenance range does not contain rendered text: ${origin.file}`);
    }
    const codeLines = typeof node.value === 'string' && node.type === 'code' ? node.value.split('\n') : undefined;
    if (origin.lines && codeLines && origin.lines.length !== codeLines.length) throw new Error(`Code-line source provenance length differs: ${origin.file}`);
    for (const [index, line] of (origin.lines ?? []).entries()) {
      if (line.kind !== 'exact' || line.start < origin.start || line.end > origin.end || line.end < line.start ||
          codeLines && source.slice(line.start, line.end) !== codeLines[index]) throw new Error(`Invalid code-line source provenance: ${origin.file}`);
    }
  }
  return tree;
}

export default createProvenance();
