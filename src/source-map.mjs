import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { createTokenizer, tokensToMyst } from 'myst-parser';
import { visit } from 'unist-util-visit';

const revisions = new Map();
function revision(root) {
  if (!revisions.has(root)) {
    try { revisions.set(root, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch { revisions.set(root, null); }
  }
  return revisions.get(root);
}

/** Source offsets are UTF-16 code units, like DOM Range and JavaScript strings.
 * MyST owns semantics. CommonMark/GFM supplies accurate lexical positions for
 * prose; ambiguous or transformed text is explicitly a range, never guessed.
 */
export function attachOrigins(tree, source, path, root, fullSource = source) {
  const base = fullSource.indexOf(source);
  if (base < 0 || source.length > 0 && fullSource.indexOf(source, base + 1) >= 0) {
    throw new Error(`Cannot map filtered include uniquely to source: ${path}`);
  }
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const point = offset => {
    const before = fullSource.slice(0, offset).split('\n');
    return { line: before.length, column: before.at(-1).length + 1, offset };
  };
  // Notebook offsets index the deterministic MyST text of the .ipynb file, not its JSON.
  const identity = { version: 1, file: relative(root, path).replaceAll('\\', '/'), revision: revision(root),
    digest: createHash('sha256').update(fullSource).digest('hex'), encoding: 'utf-16',
    ...(path.endsWith('.ipynb') ? { representation: 'myst' } : {}) };
  const origin = (start, end, kind = 'range') => ({
    ...identity,
    start: base + start, end: base + end, kind,
    position: { start: point(base + start), end: point(base + end) },
  });
  const lexical = [];
  const collect = (text, offset = 0) => {
    const ast = fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
    visit(ast, node => {
      if (['text', 'inlineCode'].includes(node.type) && node.position) lexical.push({ type: node.type, value: node.value,
        start: offset + node.position.start.offset, end: offset + node.position.end.offset });
    });
  };
  collect(source);
  // The public MyST tokenizer retains directive body starts before expansion.
  const raw = tokensToMyst(source, createTokenizer({ extensions: { smartquotes: false } }).parse(source, {}));
  const bodies = new Map();
  visit(raw, 'mystDirective', node => {
    const body = node.children?.find(child => child.type === 'mystDirectiveBody');
    if (!body?.position) return;
    const start = starts[body.position.start.line - 1];
    bodies.set(`${node.position.start.line}:${node.name}`, { start, value: body.value });
    if (source.slice(start, start + body.value.length) === body.value) collect(body.value, start);
  });
  const used = new Set();
  function walk(node, bounds = { start: 0, end: source.length }, directiveBody) {
    if (node.position && !['text', 'emphasis', 'strong', 'link', 'inlineCode'].includes(node.type)) {
      bounds = { start: starts[node.position.start.line - 1] ?? bounds.start,
        end: starts[node.position.end.line] ?? source.length };
    }
    if (node.type === 'mystDirective') directiveBody = bodies.get(`${node.position?.start.line}:${node.name}`);
    let mapped = origin(bounds.start, bounds.end);
    if (node.type === 'text' || node.type === 'inlineCode') {
      const candidates = lexical.filter(entry => !used.has(entry) && entry.type === node.type && entry.value === node.value && entry.start >= bounds.start && entry.end <= bounds.end);
      if (candidates.length === 1) {
        const entry = candidates[0]; used.add(entry);
        const raw = source.slice(entry.start, entry.end);
        if (node.type === 'inlineCode' && raw.includes(node.value)) {
          const start = entry.start + raw.indexOf(node.value);
          mapped = origin(start, start + node.value.length, 'exact');
        } else mapped = origin(entry.start, entry.end, raw === node.value ? 'exact' : 'range');
      }
    }
    if (node.type === 'code' && node.executable && directiveBody) {
      const start = directiveBody.start;
      const codeLines = node.value.split('\n');
      const firstLine = starts.indexOf(start);
      const lines = codeLines.map((line, index) => {
        const lineStart = starts[firstLine + index];
        const rawLine = source.slice(lineStart, starts[firstLine + index + 1] ?? source.length);
        const column = rawLine.indexOf(line);
        if (column < 0) throw new Error(`Cannot map executable line in ${path}`);
        return origin(lineStart + column, lineStart + column + line.length, 'exact');
      });
      mapped = { ...origin(start, lines.at(-1).end - base), lines };
    }
    node.data = { ...node.data, origin: mapped };
    for (const child of node.children ?? []) walk(child, bounds, directiveBody);
  }
  walk(tree);
}

/** Render text provenance alongside the DOM, including a marker for generated text. */
export function sourceText(h, node) {
  const origin = node.data?.origin;
  return h(node, 'span', origin ? { 'data-source-location': JSON.stringify(origin) }
    : { 'data-source-generated': 'true' }, [{ type: 'text', value: node.value }]);
}
