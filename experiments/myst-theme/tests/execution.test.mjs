import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../execution.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../../node_modules/mystmd/dist/myst.cjs', import.meta.url));
const site = `site:\n  template: ${JSON.stringify(fileURLToPath(new URL('../theme', import.meta.url)))}\n`;
const walk = (node, fn) => { fn(node); for (const child of node.children ?? []) walk(child, fn); };

test('document execution respects plugin/page skip policy, cell tags, and page working directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myst-document-policy-'));
  const build = async source => {
    await writeFile(join(root, 'nested/index.md'), source);
    const result = spawnSync(process.execPath, [cli, 'build', '--site', '--strict'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MYST_THEME_EXECUTION: 'document' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const page = JSON.parse(await readFile(join(root, '_build/site/content/index.json')));
    const outputs = [];
    walk(page.mdast, node => { if (node.jupyter_data) outputs.push(node.jupyter_data); });
    return outputs;
  };
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'execution.mjs'), `import {createDocumentExecution} from ${JSON.stringify(new URL('../execution.mjs', import.meta.url).href)};\nexport default createDocumentExecution({skip: true});\n`);
    await writeFile(join(root, 'myst.yml'), `version: 1\nproject:\n  plugins: [./execution.mjs]\n  toc:\n    - file: nested/index.md\n${site}`);
    await writeFile(join(root, 'nested/helper.py'), 'value = 73\n');
    assert.deepEqual(await build('# Skipped\n\n```{code-cell} python\nraise ValueError("must not execute")\n```\n'), []);
    const outputs = await build(`---\nexecute: {skip: false}\n---\n# Policy\n
\`\`\`{code-cell} python
:tags: [skip-execution]
raise ValueError('must not execute')
\`\`\`

\`\`\`{code-cell} python
:tags: [raises-exception]
raise ValueError('intentional demonstration')
\`\`\`

\`\`\`{code-cell} python
from helper import value
print(value)
\`\`\`
`);
    assert.equal(outputs.filter(output => output.output_type === 'error').length, 1);
    assert.ok(outputs.some(output => output.text === '73\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('document execution fails explicitly when project configuration is inherited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myst-document-inherited-'));
  try {
    await writeFile(join(root, 'base.yml'), 'version: 1\nproject:\n  execute: {skip: true}\n');
    await writeFile(join(root, 'myst.yml'), `version: 1\nextends: [base.yml]\nproject:\n  plugins: [${JSON.stringify(plugin)}]\n  toc:\n    - file: index.md\n${site}`);
    await writeFile(join(root, 'index.md'), '# Inherited policy\n\n```{code-cell} python\nprint(1)\n```\n');
    const result = spawnSync(process.execPath, [cli, 'build', '--site', '--strict'], {
      cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, MYST_THEME_EXECUTION: 'document' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /does not support inherited configuration/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
