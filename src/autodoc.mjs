import { mystParse } from 'myst-parser';
import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { toHtml } from 'hast-util-to-html';

/** MyST owns directive parsing; Starlight Pydocs owns API rendering. */
export const autodocDirective = {
  name: 'autodoc',
  doc: 'Render a Python object with Starlight Pydocs.',
  arg: { type: String, required: true, doc: 'Fully qualified Python object name.' },
  options: { 'summary-only': { type: Boolean, doc: 'Render only the module docstring.' }, 'heading-level': { type: Number, doc: 'Heading level of the object (default 3).' } },
  run(data, file) {
    const name = data.arg;
    const level = data.options?.['heading-level'] ?? 3;
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(name)) file.fail(`Invalid Python object: ${name}`);
    if (!Number.isInteger(level) || level < 2 || level > 6) file.fail('autodoc heading-level must be 2–6');
    return [{ type: 'html', value: `<template data-myst-autodoc="${name}" data-heading-level="${level}" data-summary-only="${data.options?.['summary-only'] === true}"></template>` }];
  },
};

/** Locate our directive placeholders using an HTML parser, preserving
 * all other rendered markup byte for byte (including text source maps).
 */
export function autodocParts(html, aliases = {}) {
  const original = fromHtml(html, { fragment: true });
  const targets = new Map([['@top', 0]]);
  visit(original, 'element', node => {
    if (node.properties.id) targets.set(String(node.properties.id), node.position.start.offset);
  });
  const inserts = Object.entries(aliases).filter(([alias]) => !targets.has(alias)).map(([alias, target]) => {
    if (!targets.has(target)) throw new Error(`Unknown anchor alias target: ${alias} -> ${target}`);
    return { offset: targets.get(target), html: toHtml({type: 'element', tagName: 'span', properties: {id: alias}, children: []}) };
  });
  for (const insert of inserts.sort((a,b) => b.offset - a.offset)) {
    html = html.slice(0, insert.offset) + insert.html + html.slice(insert.offset);
  }
  const tree = fromHtml(html, { fragment: true });
  const parts = [];
  let offset = 0;
  const markers = [];
  visit(tree, 'element', node => { if (node.tagName === 'template' && node.properties.dataMystAutodoc) markers.push(node); });
  for (const node of markers) {
    if (node.type !== 'element' || node.tagName !== 'template' || !node.properties.dataMystAutodoc) continue;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    parts.push({ html: html.slice(offset, start) });
    parts.push({ name: String(node.properties.dataMystAutodoc), headingLevel: Number(node.properties.dataHeadingLevel), summaryOnly: node.properties.dataSummaryOnly === 'true' });
    offset = end;
  }
  parts.push({ html: html.slice(offset) });
  return parts;
}

/** Pydocs warns and drops prose when rendering fails. A notebook/documentation
 * build must instead reject missing sections, including future unknown kinds. */
export function assertRenderedDocstrings(doc, rendered) {
  const object = rendered.objects[doc.canonicalPath];
  const entries = new Set(['parameters', 'other parameters', 'type parameters', 'attributes', 'returns', 'yields', 'receives', 'raises', 'warns', 'functions', 'classes', 'modules', 'type aliases']);
  const require = (source, html) => {
    if (source?.trim() && !html?.trim()) throw new Error(`Missing rendered docstring: ${doc.path}`);
  };
  (doc.docstring?.sections ?? []).forEach((section, index) => {
    const output = object?.sections?.[index];
    if (section.kind === 'text') require(section.value, output?.body);
    else if (section.kind === 'admonition') require(section.value.description, section.value.annotation === 'deprecated' ? object?.deprecated : output?.body);
    else if (section.kind === 'deprecated') require(section.value.description, object?.deprecated);
    else if (section.kind === 'examples') section.value.forEach(([, source], i) => require(source, output?.blocks?.[i]));
    else if (entries.has(section.kind)) section.value.forEach((entry, i) => require(entry.description, output?.entries?.[i]));
    else throw new Error(`Unsupported docstring section ${section.kind}: ${doc.path}`);
  });
}

/** API placements for a host's table of contents, parsed from MyST source. */
export function autodocOutline(source) {
  const tree = mystParse(source, { directives: [autodocDirective] });
  const outline = [];
  let section;
  visit(tree, node => {
    if (node.type === 'heading' && node.depth === 2) {
      section = '';
      visit(node, child => { if (child.type === 'text' || child.type === 'inlineCode') section += child.value; });
    }
    if (node.type === 'mystDirective' && node.name === 'autodoc' && !['true', true].includes(node.options?.['summary-only'])) {
      outline.push({ section, name: node.args });
    }
  });
  return outline;
}
