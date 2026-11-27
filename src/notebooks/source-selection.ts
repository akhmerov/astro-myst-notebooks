export interface SourceLocation {
  version: number; file: string; revision: string | null; digest: string; encoding: 'utf-16';
  /** Present for .ipynb sources: offsets index the notebook's MyST text, see `notebookToMyst`. */
  representation?: 'myst';
  transformation?: 'markdown' | 'csv';
  authoredRole?: string;
  start: number; end: number; kind: 'exact' | 'range';
  position?: { start: { line: number; column: number; offset: number }; end: { line: number; column: number; offset: number } };
}
export interface SourceSelection {
  text: string;
  complete: boolean;
  ranges: { text: string; origin?: SourceLocation }[];
}

type SourceFile = Pick<SourceLocation, 'file' | 'revision' | 'digest' | 'representation'> & { lines: number[] };
const fileTables = new WeakMap<Element, SourceFile[]>();

function decodeSourceLocation(span: HTMLElement): SourceLocation | undefined {
  const location = span.dataset.sourceLocation;
  if (!location) return;
  const [id, index, from, to, flag = '', ...role] = location.split(':');
  const table = span.ownerDocument.getElementById('myst-source-' + id);
  if (!(table instanceof HTMLTemplateElement) || table.dataset.mystSourceMap !== '1') return;
  let files = fileTables.get(table);
  if (!files) {
    const parsed: SourceFile[] = JSON.parse(table.content.textContent!);
    fileTables.set(table, parsed);
    files = parsed;
  }
  const { lines, ...identity } = files[Number(index)];
  const point = (offset: number) => {
    let lo = 0, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return { line: lo, column: offset - lines[lo - 1] + 1, offset };
  };
  const start = Number(from), end = Number(to);
  const transformation = flag.includes('m') ? 'markdown' : flag.includes('c') ? 'csv' : undefined;
  return { version: 1, encoding: 'utf-16', ...identity, start, end, kind: flag.includes('r') ? 'range' : 'exact',
    ...(transformation && { transformation }), ...(role.length && { authoredRole: role.join(':') }),
    position: { start: point(start), end: point(end) } };
}

/** Return disjoint source ranges: a selection may cross markup or include files.
 * Generated text has no origin. Consumers must not silently anchor it elsewhere.
 */
export function resolveSourceSelection(range: Range): SourceSelection {
  const root = range.commonAncestorContainer;
  const element = root.nodeType === Node.ELEMENT_NODE ? root as Element : root.parentElement!;
  const container = element.closest('[data-source-location], [data-source-generated]') ?? element;
  const spans = [...container.querySelectorAll<HTMLElement>('[data-source-location], [data-source-generated]')];
  if (container.matches('[data-source-location], [data-source-generated]')) spans.unshift(container as HTMLElement);
  const ranges: SourceSelection['ranges'] = [];
  for (const span of spans) {
    if (!range.intersectsNode(span)) continue;
    const selection = document.createRange();
    selection.selectNodeContents(span);
    if (range.compareBoundaryPoints(Range.START_TO_START, selection) > 0) selection.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, selection) < 0) selection.setEnd(range.endContainer, range.endOffset);
    const text = selection.toString();
    if (!text) continue;
    let origin = decodeSourceLocation(span);
    if (origin?.kind === 'exact') {
      const prefix = document.createRange(); prefix.selectNodeContents(span);
      prefix.setEnd(selection.startContainer, selection.startOffset);
      const before = prefix.toString();
      const advance = (point: { line: number; column: number; offset: number }, value: string) => {
        const lines = value.split('\n');
        return { line: point.line + lines.length - 1, column: lines.length > 1 ? lines.at(-1)!.length + 1 : point.column + value.length, offset: point.offset + value.length };
      };
      const start = origin.position && advance(origin.position.start, before);
      origin = { ...origin, start: origin.start + before.length,
        end: origin.start + before.length + text.length,
        position: start ? { start, end: advance(start, text) } : undefined };
    }
    ranges.push({ text, origin });
  }
  return { text: range.toString(), complete: ranges.map(part => part.text).join('') === range.toString(), ranges };
}

declare global { interface Window { mystSourceMap: { version: number; resolve: typeof resolveSourceSelection }; } }
window.mystSourceMap = { version: 1, resolve: resolveSourceSelection };
