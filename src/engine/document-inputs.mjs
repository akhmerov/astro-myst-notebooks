import { dirname, relative, resolve } from 'node:path';

/** Record local document inputs before MyST replaces them with public URLs. */
export function createDocumentInputs(root) {
  return { transforms: [{
    name: 'astro-engine-contract', stage: 'document', plugin: () => (tree, file) => {
      const inputs = new Set();
      function add(value, source) {
        if (typeof value !== 'string' || !value || /^(#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
        let path = value.split(/[?#]/, 1)[0];
        if (!path) return;
        try { path = decodeURI(path); } catch { /* MyST will report malformed URLs. */ }
        const absolute = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(source), path);
        inputs.add(relative(root, absolute));
        return absolute;
      }
      function walk(node, source) {
        if (node.type === 'include') source = add(node.file, source) ?? source;
        if (node.type === 'image') add(node.url, source);
        if (node.type === 'iframe') add(node.src, source);
        // File downloads are inputs too. Extensionless links normally address
        // pages/routes, so they don't require a separate file watcher.
        if (['link', 'card'].includes(node.type) && /\.[\w-]+(?:[?#]|$)/.test(node.url ?? '')) add(node.url, source);
        for (const child of node.children ?? []) walk(child, source);
      }
      walk(tree, file.path);
      tree.data = { ...tree.data, astroEngine: { version: 1, inputs: [...inputs].sort() } };
    },
  }] };
}
