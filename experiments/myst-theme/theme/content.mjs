import { resolve } from 'node:path';
import { unified } from 'unified';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import { mystRehype, rehypeDocumentBase, rehypeMathErrors } from '../../../dist/myst.mjs';
import { remarkJupyter } from '../../../dist/jupyter.mjs';
import { rehypeJupyter } from '../../../dist/mime.mjs';
import rehypeExpressiveCode from 'rehype-expressive-code';

const supported = new Set([
  'root', 'block', 'paragraph', 'heading', 'text', 'emphasis', 'strong', 'delete',
  'inlineCode', 'code', 'link', 'image', 'list', 'listItem', 'blockquote',
  'thematicBreak', 'break', 'html', 'comment', 'math', 'inlineMath',
  'admonition', 'admonitionTitle', 'container', 'caption', 'captionNumber',
  'table', 'tableRow', 'tableCell', 'definitionList', 'definitionTerm',
  'definitionDescription', 'subscript', 'superscript', 'abbreviation',
]);

export async function fetchJson(path) {
  const response = await fetch(new URL(path, process.env.CONTENT_CDN));
  if (!response.ok) throw new Error(`MyST content request failed: ${path} (${response.status})`);
  return response.json();
}

export function pagesFromManifest(manifest) {
  if (manifest.version !== 3 || manifest.projects?.length !== 1 || manifest.projects[0].slug) {
    throw new Error('The experimental theme supports one unprefixed MyST project (manifest v3)');
  }
  const project = manifest.projects[0];
  return [{ slug: project.index, id: '', title: project.title }, ...project.pages.map(page => {
    if (!page.slug) throw new Error('The experimental theme requires a flat table of contents');
    return { ...page, id: page.slug };
  })];
}

export async function renderPage(page, { root, base = '/', interactive = true } = {}) {
  const tree = structuredClone(page.mdast);
  const file = new VFile({ path: resolve(root, page.location.replace(/^\//, '')),
    data: { astro: { frontmatter: page.frontmatter } } });
  visit(tree, node => {
    if (node.type === 'crossReference') {
      if (!node.resolved) file.fail(`Unresolved MyST reference: ${node.identifier}`);
      node.type = 'link';
      node.url = `${node.url ?? ''}#${node.html_id ?? node.identifier}`;
    }
    if (node.type === 'include') node.type = 'block';
    // The HTML adapter uses identifier for some targets (notably headings).
    // MyST has already resolved the actual HTML anchor, which may differ.
    if (node.html_id && node.type !== 'link') node.identifier = node.html_id;
    if (node.type === 'block' && node.kind === 'notebook-code') {
      const code = node.children.find(child => child.type === 'code');
      const outputs = node.children.find(child => child.type === 'outputs');
      if (!code) file.fail('Notebook block has no executable source');
      // MyST converts presentation tags into visibility fields. Restore the
      // public presentation contract for our existing static/live renderer.
      const tags = [...(node.data?.astroNotebookTags ?? node.data?.tags ?? [])];
      for (const [part, visibility] of [['cell', node.visibility], ['input', code.visibility], ['output', outputs?.visibility]]) {
        if (visibility && visibility !== 'show' && !tags.includes(`${visibility}-${part}`)) tags.push(`${visibility}-${part}`);
      }
      node.data = { ...node.data, tags };
      // Like the existing Astro integration, native outputs are freshly
      // executed with nbclient, including for .ipynb input. Do not execute MyST
      // with --execute as well: that would run the same code twice.
      node.children = node.children.filter(child => child.type !== 'outputs');
    }
    if (node.type === 'code' && ['python3', 'ipython3', 'pycon'].includes(node.lang)) node.lang = 'python';
    if (!supported.has(node.type)) file.fail(`Experimental theme does not render MyST node: ${node.type}`);
  });
  const headings = [];
  visit(tree, 'heading', node => {
    const words = [];
    visit(node, child => { if (child.type === 'text' || child.type === 'inlineCode') words.push(child.value); });
    headings.push({ depth: node.depth, slug: node.html_id ?? node.identifier, text: words.join('') });
  });
  const processor = unified()
    .use(remarkJupyter, { cwd: root, timeout: 30, interactive })
    .use(remarkRehype, mystRehype)
    .use(rehypeJupyter).use(rehypeKatex).use(rehypeMathErrors)
    .use(rehypeExpressiveCode, {
      themeCssSelector: theme => `[data-theme="${theme.type}"]`,
      useDarkModeMediaQuery: false,
    })
    .use(rehypeDocumentBase, { base });
  return { html: toHtml(await processor.run(tree, file)), metadata: { headings } };
}

export function mystContent() {
  return {
    name: 'experimental-myst-content',
    async load({ store, parseData, config }) {
      const manifest = await fetchJson('/config.json');
      store.clear();
      for (const entry of pagesFromManifest(manifest)) {
        const page = await fetchJson(`/content/${entry.slug}.json`);
        const rendered = await renderPage(page, {
          root: process.env.ASTRO_MYST_PROJECT, base: config.base,
        });
        const id = entry.id || 'index';
        const data = await parseData({ id, data: { title: page.frontmatter.title ?? entry.title } });
        store.set({ id, data, rendered });
      }
    },
  };
}
