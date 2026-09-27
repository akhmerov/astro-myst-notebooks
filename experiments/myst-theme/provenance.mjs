import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { attachOrigins } from '../../dist/source-map.mjs';
import { visit } from 'unist-util-visit';
import { resolvePresentation } from '../../dist/presentation.js';

// MyST owns parsing and reference resolution. This companion transform adds
// our source identity before project references and generated text are inserted.
async function annotate(tree, path, root) {
  if (!path.endsWith('.md')) return; // Notebook JSON positions are not MyST offsets.
  const source = await readFile(path, 'utf8');
  // Filtered includes need an earlier hook carrying the original source slice.
  if (/^\s*:(start-line|end-line|start-after|end-before):/m.test(source)) {
    throw new Error('Experimental provenance does not support filtered includes');
  }
  const includes = [];
  const generated = [];
  function detach(node) {
    if (node.data?.autodocGenerated) {
      generated.push({ node, children: node.children });
      node.children = [];
    } else if (node.type === 'include') {
      includes.push({ node, children: node.children });
      node.children = [];
    } else for (const child of node.children ?? []) detach(child);
  }
  detach(tree);
  attachOrigins(tree, source, path, root);
  visit(tree, node => {
    // The document hook runs after some generated titles have been inserted.
    // Do not assign authored origins to text with no source position.
    if (node.type === 'text' && !node.position && node.data) delete node.data.origin;
    if (node.type !== 'code' || !node.executable || !node.value) return;
    const start = source.indexOf(node.value);
    if (start < 0 || source.indexOf(node.value, start + 1) >= 0) return;
    const point = offset => {
      const lines = source.slice(0, offset).split('\n');
      return { line: lines.length, column: lines.at(-1).length + 1, offset };
    };
    const range = (start, end) => ({ ...node.data.origin, start, end, kind: 'exact',
      position: { start: point(start), end: point(end) } });
    let offset = start;
    const lines = node.value.split('\n').map(line => {
      const origin = range(offset, offset + line.length);
      offset += line.length + 1;
      return origin;
    });
    node.data.origin = { ...range(start, start + node.value.length), lines };
  });
  for (const { node, children } of generated) {
    delete node.data.origin;
    node.children = children;
  }
  for (const { node, children } of includes) {
    node.children = children;
    await annotate({ type: 'root', children }, resolve(dirname(path), node.file), root);
  }
}

export default {
  name: 'Astro notebook source provenance (experimental)',
  transforms: [{
    name: 'astro-source-provenance',
    stage: 'document',
    plugin: () => async (tree, file) => {
      visit(tree, node => {
        if (node.type === 'inlineExpression') throw new Error('The experimental theme does not yet support inline eval');
        if (node.type === 'block' && node.kind === 'notebook-code') {
          const tags = node.data?.tags ?? [];
          resolvePresentation({}, {}, tags); // Reject conflicting policies before MyST consumes the tags.
          node.data = { ...node.data, astroNotebookTags: [...tags] };
        }
      });
      await annotate(tree, file.path, process.cwd());
    },
  }],
};
