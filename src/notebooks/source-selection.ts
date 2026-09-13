export interface SourceLocation {
  version: number; file: string; revision: string | null; digest: string; encoding: 'utf-16';
  start: number; end: number; kind: 'exact' | 'range';
  position?: { start: { line: number; column: number; offset: number }; end: { line: number; column: number; offset: number } };
}
export interface SourceSelection {
  text: string;
  complete: boolean;
  ranges: { text: string; origin?: SourceLocation }[];
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
    let origin: SourceLocation | undefined;
    if (span.dataset.sourceLocation) {
      origin = JSON.parse(span.dataset.sourceLocation);
      if (origin!.kind === 'exact') {
        const prefix = document.createRange(); prefix.selectNodeContents(span);
        prefix.setEnd(selection.startContainer, selection.startOffset);
        const advance = (point: { line: number; column: number; offset: number }, value: string) => {
          const lines = value.split('\n');
          return { line: point.line + lines.length - 1, column: lines.length > 1 ? lines.at(-1)!.length + 1 : point.column + value.length, offset: point.offset + value.length };
        };
        const start = origin!.position && advance(origin!.position.start, prefix.toString());
        origin = { ...origin!, start: origin!.start + prefix.toString().length,
          end: origin!.start + prefix.toString().length + text.length,
          position: start ? { start, end: advance(start, text) } : undefined };
      }
    }
    ranges.push({ text, origin });
  }
  return { text: range.toString(), complete: ranges.map(part => part.text).join('') === range.toString(), ranges };
}

declare global { interface Window { mystSourceMap: { version: number; resolve: typeof resolveSourceSelection }; } }
window.mystSourceMap = { version: 1, resolve: resolveSourceSelection };
