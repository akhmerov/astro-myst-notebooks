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
export function attachOrigins(tree, source, path, root, fullSource = source, options = {}) {
  const base = options.sourceOffset ?? fullSource.indexOf(source);
  if (base < 0 || fullSource.slice(base, base + source.length) !== source ||
      options.sourceOffset === undefined && source.length > 0 && fullSource.indexOf(source, base + 1) >= 0) {
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
  const inlineKinds = new Set(['emphasis', 'strong', 'delete', 'link', 'crossReference', 'subscript', 'superscript', 'underline', 'smallcaps', 'span', 'abbreviation', 'keyboard', 'pythonReference']);
  const contextKind = type => type === 'linkReference' ? 'link' : inlineKinds.has(type) ? type : null;
  const collect = (text, offset = 0, context = [], role) => {
    const ast = fromMarkdown(text, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
    function walk(node, context) {
      if (['text', 'inlineCode'].includes(node.type) && node.position) lexical.push({ type: node.type, value: node.value,
        start: offset + node.position.start.offset, end: offset + node.position.end.offset, context: context.join('/'), role });
      const kind = contextKind(node.type);
      for (const child of node.children ?? []) walk(child, kind ? [...context, kind] : context);
    }
    walk(ast, context);
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
  const roleKinds = { sub: 'subscript', subscript: 'subscript', sup: 'superscript', superscript: 'superscript',
    underline: 'underline', u: 'underline', smallcaps: 'smallcaps', sc: 'smallcaps', span: 'span', download: 'link' };
  const roleFields = new Set();
  function roleEntries(node, context = []) {
    if (node.type === 'mystRole' && node.position) {
      // MyST role columns are local to an inline block (e.g. after a list
      // marker). CommonMark's code-span offsets retain actual source columns.
      const header = `{${node.name}}`;
      const fields = lexical.filter(entry => !entry.role && entry.type === 'inlineCode' && entry.context === context.join('/') &&
        entry.start >= starts[node.position.start.line - 1] && entry.end <= (starts[node.position.end.line] ?? source.length) &&
        source.slice(entry.start - header.length, entry.start) === header);
      for (const field of fields) {
        const key = `${node.name}:${field.start}`;
        if (roleFields.has(key)) continue;
        const syntax = source.slice(field.start, field.end);
        const ticks = /^`+/.exec(syntax)?.[0];
        if (!ticks || !syntax.endsWith(ticks) || syntax.slice(ticks.length, -ticks.length) !== node.value) continue;
        roleFields.add(key);
        const bodyStart = field.start + ticks.length;
        const python = node.name === 'autolink' || node.name.startsWith('py:');
        if (python) {
          const explicit = /^(.*?)\s*<([^<>]+)>$/.exec(node.value);
          const value = explicit ? explicit[1].trim() : node.value.startsWith('~') ? node.value.split('.').at(-1) : node.value;
          if (value && node.value.indexOf(value) === node.value.lastIndexOf(value)) lexical.push({ type: 'inlineCode', value,
            start: bodyStart + node.value.indexOf(value), end: bodyStart + node.value.indexOf(value) + value.length,
            context: [...context, 'link'].join('/'), role: node.name });
        } else if (roleKinds[node.name]) {
          const explicit = node.name === 'download' && /^(.*?)\s*<([^<>]+)>$/.exec(node.value);
          const value = explicit ? explicit[1].trim() : node.value;
          collect(value, bodyStart + node.value.indexOf(value), [...context, roleKinds[node.name]], node.name);
        }
      }
      return;
    }
    const kind = contextKind(node.type);
    for (const child of node.children ?? []) roleEntries(child, kind ? [...context, kind] : context);
  }
  roleEntries(raw);
  const used = new Set();
  function walk(node, bounds = { start: 0, end: source.length }, directiveBody, context = []) {
    if (node.position && !['text', 'emphasis', 'strong', 'link', 'inlineCode'].includes(node.type)) {
      bounds = { start: starts[node.position.start.line - 1] ?? bounds.start,
        // Some MyST-generated definition terms report an end line before the
        // start line. Bound lookup to the actual start line instead; lexical
        // source equality still decides whether any text can be exact.
        end: starts[Math.max(node.position.start.line, node.position.end.line)] ?? source.length };
    }
    if (node.type === 'mystDirective') directiveBody = bodies.get(`${node.position?.start.line}:${node.name}`);
    let mapped = origin(bounds.start, bounds.end);
    if (node.type === 'text' || node.type === 'inlineCode') {
      const candidates = lexical.filter(entry => !used.has(entry) && entry.type === node.type && entry.context === context.join('/') && (entry.value === node.value || options.restoreTypography && authoredTextEquivalent(entry.value, node.value)) && entry.start >= bounds.start && entry.end <= bounds.end);
      if (candidates.length === 1) {
        const entry = candidates[0]; used.add(entry);
        if (options.restoreTypography) node.value = entry.value;
        const raw = source.slice(entry.start, entry.end);
        if (node.type === 'inlineCode' && raw.includes(node.value)) {
          const start = entry.start + raw.indexOf(node.value);
          mapped = origin(start, start + node.value.length, 'exact');
        } else mapped = origin(entry.start, entry.end, raw === node.value ? 'exact' : 'range');
        if (entry.role) mapped.authoredRole = entry.role;
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
    const kind = contextKind(node.type);
    for (const child of node.children ?? []) walk(child, bounds, directiveBody, kind ? [...context, kind] : context);
  }
  walk(tree);
}

/** Render text provenance alongside the DOM, including a marker for generated text. */
export function sourceText(h, node) {
  const origin = node.data?.origin;
  return h(node, 'span', origin ? { 'data-source-location': JSON.stringify(origin) }
    : { 'data-source-generated': 'true' }, [{ type: 'text', value: node.value }]);
}

/** Compare only the documented Markdown typographer/link display rewrites.
 * Restoring the original lexical value preserves authored punctuation; it does
 * not normalize arbitrary text or infer a source offset from rendered prose.
 */
export function authoredTextEquivalent(left, right) {
  const plain = value => String(value).replaceAll('\u200b', '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replaceAll('…', '...').replaceAll('–', '--').replaceAll('—', '---')
    .replaceAll('©', '(c)').replaceAll('®', '(r)').replaceAll('™', '(tm)')
    .replaceAll('±', '+-');
  return plain(left) === plain(right);
}

/** Prove a range against Markdown's lexical text, including escaped characters,
 * entities and continuation indentation. Such a range remains inexact: unlike
 * an exact marker its source bytes are not the DOM text. */
export function markdownRangeContains(source, value, type = 'text', range) {
  if (range) {
    const tree = fromMarkdown(source, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
    let matched = false;
    visit(tree, type, node => {
      if (node.position?.start.offset >= range.start && node.position?.end.offset <= range.end &&
          typeof node.value === 'string' && node.value.includes(value)) matched = true;
    });
    if (matched) return true;
    source = source.slice(range.start, range.end);
  }
  // A range may begin halfway through an inline paragraph. The sentinel keeps
  // its leading whitespace from being mistaken for block indentation.
  const tree = fromMarkdown('\uFFFC' + source, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
  let matched = false;
  visit(tree, type, node => { if (typeof node.value === 'string' && node.value.replace(/^\uFFFC/, '').includes(value)) matched = true; });
  return matched;
}

/** Recover only a known typographic display rewrite inside an authored range.
 * Repeated equal source strings are safe; different matching spellings are
 * ambiguous and deliberately rejected by the caller.
 */
export function authoredTextInRange(value, source) {
  const replacements = new Map([['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'], ['…', '...'],
    ['–', '--'], ['—', '---'], ['©', '(c)'], ['®', '(r)'], ['™', '(tm)'], ['±', '+-'], ['\u200b', '']]);
  const normalize = input => {
    let normalized = ''; const offsets = [];
    for (let index = 0; index < input.length; index++) {
      const part = replacements.get(input[index]) ?? input[index];
      for (const character of part) { normalized += character; offsets.push(index); }
    }
    return { normalized, offsets };
  };
  const target = normalize(value).normalized;
  if (!target) return undefined;
  const { normalized, offsets } = normalize(source);
  const matches = new Set();
  for (let at = normalized.indexOf(target); at >= 0; at = normalized.indexOf(target, at + 1)) {
    const candidate = source.slice(offsets[at], offsets[at + target.length - 1] + 1);
    if (authoredTextEquivalent(candidate, value)) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
