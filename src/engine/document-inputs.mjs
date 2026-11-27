import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { visit } from 'unist-util-visit';

export function localTarget(root, source, value) {
  if (typeof value !== 'string' || !value || /^(#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
  const [, path, suffix = ''] = /^([^?#]+)([?#].*)?$/.exec(value) ?? [];
  if (!path) return;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return; }
  return { path: decoded.startsWith('/') ? resolve(root, '.' + decoded) : resolve(dirname(source), decoded), suffix };
}

export const isDocumentPath = path => /\.(md|ipynb)$/i.test(path);

/** Pass ordinary DOI hyperlinks through without running MyST's citation lookup. */
export function createDoiLinkPolicy() {
  return { transforms: [{
    name: 'astro-preserve-doi-links', stage: 'document', plugin: () => tree => {
      visit(tree, 'link', node => {
        if (/^https?:\/\/(?:www\.|dx\.)?doi\.org(?:\/|$)|^doi:/i.test(node.url ?? '')) {
          node.type = 'astroDoiLink';
          node.url = node.url.replace(/^doi:/i, 'https://doi.org/');
        }
      });
    },
  }, {
    name: 'astro-restore-doi-links', stage: 'project', plugin: () => tree => {
      visit(tree, 'astroDoiLink', node => { node.type = 'link'; });
    },
  }] };
}

/** Record local document inputs before MyST replaces them with public URLs. */
export function createDocumentInputs(root, repositoryLinks, routeEntries = []) {
  const fileTypes = new Map();
  const routesByFile = new Map(routeEntries);
  const routes = new Set(routesByFile.values());
  const directories = new Set(routeEntries.filter(([file]) => /(?:^|[\\/])index\.(md|ipynb)$/i.test(file)).map(([file]) => dirname(file)));
  function isSiteRoute(url, host) {
    const id = routesByFile.get(host) ?? '';
    try {
      const path = new URL(url, 'https://site.invalid/' + (id ? id + '/' : '')).pathname;
      return routes.has(decodeURIComponent(path).replace(/^\/+|\/+$/g, ''));
    } catch { return false; }
  }
  async function repositoryUrl(target, authoredUrl, host) {
    const path = relative(repositoryLinks.root, target.path);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || isDocumentPath(path)) return;
    if (!fileTypes.has(target.path)) fileTypes.set(target.path, stat(target.path).catch(() => undefined));
    const entry = await fileTypes.get(target.path);
    if (entry?.isDirectory() && (target.path === root || directories.has(target.path) || isSiteRoute(authoredUrl, host))) return;
    const base = entry?.isDirectory() ? repositoryLinks.directories : entry?.isFile() ? repositoryLinks.files : undefined;
    if (base) return base.replace(/\/$/, '') + '/' + path.split(sep).map(encodeURIComponent).join('/') + target.suffix;
  }
  return { directives: [{
    name: 'raw-html', doc: 'Embed trusted HTML verbatim, including inline SVG.',
    body: { type: String, required: true },
    run: ({ body }) => [{ type: 'astroRawHtml', value: body }],
  }], transforms: [{
    name: 'astro-engine-contract', stage: 'document', plugin: () => async (tree, file) => {
      const inputs = new Set();
      function add(value, source) {
        const target = localTarget(root, source, value);
        if (target) inputs.add(relative(root, target.path));
        return target?.path;
      }
      const redirects = [];
      function walk(node, source) {
        if (node.type === 'include') source = add(node.file, source) ?? source;
        if (node.type === 'image') add(node.url, source);
        if (node.type === 'iframe') add(node.src, source);
        // File downloads are inputs too. Extensionless links normally address
        // pages/routes, so they don't require a separate file watcher.
        if (['link', 'card'].includes(node.type)) {
          const target = localTarget(root, source, node.url);
          // MyST's download role already sets static before normal links are resolved.
          if (node.static) node.data = { ...node.data, astroExplicitDownload: true };
          else if (repositoryLinks && target) redirects.push([node, target]);
          if (/\.[\w-]+(?:[?#]|$)/.test(node.url ?? '')) add(node.url, source);
        }
        for (const child of node.children ?? []) walk(child, source);
      }
      walk(tree, file.path);
      for (const [node, target] of redirects) {
        const url = await repositoryUrl(target, node.url, file.path);
        if (url) node.url = url;
      }
      tree.data = { ...tree.data, astroEngine: { version: 1, inputs: [...inputs].sort() } };
    },
  }] };
}
