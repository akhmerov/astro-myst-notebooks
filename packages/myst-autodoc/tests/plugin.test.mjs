import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VFile } from 'vfile';
import { createAutodoc } from '../index.mjs';

test('standalone lazy extraction enforces its deadline and terminates the Python process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'autodoc-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'pid');
  const python = join(root, 'slow-python');
  await writeFile(python, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n`);
  await chmod(python, 0o755);
  const plugin = createAutodoc({ modules: ['example'], python, timeout: 500 });
  const started = Date.now();
  assert.throws(() => plugin.directives[0].run({ arg: 'example' }, new VFile(), {}), /extraction deadline exceeded \(500 ms\)/);
  assert.ok(Date.now() - started < 5000, 'the deadline must bound the subprocess rather than wait for its completion');
  const pid = Number(await readFile(marker, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
