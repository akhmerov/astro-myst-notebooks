/** Render Mermaid sources in the browser and follow the site theme. */
const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
let observed = false;

export async function renderDiagrams(root: ParentNode = document) {
  const nodes = [...root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])')];
  if (!nodes.length) return;
  for (const node of nodes) node.dataset.diagram ??= node.textContent ?? '';
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, theme: theme(), securityLevel: 'strict' });
  await mermaid.run({ nodes });
  if (observed) return;
  observed = true;
  new MutationObserver(() => {
    for (const node of document.querySelectorAll<HTMLElement>('pre.mermaid[data-processed]')) {
      node.textContent = node.dataset.diagram ?? '';
      node.removeAttribute('data-processed');
    }
    void renderDiagrams();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
