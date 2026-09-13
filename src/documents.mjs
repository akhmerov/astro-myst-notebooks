import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mystParse } from 'myst-parser';
import { autodocDirective } from './autodoc.mjs';
import { VFile } from 'vfile';
import { visit } from 'unist-util-visit';
import {
  getFrontmatter, includeDirectiveTransform, basicTransformations,
  ReferenceState, MultiPageReferenceResolver, enumerateTargetsTransform,
  resolveLinksAndCitationsTransform, resolveReferencesTransform,
} from 'myst-transforms';
import { getCitations } from 'citation-js-utils';
import { autolinkRole } from './references.mjs';
import { attachOrigins } from './source-map.mjs';

function diagnostics(file) {
  const errors = file.messages.filter(message => message.fatal ||
    ['reference-target-resolves', 'include-content-loads', 'include-content-filters'].includes(message.ruleId));
  if (errors.length) file.fail(errors.map(message => message.reason).join('\n'));
}

export function parseDocument(source, path, root, fullSource = source, keepTitleNode = false) {
  const file = new VFile({ path, value: source });
  const tree = mystParse(source, { vfile: file, roles: [autolinkRole], directives: [autodocDirective], extensions: { smartquotes: false } });
  diagnostics(file);
  attachOrigins(tree, source, path, root, fullSource);
  const { frontmatter, identifiers } = getFrontmatter(file, tree, { keepTitleNode });
  return { tree, file, frontmatter, identifiers };
}

async function prepare(document, root) {
  const { tree, file, frontmatter } = document;
  document.sources = new Set([file.path]);
  await includeDirectiveTransform(tree, frontmatter, file, {
    sourceFile: file.path, sourcePath: root,
    resolveFile: (name, from) => resolve(dirname(from), name),
    loadFile: name => readFile(name, 'utf8'),
    parseContent: async (name, content) => {
      document.sources.add(name);
      const included = parseDocument(content, name, root, await readFile(name, 'utf8'), true);
      return { mdast: included.tree, frontmatter: included.frontmatter };
    },
  });
  diagnostics(file);
  visit(tree, node => {
    if (node.type === 'include') {
      if (!node.children?.length) file.fail(`Unresolved include: ${node.file}`, node.position);
      node.type = 'block';
    }
    if (['embed', 'iframe', 'mermaid', 'myst', 'mdast', 'linkBlock', 'index', 'glossary'].includes(node.type)) {
      file.fail(`MyST construct is not supported by this renderer: ${node.type}`, node.position);
    }
  });
  basicTransformations(tree, file, { numbering: { heading_1: false } });
  // Resolve bibliography with MyST's existing Citation.js adapter.
  const bibs = frontmatter.bibliography ? [frontmatter.bibliography].flat() : [];
  const citations = {};
  for (const name of bibs) {
    const parsed = await getCitations(await readFile(resolve(dirname(file.path), name), 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (citations[key]) file.fail(`Duplicate bibliography entry: ${key}`);
      citations[key] = value;
    }
  }
  const cited = new Set();
  visit(tree, 'cite', node => {
    const entry = citations[node.label];
    if (!entry) { node.error = true; return; } // MyST also uses @labels for cross-references.
    cited.add(node.label);
    node.type = 'resolvedCitation'; node.url = `#cite-${encodeURIComponent(node.label)}`;
    node.children = entry.inline(node.kind === 'narrative' ? 't' : 'p', { prefix: node.prefix, suffix: node.suffix, partial: node.partial });
  });
  visit(tree, 'citeGroup', node => {
    node.type = 'span';
    node.data = { ...node.data, hName: 'span' };
    node.children = node.children.flatMap((child, index) => index ? [{ type: 'text', value: '; ' }, child] : [child]);
    if (node.kind === 'parenthetical') node.children = [{ type: 'text', value: '(' }, ...node.children, { type: 'text', value: ')' }];
  });
  let bibliography;
  visit(tree, 'bibliography', node => { bibliography = node; });
  if (cited.size && !bibliography) { bibliography = { type: 'bibliography' }; tree.children.push(bibliography); }
  if (bibliography) {
    bibliography.type = 'block';
    bibliography.children = [...cited].map(key => ({ type: 'html', value:
      `<div data-source-generated="true" id="cite-${encodeURIComponent(key)}">${citations[key].render()}</div>` }));
  }
  document.state = new ReferenceState(file.path, { vfile: file, frontmatter: {
    ...frontmatter, numbering: { heading_1: false, heading_2: false, heading_3: false, ...frontmatter.numbering },
  }, url: document.url, identifiers: document.identifiers });
  // Match notebook/Sphinx convention: number labelled equations. Explicit
  // MyST :enumerated: choices still take precedence.
  visit(tree, 'math', node => { node.enumerated ??= Boolean(node.identifier); });
  enumerateTargetsTransform(tree, { state: document.state });
}

/** Resolve a complete collection before rendering any page. Routes come from
 * Astro's content loader, while MyST owns labels, numbering and references.
 */
export async function resolveDocument(source, file, { root = process.cwd(), documents } = {}) {
  root = root instanceof URL ? fileURLToPath(root) : root;
  let routes = [];
  if (documents) {
    try { routes = JSON.parse(await readFile(documents, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const path = resolve(file.path ?? 'document.md');
  const registered = routes.some(entry => entry.path === path);
  const entries = registered ? routes : [{ path, url: undefined }];
  const pages = await Promise.all(entries.map(async entry => {
    const content = registered ? await readFile(entry.path, 'utf8') : source;
    return { ...parseDocument(content, entry.path, root), url: entry.url };
  }));
  await Promise.all(pages.map(page => prepare(page, root)));
  const page = pages.find(page => page.file.path === path);
  const state = new MultiPageReferenceResolver(pages.map(page => page.state), path, page.file);
  visit(page.tree, 'link', node => {
    // Translate file links using the collection's actual routes before resolving.
    const [name, label] = node.url.split('#');
    if (!name.endsWith('.md') || name.includes('://')) return;
    const origin = node.data?.origin?.file ? resolve(root, node.data.origin.file) : path;
    const target = resolve(dirname(origin), name);
    // Included project files may link to another included file, or to a route
    // relative to the containing document (the Sphinx include convention).
    const candidates = pages.filter(other => other.sources.has(target));
    if (candidates.length > 1) page.file.fail(`Ambiguous included document: ${name}`, node.position);
    const destination = candidates[0] ?? pages.find(other => other.file.path === resolve(dirname(path), name));
    if (!destination) page.file.fail(`Unknown document: ${name}`, node.position);
    if (!label) { node.url = destination.url; if (!node.children?.length) node.children = [{ type: 'text', value: destination.frontmatter.title ?? name }]; return; }
    node.type = 'crossReference'; node.identifier = label;
    destination.state.resolveReferenceContent(node);
    if (!node.resolved) page.file.fail(`Unresolved reference: ${name}#${label}`, node.position);
    node.type = 'link'; node.url = `${destination.url}#${node.html_id ?? label}`;
  });
  visit(page.tree, node => {
    const label = node.type === 'crossReference' ? node.identifier : node.type === 'link' && node.url.startsWith('#') ? node.url.slice(1) : undefined;
    if (!label || page.state.getTarget(label)) return;
    if (pages.filter(other => other.state.getTarget(label)).length > 1) page.file.fail(`Ambiguous document reference: ${label}; use a file-qualified link`, node.position);
  });
  // Put the current page first, so local labels take precedence over remote ones.
  state.states.sort((a, b) => Number(b.filePath === path) - Number(a.filePath === path));
  resolveLinksAndCitationsTransform(page.tree, { state });
  resolveReferencesTransform(page.tree, page.file, { state });
  visit(page.tree, node => {
    if (node.type === 'crossReference') {
      if (!node.resolved) page.file.fail(`Unresolved reference: ${node.identifier}`, node.position);
      node.type = 'link'; node.url = `${node.url ?? ''}#${node.html_id ?? node.identifier}`;
    }
    if (node.type === 'resolvedCitation') node.type = 'link';
    if (node.type === 'cite') page.file.fail(`Unknown citation or reference: ${node.label}`, node.position);
  });
  const supported = new Set([
    'root', 'block', 'paragraph', 'text', 'heading', 'emphasis', 'strong', 'delete',
    'link', 'image', 'inlineCode', 'code', 'math', 'inlineMath', 'mathGroup',
    'list', 'listItem', 'blockquote', 'thematicBreak', 'break', 'html', 'comment',
    'table', 'tableRow', 'tableCell', 'definition', 'footnoteDefinition', 'footnoteReference',
    'admonition', 'admonitionTitle', 'container', 'caption', 'captionNumber', 'legend',
    'definitionList', 'definitionTerm', 'definitionDescription', 'abbreviation',
    'subscript', 'superscript', 'keyboard', 'span', 'outputs',
  ]);
  visit(page.tree, node => {
    if (!supported.has(node.type)) page.file.fail(`MyST construct is not supported by this renderer: ${node.type}`, node.position);
  });
  // Anonymous fragments (such as Griffe docstrings) have no text-file offsets.
  // Do not invent a document.md source map for them.
  if (!file.path) visit(page.tree, node => { if (node.data) delete node.data.origin; });
  diagnostics(page.file);
  return page.tree;
}

/** Named document targets for an exported Sphinx inventory. */
export async function documentTargets(source, path, root) {
  const document = parseDocument(source, path, root);
  await prepare(document, root);
  return document.state.getAllTargets().filter(target => target.node.label && !target.node.implicit).map(target => ({
    name: target.node.label,
    id: target.node.html_id ?? target.node.identifier,
    title: target.node.children?.map(child => child.value ?? '').join('') || target.node.label,
  }));
}
