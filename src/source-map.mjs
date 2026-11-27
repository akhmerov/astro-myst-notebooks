import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { createTokenizer, tokensToMyst } from 'myst-parser';
import { inlineMathSimplificationTransform } from 'myst-transforms';
import { visit } from 'unist-util-visit';

const revisions = new Map();
function revision(root) {
  if (!revisions.has(root)) {
    try { revisions.set(root, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch { revisions.set(root, null); }
  }
  return revisions.get(root);
}

function lowerBound(entries, offset, key) {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(entries[mid]) < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

export function sourceSnapshot(source) {
  const starts = lineStarts(source);
  return {
    source, starts, digest: createHash('sha256').update(source).digest('hex'),
    point(offset) {
      const line = lowerBound(starts, offset + 1, value => value);
      return { line, column: offset - starts[line - 1] + 1, offset };
    },
  };
}

const byStart = entry => entry.start;

function indexEntries(entries, key) {
  const buckets = new Map();
  for (const entry of entries) {
    const id = key(entry);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(entry);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.start - b.start);
  return buckets;
}

function* within(entries, start, end) {
  if (!entries) return;
  for (let index = lowerBound(entries, start, byStart); index < entries.length && entries[index].start <= end; index++) {
    if (entries[index].end <= end) yield entries[index];
  }
}

const parseMarkdown = source => fromMarkdown(source, {
  extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
});
// The pinned CLI runs this pass before document plugins, with symbols disabled.
function simplifyMath(value) {
  const formula = { type: 'inlineMath', value };
  inlineMathSimplificationTransform({ type: 'root', children: [formula] }, { replaceSymbol: false });
  return formula;
}

const mathShape = node => [node.type, node.value, node.children?.map(mathShape)];
const lexicalTypes = ['text', 'inlineCode'];

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
  const snapshot = options.snapshot ?? sourceSnapshot(fullSource);
  const starts = source === fullSource ? snapshot.starts : lineStarts(source);
  const { point } = snapshot;
  // Notebook offsets index the deterministic MyST text of the .ipynb file, not its JSON.
  const identity = { version: 1, file: relative(root, path).replaceAll('\\', '/'), revision: revision(root),
    digest: snapshot.digest, encoding: 'utf-16',
    ...(path.endsWith('.ipynb') ? { representation: 'myst' } : {}) };
  const origin = (start, end, kind = 'range') => ({
    ...identity,
    start: base + start, end: base + end, kind,
    position: { start: point(base + start), end: point(base + end) },
  });
  const lexical = [];
  const mathSpans = [];
  const inlineKinds = new Set(['emphasis', 'strong', 'delete', 'link', 'crossReference', 'subscript', 'superscript', 'underline', 'smallcaps', 'span', 'abbreviation', 'keyboard', 'pythonReference']);
  const contextKind = type => type === 'linkReference' ? 'link' : inlineKinds.has(type) ? type : null;
  const collect = (text, offset = 0, context = [], role) => {
    const ast = parseMarkdown(text);
    function walk(node, context) {
      if (node.position && (lexicalTypes.includes(node.type) || node.type === 'inlineMath')) {
        const entry = { type: node.type, value: node.value, start: offset + node.position.start.offset,
          end: offset + node.position.end.offset, context: context.join('/'), role };
        if (node.type === 'inlineMath') {
          const rendered = simplifyMath(node.value);
          if (rendered.type === 'text') lexical.push({ ...entry, type: 'text', value: rendered.value, simplified: true });
          if (rendered.type === 'span') mathSpans.push({ ...entry, shape: JSON.stringify(mathShape(rendered)) });
        } else lexical.push(entry);
      }
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
  const roleRanges = new Set();
  const roleKey = (context, value) => JSON.stringify([context, value]);
  const codeSpans = indexEntries(lexical.filter(entry => entry.type === 'inlineCode'), entry => {
    const syntax = source.slice(entry.start, entry.end);
    const ticks = /^`+/.exec(syntax)?.[0];
    return roleKey(entry.context, ticks ? syntax.slice(ticks.length, -ticks.length) : '');
  });
  function roleEntries(node, context = []) {
    if (node.type === 'mystRole' && node.position) {
      // MyST role columns are local to an inline block (e.g. after a list
      // marker). CommonMark's code-span offsets retain actual source columns.
      const header = `{${node.name}}`;
      const start = starts[node.position.start.line - 1];
      if (start === undefined) return;
      const end = starts[node.position.end.line] ?? source.length;
      const key = roleKey(context.join('/'), node.value);
      const rangeKey = JSON.stringify([key, node.name, start, end]);
      if (roleRanges.has(rangeKey)) return;
      roleRanges.add(rangeKey);
      for (const field of within(codeSpans.get(key), start, end)) {
        if (source.slice(field.start - header.length, field.start) !== header) continue;
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
          if (value && node.value.indexOf(value) === node.value.lastIndexOf(value)) {
            for (const kind of ['link', 'crossReference']) lexical.push({ type: 'inlineCode', value,
              start: bodyStart + node.value.indexOf(value), end: bodyStart + node.value.indexOf(value) + value.length,
              context: [...context, kind].join('/'), role: node.name });
          }
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
  const valueKey = options.restoreTypography ? normalizeTypography : value => value;
  const keyOf = (type, context, value) => JSON.stringify([type, context, valueKey(value)]);
  const candidates = indexEntries(lexical, entry => keyOf(entry.type, entry.context, entry.value));
  const structured = indexEntries(mathSpans, entry => JSON.stringify([entry.context, entry.shape]));
  const used = new Set();
  function walk(node, bounds = { start: 0, end: source.length }, directiveBody, context = []) {
    const enclosing = bounds;
    if (node.position && !['text', 'emphasis', 'strong', 'link', 'inlineCode'].includes(node.type)) {
      bounds = { start: starts[node.position.start.line - 1] ?? bounds.start,
        // Some MyST-generated definition terms report an end line before the
        // start line. Bound lookup to the actual start line instead; lexical
        // source equality still decides whether any text can be exact.
        end: starts[Math.max(node.position.start.line, node.position.end.line)] ?? source.length };
    }
    if (node.type === 'mystDirective') directiveBody = bodies.get(`${node.position?.start.line}:${node.name}`);
    let mapped = origin(bounds.start, bounds.end);
    if (node.type === 'span' && node.position && node.children?.some(child => !child.position)) {
      const key = JSON.stringify([context.join('/'), JSON.stringify(mathShape(node))]);
      const entries = within(structured.get(key), enclosing.start, enclosing.end);
      const first = entries.next().value;
      if (first) {
        // MyST gives each simplification the first line of its paragraph.
        mapped = entries.next().done ? origin(first.start, first.end) : origin(enclosing.start, enclosing.end);
        visit(node, child => { child.data = { ...child.data, origin: { ...mapped, transformation: 'markdown' } }; });
        return;
      }
    }
    if (node.type === 'text' || node.type === 'inlineCode') {
      const bucket = candidates.get(keyOf(node.type, context.join('/'), node.value));
      let entry;
      let simplified = false;
      for (const candidate of within(bucket, bounds.start, bounds.end)) {
        if (used.has(candidate)) continue;
        simplified ||= Boolean(candidate.simplified);
        if (entry) { entry = undefined; break; }
        entry = candidate;
      }
      if (entry) {
        used.add(entry);
        if (entry.simplified) {
          node.data = { ...node.data, origin: { ...origin(entry.start, entry.end), transformation: 'markdown' } };
          return;
        }
        if (options.restoreTypography) node.value = entry.value;
        const raw = source.slice(entry.start, entry.end);
        if (node.type === 'inlineCode' && raw.includes(node.value)) {
          const start = entry.start + raw.indexOf(node.value);
          mapped = origin(start, start + node.value.length, 'exact');
        } else mapped = origin(entry.start, entry.end, raw === node.value ? 'exact' : 'range');
        if (entry.role) mapped.authoredRole = entry.role;
      } else if (simplified) mapped.transformation = 'markdown';
    }
    if (node.type === 'code' && node.executable && directiveBody) {
      const start = directiveBody.start;
      const codeLines = node.value.split('\n');
      const firstLine = lowerBound(starts, start, value => value);
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

/** Share provenance identity and UTF-16 line offsets across a rendered page. */
export function createSourceLocations(root, sources, enabled, page) {
  const index = new Map(), files = [];
  const markers = [];
  return {
    text(h, node) {
      const text = { type: 'text', value: node.value };
      if (!enabled) return text;
      const origin = node.data?.origin;
      if (!origin) return h(node, 'span', { 'data-source-generated': 'true' }, [text]);
      const { file, revision, digest, representation } = origin;
      if (!index.has(file)) {
        index.set(file, files.length);
        files.push({ file, revision, digest, representation, lines: sources.get(resolve(root, file)).starts });
      }
      const flag = (origin.kind === 'range' ? 'r' : '') + (origin.transformation === 'markdown' ? 'm' : origin.transformation === 'csv' ? 'c' : '');
      const location = `${index.get(file)}:${origin.start}:${origin.end}${flag || origin.authoredRole ? ':' + flag : ''}${origin.authoredRole ? ':' + origin.authoredRole : ''}`;
      const marker = h(node, 'span', { 'data-source-location': location }, [text]);
      markers.push(marker);
      return marker;
    },
    append(tree) {
      if (!files.length) return;
      const json = JSON.stringify(files);
      const tableId = createHash('sha256').update(page).update('\0').update(json).digest('hex').slice(0, 16);
      for (const marker of markers) marker.properties['data-source-location'] = tableId + ':' + marker.properties['data-source-location'];
      tree.children.push({ type: 'element', tagName: 'template',
        properties: { id: 'myst-source-' + tableId, 'data-myst-source-map': '1' }, children: [],
        content: { type: 'root', children: [{ type: 'text', value: json }] } });
    },
  };
}

/** Compare only the documented Markdown typographer/link display rewrites.
 * Restoring the original lexical value preserves authored punctuation; it does
 * not normalize arbitrary text or infer a source offset from rendered prose.
 */
const normalizeTypography = value => String(value).replaceAll('\u200b', '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replaceAll('…', '...').replaceAll('–', '--').replaceAll('—', '---')
    .replaceAll('©', '(c)').replaceAll('®', '(r)').replaceAll('™', '(tm)')
    .replaceAll('±', '+-');
export function authoredTextEquivalent(left, right) {
  return normalizeTypography(left) === normalizeTypography(right);
}

/** Prove a range against Markdown's lexical text, including escaped characters,
 * entities and continuation indentation. Such a range remains inexact: unlike
 * an exact marker its source bytes are not the DOM text. */
export function markdownRangeContains(source, value, type = 'text', range, snapshot) {
  if (range) {
    snapshot ??= {};
    if (!snapshot.markdown) {
      const entries = [];
      visit(parseMarkdown(source), ['text', 'inlineCode', 'inlineMath'], node => {
        if (!node.position) return;
        const { start, end } = node.position;
        if (node.type === 'inlineMath') {
          visit(simplifyMath(node.value), 'text', leaf => {
            entries.push({ type: 'text', start: start.offset, end: end.offset, value: leaf.value, simplified: true });
          });
        } else entries.push({ type: node.type, start: start.offset, end: end.offset, value: node.value });
      });
      snapshot.markdown = indexEntries(entries, entry => entry.type);
    }
    for (const entry of within(snapshot.markdown.get(type), range.start, range.end)) {
      if (entry.simplified ? entry.value === value : entry.value.includes(value)) return true;
    }
    source = source.slice(range.start, range.end);
  }
  // A range may begin halfway through an inline paragraph. The sentinel keeps
  // its leading whitespace from being mistaken for block indentation.
  const tree = parseMarkdown('\uFFFC' + source);
  let matched = false;
  visit(tree, type, node => { if (typeof node.value === 'string' && node.value.replace(/^\uFFFC/, '').includes(value)) matched = true; });
  if (!matched && type === 'text') visit(tree, 'inlineMath', node => {
    visit(simplifyMath(node.value), 'text', leaf => { if (leaf.value === value) matched = true; });
  });
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
