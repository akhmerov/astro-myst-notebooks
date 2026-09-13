import { mystParse } from 'myst-parser';
import { autodocDirective } from './autodoc.mjs';
import { mystToHast } from 'myst-to-html';
import { visit } from 'unist-util-visit';

import { autolinkRole } from './references.mjs';
import { resolveDocument } from './documents.mjs';
import { sourceText } from './source-map.mjs';

/** @type {import('unified').Plugin<[object?], import('mdast').Root>} */
export const remarkMyst = function (options = {}) {
  // MyST exports a unified v10 plugin; Astro uses unified v11's `parser` slot.
  // Parsing, including directive options and cell tags, stays in myst-parser.
  this.parser = (source, file) => {
    const tree = mystParse(source, { vfile: file, roles: [autolinkRole], directives: [autodocDirective] });
    const errors = file.messages.filter(message => message.fatal === true);
    if (errors.length) file.fail(errors.map(message => message.reason).join('\n'));
    tree.data = { ...tree.data, source };
    return tree;
  };
  return async (tree, file) => {
    // MDX is used internally by Starlight; it has its own parser and renderer.
    if (file.extname === '.mdx') return;
    const resolved = await resolveDocument(tree.data?.source ?? String(file.value), file, options);
    tree.children = resolved.children;
    visit(tree, 'code', node => {
      if (node.lang === 'ipython3' || node.lang === 'python3' || node.lang === 'pycon') node.lang = 'python';
    });
    // Starlight renders the document title separately from its body.
    if (tree.children[0]?.type === 'heading' && tree.children[0].depth === 1) tree.children.shift();
    visit(tree, 'admonition', node => {
      const classes = (node.class ?? '').split(/\s+/);
      const kind = node.kind ?? classes.find(c => ['note', 'tip', 'hint', 'warning', 'important'].includes(c)) ?? 'note';
      if (node.children[0]?.type !== 'admonitionTitle') node.children.unshift({
        type: 'admonitionTitle', children: [{ type: 'text', value: kind.charAt(0).toUpperCase() + kind.slice(1) }],
      });
      node.data = { hName: classes.includes('dropdown') ? 'details' : 'aside', hProperties: {
        className: [...classes.filter(Boolean), 'starlight-aside', `starlight-aside--${kind === 'warning' ? 'caution' : 'note'}`],
      } };
      node.children[0].data = { hName: classes.includes('dropdown') ? 'summary' : 'p', hProperties: { className: ['starlight-aside__title'] } };
    });
  };
};

// Render the resolved MyST tree; unsupported semantics fail before export.
// Astro's highlighting, heading collection, and rehype plugins run afterwards.
export const mystRehype = {
  handlers: { root: (state, tree) => mystToHast({
    allowDangerousHtml: true,
    handlers: {
      text: sourceText,
      inlineCode: (h, node) => h(node, 'code', [sourceText(h, node)]),
      captionNumber: (h, node) => h(node, 'span', { className: ['caption-number'] }, [{ type: 'text', value: node.children?.map(child => child.value ?? '').join('') ?? node.enumerator ?? '' }]),
      // Use standard HAST className arrays so rehype-katex can render the math.
      math: (h, node) => h(node, 'div', { id: node.html_id ?? node.identifier }, [h(node, 'pre', [h(node, 'code', {
        className: ['language-math', 'math-display'],
      }, [{ type: 'text', value: node.enumerator ? `${node.value}\\tag{${node.enumerator}}` : node.value }])])]),
      inlineMath: (h, node) => h(node, 'span', { className: ['math-inline'] }, [
        { type: 'text', value: node.value },
      ]),
    },
  })(tree) },
};


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
