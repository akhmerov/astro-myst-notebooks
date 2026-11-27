import { resolve } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { loadSource } from '../notebook-source.mjs';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeExpressiveCode from 'rehype-expressive-code';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import { mystRehype, rehypeDocumentBase, rehypeMathErrors } from './hast.mjs';
import { rehypeJupyter } from '../mime.mjs';
import { hydrateOutput, presentNotebooks } from './notebook.mjs';
import { finalizeOrigins } from './provenance.mjs';
import { createSourceLocations } from '../source-map.mjs';

// Support is explicit. MyST's generic fallback prints unhandled directives and
// silently drops some nodes, which is never a successful document conversion.
const supported = new Set([
  'root', 'block', 'paragraph', 'heading', 'text', 'emphasis', 'strong', 'delete',
  'inlineCode', 'code', 'link', 'image', 'list', 'listItem', 'blockquote',
  'thematicBreak', 'break', 'html', 'comment', 'math', 'inlineMath',
  'admonition', 'admonitionTitle', 'container', 'caption', 'captionNumber', 'legend',
  'table', 'tableRow', 'tableCell', 'definitionList', 'definitionTerm',
  'definitionDescription', 'subscript', 'superscript', 'abbreviation',
  'outputs', 'output', 'span', 'resolvedCitation',
  'tabSet', 'tabItem', 'grid', 'grid-item', 'card', 'cardTitle', 'header', 'footer',
  'glossary', 'mermaid', 'iframe', 'keyboard', 'footnoteDefinition', 'footnoteReference',
  'details', 'summary',
]);
const headingText = node => {
  const words = [];
  visit(node, child => { if (['text', 'inlineCode', 'inlineMath'].includes(child.type)) words.push(child.value); });
  return words.join('');
};
const classes = value => Array.isArray(value) ? value : String(value ?? '').split(/\s+/).filter(Boolean);
const generatedText = value => ({ type: 'text', value });

/** Flat page records for the loader; section headers remain navigation only. */
export function pagesFromManifest(manifest) {
  if (manifest.version !== 3 || manifest.projects?.length !== 1) {
    throw new Error('The MyST loader supports manifest v3 with one project');
  }
  const project = manifest.projects[0];
  if (typeof project.index !== 'string' || !project.index) throw new Error('MyST manifest has no project index');
  const result = [{ slug: project.index, id: '', title: project.title, level: 0 }];
  const seen = new Set([project.index]);
  const walk = entries => {
    for (const entry of entries ?? []) {
      if (entry.slug) {
        if (seen.has(entry.slug)) throw new Error(`Duplicate MyST page slug: ${entry.slug}`);
        seen.add(entry.slug);
        result.push({ ...entry, id: entry.slug });
      }
      walk(entry.children);
    }
  };
  walk(project.pages);
  return result;
}

/** Preserve section entries and depth when deriving a consumer's sidebar. */
export function navigationFromManifest(manifest) {
  pagesFromManifest(manifest); // Validate the same manifest used for page loading.
  const project = manifest.projects[0];
  const result = [{ label: project.title, slug: '' }];
  const stack = [{ level: -1, items: result }];
  for (const page of project.pages ?? []) {
    const level = page.level ?? 1;
    while (stack.length > 1 && stack.at(-1).level >= level) stack.pop();
    const item = page.slug ? { label: page.title, slug: page.slug } : { label: page.title, items: [] };
    stack.at(-1).items.push(item);
    if (!page.slug) stack.push({ level, items: item.items });
  }
  return result;
}

function decorateAdmonition(node) {
  const classNames = classes(node.class);
  const styles = { note: 'note', tip: 'tip', hint: 'tip', important: 'tip', warning: 'caution',
    caution: 'caution', attention: 'caution', danger: 'danger', error: 'danger' };
  const kind = classNames.find(name => Object.hasOwn(styles, name)) ?? node.kind ?? 'note';
  if (node.children?.[0]?.type !== 'admonitionTitle') node.children.unshift({
    type: 'admonitionTitle', children: [generatedText(kind.charAt(0).toUpperCase() + kind.slice(1))],
  });
  const dropdown = classNames.includes('dropdown');
  node.data = { ...node.data, hName: dropdown ? 'details' : 'aside', hProperties: {
    ...node.data?.hProperties,
    className: [...new Set([...classNames, 'admonition', ...(node.kind ? [node.kind] : []),
      'starlight-aside', `starlight-aside--${styles[kind] ?? 'note'}`])],
  } };
  const title = node.children[0];
  title.data = { ...title.data, hName: dropdown ? 'summary' : 'p',
    hProperties: { className: ['admonition-title', 'starlight-aside__title'] } };
}

function adaptCitations(tree, references, file) {
  const bibliography = references?.cite;
  const cited = new Set();
  visit(tree, 'cite', node => {
    const label = node.label ?? node.identifier;
    const entry = bibliography?.data?.[label];
    if (node.error || !entry || !node.children?.length) file.fail(`Unresolved MyST citation: ${label}`);
    cited.add(label);
    node.type = 'resolvedCitation';
    node.url = `#cite-${encodeURIComponent(label)}`;
  });
  visit(tree, 'citeGroup', node => {
    if (!node.children?.every(child => child.type === 'resolvedCitation')) file.fail('Unsupported MyST citation group');
    const children = node.children.flatMap((child, index) => index ? [generatedText('; '), child] : [child]);
    node.type = 'span';
    node.data = { ...node.data, hName: 'span', hProperties: { className: ['citation-group'], dataSourceGenerated: 'true' } };
    node.children = node.kind === 'parenthetical' ? [generatedText('('), ...children, generatedText(')')] : children;
  });
  let found = false;
  visit(tree, 'bibliography', node => {
    found = true;
    const order = bibliography?.order ?? [...cited];
    node.type = 'block';
    node.data = { ...node.data, hName: 'div', hProperties: { className: ['bibliography'], dataSourceGenerated: 'true' } };
    node.children = order.map(label => {
      const entry = bibliography?.data?.[label];
      if (!entry?.html) file.fail(`Missing rendered MyST bibliography entry: ${label}`);
      return { type: 'block', data: { hName: 'div', hProperties: { id: `cite-${label}` } },
        children: [{ type: 'html', value: entry.html }] };
    });
  });
  if (cited.size && !found) {
    // MyST includes its citation data even when the author did not insert an
    // explicit bibliography directive. Match the existing publication contract.
    tree.children.push({ type: 'bibliography' });
    adaptCitations(tree, references, file);
  }
}

function normalizeFootnoteIds() {
  return tree => {
    visit(tree, 'element', node => {
      const id = node.properties?.id;
      if (typeof id !== 'string' || !/^user-content-fn(?:ref)?-/.test(id)) return;
      // The MyST HAST handler URL-encodes both ids and fragment links. Browsers
      // decode the fragment first, so the DOM id must contain the decoded text.
      try { node.properties.id = decodeURIComponent(id); } catch { /* Keep a literal percent sign. */ }
    });
  };
}

function mapPageUrl(url, node, resolvePageUrl, file, isPublicAsset) {
  if (!url || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return url;
  const [, path, suffix = ''] = /^([^?#]*)([?#].*)?$/.exec(url);
  if (!path) return url; // An authored fragment belongs to the current page.
  const mapped = resolvePageUrl?.(path, node);
  if (mapped === undefined && /\.(md|ipynb)$/i.test(path) && !isPublicAsset?.(path)) {
    file?.fail(`Unresolved local MyST document link: ${url}`, node.position);
  }
  return mapped === undefined ? url : mapped + suffix;
}

function referenceUrl(node, resolvePageUrl) {
  const anchor = node.html_id ?? node.identifier;
  let url = node.url ?? '';
  if (node.remoteBaseUrl) {
    // This is MyST's own remote-base contract: url is relative to its advertised
    // project base, not the current Astro site's deployment prefix.
    url = node.remoteBaseUrl.replace(/\/$/, '') + (url === '/' ? '' : url);
  } else url = mapPageUrl(url, node, resolvePageUrl);
  if (anchor && !url.includes('#')) url += `#${anchor}`;
  return url || '#';
}

// MyST's engine normalizes every list item to spread=true. Restore Markdown's
// lexical decision; this is presentation only and does not resolve semantics.
async function restoreListSpacing(tree, { root, path }) {
  const lists = [];
  visit(tree, ['list', 'listItem'], node => { lists.push(node); });
  const cache = new Map();
  for (const node of lists) {
    const sourcePath = node.data?.origin?.file ? resolve(root, node.data.origin.file) : path;
    let items = cache.get(sourcePath);
    if (!items) {
      const source = await loadSource(sourcePath);
      const lexical = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
      items = new Map();
      visit(lexical, ['list', 'listItem'], item => { items.set(`${item.type}:${item.position.start.line}`, item.spread); });
      cache.set(sourcePath, items);
    }
    const line = node.data?.origin?.position?.start?.line ?? node.position?.start?.line;
    const spread = items.get(`${node.type}:${line}`);
    if (typeof spread === 'boolean') node.spread = spread;
  }
}

/** Render one computed document. It never opens or runs a kernel.
 * @param {any} page Resolved MyST page JSON.
 * @param {any} options Consumer root, presentation, route and asset adapters.
 */
export async function renderPage(page, { root, base = '/', interactive = true, presentation = {},
  frontmatter, readAsset, fetchAsset, resolvePageUrl, isPublicAsset, stripTitle = true, sourceMaps = true } = {}) {
  if (!page?.mdast || page.mdast.type !== 'root') throw new Error('MyST page has no resolved root tree');
  if (!root) throw new Error('MyST rendering requires a source project root');
  const tree = structuredClone(page.mdast);
  const metadata = { ...page.frontmatter, ...page.frontmatter?.site, ...page.frontmatter?.options,
    ...tree.data?.astroNotebook, ...frontmatter };
  const file = new VFile({ path: resolve(root, String(page.location ?? '').replace(/^\/+/, '')),
    data: { astro: { frontmatter: metadata } } });
  const assetReader = fetchAsset ?? (readAsset && (async path => {
    const value = await readAsset(path);
    return value instanceof Response ? value : new Response(value);
  }));
  adaptCitations(tree, page.references, file);
  const inlineOutputs = [];
  visit(tree, node => {
    if (node.type === 'astroRawHtml') node.type = 'html';
    if (node.type === 'resolvedCitation') { node.type = 'link'; node.data = { ...node.data, hProperties: { className: ['citation'] } }; }
    if (node.type === 'crossReference') {
      if (!node.resolved) file.fail(`Unresolved MyST reference: ${node.identifier}`);
      node.type = 'link';
      node.url = referenceUrl(node, resolvePageUrl);
    }
    if (node.type === 'link' || node.type === 'card') node.url = mapPageUrl(node.url, node, resolvePageUrl, file, isPublicAsset);
    if (node.type === 'include' || node.type === 'embed') {
      if (!node.children?.length) file.fail(`MyST ${node.type} has no resolved content`);
      node.type = 'block';
    }
    if (node.html_id && node.type !== 'link') node.identifier = node.html_id;
    if (node.type === 'block' && node.kind === 'notebook-code') {
      const code = node.children?.find(child => child.type === 'code');
      const outputs = node.children?.find(child => child.type === 'outputs');
      if (!code) file.fail('Notebook block has no executable source');
      const tags = [...(node.data?.astroNotebookTags ?? node.data?.tags ?? [])];
      for (const [part, visibility] of [['cell', node.visibility], ['input', code.visibility], ['output', outputs?.visibility]]) {
        if (visibility && visibility !== 'show' && !tags.includes(`${visibility}-${part}`)) tags.push(`${visibility}-${part}`);
      }
      node.data = { ...node.data, tags };
    }
    if (node.type === 'inlineExpression') {
      if (!node.result?.data) file.fail(`Inline expression has no computed output: ${node.value}`);
      node.type = 'span';
      // MyST's text children are a formatted fallback. Keep the complete MIME
      // bundle so inline HTML and Python string representations survive.
      node.data = { hName: 'jupyter-output', hProperties: { inline: true,
        bundle: { output_type: 'display_data', data: node.result.data, metadata: node.result.metadata } } };
      node.children = [];
      inlineOutputs.push(node);
    }
    if (node.type === 'code' && ['python3', 'ipython3', 'pycon'].includes(node.lang)) node.lang = 'python';
    if (node.type === 'admonition') decorateAdmonition(node);
    if (!supported.has(node.type)) file.fail(`Unsupported resolved MyST node: ${node.type}`);
  });
  if (stripTitle && page.frontmatter?.content_includes_title !== false) {
    let parent = tree;
    while (parent.children?.[0]?.type === 'block' && !parent.children[0].kind) parent = parent.children[0];
    if (parent.children?.[0]?.type === 'heading' && parent.children[0].depth === 1) parent.children.shift();
  }
  const outputs = [];
  visit(tree, 'output', node => { outputs.push(node); });
  for (const node of outputs) node.jupyter_data = await hydrateOutput(node.jupyter_data, assetReader);
  for (const node of inlineOutputs) node.data.hProperties.bundle = await hydrateOutput(node.data.hProperties.bundle, assetReader);
  const sources = new Map();
  await finalizeOrigins(tree, { root, sources });
  await restoreListSpacing(tree, { root, path: file.path });
  const headings = [];
  visit(tree, 'heading', node => { headings.push({ depth: node.depth, slug: node.html_id ?? node.identifier, text: headingText(node) }); });
  const processor = unified()
    .use(presentNotebooks, { interactive, presentation, sourceMaps })
    .use(remarkRehype, mystRehype(createSourceLocations(root, sources, sourceMaps, file.path)))
    .use(normalizeFootnoteIds)
    .use(rehypeJupyter).use(rehypeKatex).use(rehypeMathErrors)
    .use(rehypeExpressiveCode, {
      themeCssSelector: theme => `[data-theme="${theme.type}"]`, useDarkModeMediaQuery: false,
    })
    .use(rehypeDocumentBase, { base });
  return { html: toHtml(await processor.run(tree, file), { allowDangerousHtml: true }), metadata: { headings } };
}
