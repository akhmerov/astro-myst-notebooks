import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePresentation, publishOutput } from '../dist/presentation.js';
import { notebookToMyst } from '../dist/notebook-source.mjs';

test('presentation cascades independently from site through page to tags', () => {
  assert.deepEqual(resolvePresentation(
    { input: 'remove', cell: 'hide', stdout: 'remove', stderr: 'remove' },
    { input: 'hide', cell: 'show' }, ['show-input', 'hide-output', 'show-stderr']),
  { input: 'show', output: 'hide', cell: 'show', stdout: 'remove', stderr: 'show' });
  for (const key of ['input', 'output', 'cell', 'stdout', 'stderr']) {
    assert.equal(resolvePresentation({ [key]: 'remove' }, {}, [`show-${key}`])[key], 'show');
    assert.throws(() => resolvePresentation({}, {}, [`show-${key}`, `remove-${key}`]), /Conflicting/);
  }
  for (const invalid of [null, [], 'hide', { typo: 'show' }, { stdout: 'hide' }, { input: false }]) {
    assert.throws(() => resolvePresentation(invalid), /presentation/);
    assert.throws(() => resolvePresentation({}, invalid), /presentation/);
  }
});

test('stream filtering leaves rich outputs and execution errors intact', () => {
  const policy = resolvePresentation({ stderr: 'remove', stdout: 'remove' });
  assert.equal(publishOutput({ output_type: 'stream', name: 'stderr' }, policy), false);
  assert.equal(publishOutput({ output_type: 'stream', name: 'stdout' }, policy), false);
  assert.equal(publishOutput({ output_type: 'error' }, policy), true);
  assert.equal(publishOutput({ output_type: 'display_data' }, policy), true);
  assert.equal(publishOutput({ output_type: 'display_data' }, resolvePresentation({ output: 'hide' })), true);
  assert.equal(publishOutput({ output_type: 'display_data' }, resolvePresentation({ output: 'remove' })), false);
});

test('notebook metadata supplies page presentation, with explicit frontmatter taking precedence', () => {
  const notebook = { metadata: { presentation: { input: 'hide' } }, cells: [] };
  assert.match(notebookToMyst(notebook), /presentation: {"input":"hide"}/);
  notebook.cells.push({ cell_type: 'markdown', source: '---\npresentation: { input: remove }\n---\nContent' });
  const source = notebookToMyst(notebook);
  assert.match(source, /presentation: { input: remove }/);
  assert.equal(source.match(/presentation:/g).length, 1);
});
