import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visit } from 'unist-util-visit';
import { notebookToMyst, notebookEntry } from '../dist/notebook-source.mjs';
import { resolveDocument } from '../dist/documents.mjs';

const nodes = (tree, type) => { const found = []; visit(tree, type, node => { found.push(node); }); return found; };
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
  const entry = notebookEntry(JSON.stringify(notebook([markdown('---\ntitle: T\nslug: custom\n---\nBody'), code('1')])));
  assert.equal(entry.data.title, 'T');
  assert.equal(entry.slug, 'custom');
  assert.equal(entry.data.kernelspec.name, 'python3');
  assert.equal(entry.body, 'Body\n\n```{code-cell} ipython3\n1\n```');
});

test('notebook pages take part in cross-page references and carry MyST-representation source maps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myst-notebooks-'));
  try {
    const path = join(root, 'analysis.ipynb');
    await writeFile(path, JSON.stringify(notebook([markdown('---\ntitle: Analysis\n---\n(result)=\n## Result\n\nA **phrase** and [back](index.md).'), code('1 + 1')])));
    const page = '---\ntitle: Index\n---\n\nSee [](analysis.ipynb#result) and [](analysis.ipynb).';
    await writeFile(join(root, 'index.md'), page);
    const manifest = join(root, 'documents.json');
    await writeFile(manifest, JSON.stringify([{ path: join(root, 'index.md'), url: '/' }, { path, url: '/analysis/' }]));
    const tree = await resolveDocument(page, { path: join(root, 'index.md') }, { root, documents: manifest });
    assert.deepEqual(nodes(tree, 'link').map(node => node.url), ['/analysis/#result', '/analysis/']);
    const rendered = await resolveDocument(notebookEntry(await (await import('node:fs/promises')).readFile(path, 'utf8')).body, { path }, { root, documents: manifest });
    const phrase = nodes(rendered, 'text').find(node => node.value === 'phrase');
    assert.equal(phrase.data.origin.file, 'analysis.ipynb');
    assert.equal(phrase.data.origin.representation, 'myst');
    assert.equal(phrase.data.origin.kind, 'exact');
    const text = notebookToMyst(JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')));
    assert.equal(text.slice(phrase.data.origin.start, phrase.data.origin.end), 'phrase');
    assert.ok(nodes(rendered, 'link').some(node => node.url === '/'));
    assert.ok(nodes(rendered, 'code').some(node => node.executable && node.lang === 'ipython3'));
  } finally { await rm(root, { recursive: true }); }
});
