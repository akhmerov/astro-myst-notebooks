import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notebookToMyst } from '../dist/notebook-source.mjs';

const notebook = (cells, metadata = { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' } }) => ({ cells, metadata, nbformat: 4, nbformat_minor: 5 });
const markdown = source => ({ cell_type: 'markdown', metadata: {}, source });
const code = (source, tags) => ({ cell_type: 'code', metadata: tags ? { tags } : {}, outputs: [], execution_count: null, source });

test('notebooks convert to Jupytext MyST with frontmatter, tags, cell breaks, and safe fences', () => {
  const text = notebookToMyst(notebook([
    markdown(['---\n', 'title: Given\n', '---\n', 'Intro *prose*.\n']),
    markdown('Second cell.'),
    code(['x = 1\n', 'print("```")\n'], ['hide-input', 'raises-exception']),
    { cell_type: 'raw', metadata: {}, source: 'ignored' },
    markdown('# Not the title\n\nAfter raw.'),
    code('x'),
  ]));
  assert.equal(text, [
    '---', 'title: Given', 'kernelspec: {"name":"python3","language":"python","display_name":"Python 3"}', '---', '',
    'Intro *prose*.', '', '+++', '', 'Second cell.', '',
    '````{code-cell} ipython3', ':tags: ["hide-input","raises-exception"]', '', 'x = 1', 'print("```")', '````', '',
    '# Not the title', '', 'After raw.', '', '```{code-cell} ipython3', 'x', '```', '',
  ].join('\n'));
  const untitled = notebookToMyst(notebook([markdown('# Heading title\n\nBody.')], {}));
  assert.equal(untitled, '---\ntitle: "Heading title"\n---\n\n# Heading title\n\nBody.\n');
});
