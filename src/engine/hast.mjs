import { mystToHast } from 'myst-to-html';
import { visit } from 'unist-util-visit';
import { createRequire } from 'node:module';

// myst-to-html renders with its own mdast-util-to-hast major; child rendering
// must use that version's `all`, not Astro's.
const { all } = await import(createRequire(import.meta.resolve('myst-to-html')).resolve('mdast-util-to-hast'));

// Render the resolved MyST tree; unsupported semantics fail before export.
// Astro's highlighting, heading collection, and rehype plugins run afterwards.
export const mystRehype = locations => ({
  handlers: { root: (state, tree) => {
    // Deterministic per-page ids for generated controls, stable across builds.
    let tabSets = 0;
    const rendered = mystToHast({
    allowDangerousHtml: true,
    handlers: {
      text: locations.text,
      block: (h, node) => h(node, 'div', { className: ['block'], dataBlock: node.meta, id: node.html_id ?? node.identifier }, all(h, node)),
      // The default MyST handlers emit `class`, which duplicates the HAST
      // `className` supplied above; browsers then discard the themed classes.
      admonition: (h, node) => h(node, 'aside', all(h, node)),
      admonitionTitle: (h, node) => h(node, 'p', all(h, node)),
      details: (h, node) => h(node, 'details', {
        id: node.html_id ?? node.identifier,
        className: node.class?.split(/\s+/).filter(Boolean),
        open: node.open,
      }, all(h, node)),
      summary: (h, node) => h(node, 'summary', all(h, node)),
      tabSet: (h, node) => {
        const id = `tabs-${++tabSets}`;
        const items = node.children.filter(child => child.type === 'tabItem');
        const selected = Math.max(0, items.findIndex(item => item.selected));
        return h(node, 'div', { className: ['tab-set'], dataTabSet: '', id: node.html_id ?? node.identifier }, [
          h(node, 'div', { className: ['tab-list'], role: 'tablist' }, items.map((item, index) => h(item, 'button', {
            type: 'button', role: 'tab', id: `${id}-tab-${index + 1}`, ariaControls: `${id}-panel-${index + 1}`,
            ariaSelected: String(index === selected), tabIndex: index === selected ? 0 : -1, dataSync: item.sync,
          }, [{ type: 'text', value: item.title }]))),
          ...items.map((item, index) => h(item, 'div', {
            className: ['tab-panel'], role: 'tabpanel', id: `${id}-panel-${index + 1}`, ariaLabelledBy: `${id}-tab-${index + 1}`,
            hidden: index !== selected,
          }, all(h, item))),
        ]);
      },
      grid: (h, node) => {
        // Up to four column counts (xs, sm, md, lg); missing sizes repeat the last one.
        const columns = [0, 1, 2, 3].map(index => node.columns[Math.min(index, node.columns.length - 1)]);
        return h(node, 'div', { className: ['grid'], id: node.html_id ?? node.identifier,
          style: ['xs', 'sm', 'md', 'lg'].map((size, index) => `--grid-${size}:${columns[index]}`).join(';') }, all(h, node));
      },
      'grid-item': (h, node) => h(node, 'div', { className: ['grid-item', ...(node.class ? node.class.split(/\s+/) : [])],
        id: node.html_id ?? node.identifier, style: node.columns ? `grid-column: span ${node.columns}` : undefined }, all(h, node)),
      card: (h, node) => {
        const part = type => node.children.filter(child => child.type === type);
        const body = node.children.filter(child => !['header', 'cardTitle', 'footer'].includes(child.type));
        const children = [
          ...part('header').map(child => h(child, 'div', { className: ['card-header'] }, all(h, child))),
          ...part('cardTitle').map(child => h(child, 'div', { className: ['card-title'] }, all(h, child))),
          ...(body.length ? [h(node, 'div', { className: ['card-body'] }, all(h, { ...node, children: body }))] : []),
          ...part('footer').map(child => h(child, 'div', { className: ['card-footer'] }, all(h, child))),
        ];
        return h(node, node.url ? 'a' : 'div', { className: ['card'], href: node.url, id: node.html_id ?? node.identifier }, children);
      },
      glossary: (h, node) => h(node, 'div', { className: ['glossary'] }, all(h, node)),
      // Diagrams render in the browser (see notebooks/diagrams.ts); the source stays readable without JS.
      mermaid: (h, node) => h(node, 'pre', { className: ['mermaid'] }, [{ type: 'text', value: node.value }]),
      // The placeholder child is for static exports; HTML embeds the frame itself.
      iframe: (h, node) => h(node, 'iframe', {
        src: node.src, title: node.title, width: node.width, loading: 'lazy', allowFullScreen: true,
        className: node.align ? [`align-${node.align}`] : undefined,
      }, []),
      definitionTerm: (h, node) => h(node, 'dt', { id: node.html_id ?? node.identifier }, all(h, node)),
      inlineCode: (h, node) => h(node, 'code', [locations.text(h, node)]),
      captionNumber: (h, node) => h(node, 'span', { className: ['caption-number'] }, [{ type: 'text', value: node.children?.map(child => child.value ?? '').join('') ?? node.enumerator ?? '' }]),
      // Use standard HAST className arrays so rehype-katex can render the math.
      math: (h, node) => h(node, 'div', { id: node.html_id ?? node.identifier }, [h(node, 'pre', [h(node, 'code', {
        className: ['language-math', 'math-display'],
      }, [{ type: 'text', value: node.enumerator ? `${node.value}\\tag{${node.enumerator}}` : node.value }])])]),
      inlineMath: (h, node) => h(node, 'span', { className: ['math-inline'] }, [
        { type: 'text', value: node.value },
      ]),
    },
    })(tree);
    locations.append(rendered);
    return rendered;
  } },
});


/** Apply Astro's deployment base to authored root-relative links and assets. */
export function rehypeDocumentBase({ base = '/' } = {}) {
  const prefix = base.replace(/\/$/, '');
  return tree => {
    if (!prefix) return;
    visit(tree, 'element', node => {
      for (const key of ['href', 'src']) {
        const value = node.properties?.[key];
        if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') &&
            value !== prefix && !value.startsWith(prefix + '/')) node.properties[key] = prefix + value;
      }
    });
  };
}


/** KaTeX reports invalid formulas as messages; documentation builds must fail. */
export function rehypeMathErrors() {
  return (_tree, file) => {
    const errors = file.messages.filter(message => message.source === 'rehype-katex');
    if (errors.length) file.fail(errors.map(message => message.cause?.message ?? message.reason).join('\n'));
  };
}
