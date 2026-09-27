import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('static extraction preserves overloads and module data; docstring warnings fail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-extract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extract = () => spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({ modules: ['example'], searchPaths: [directory] }), encoding: 'utf8',
  });
  await writeFile(join(directory, 'example.py'), `from typing import overload

ORIGIN: int = 0

@overload
def convert(value: int) -> int: ...
@overload
def convert(value: str) -> str: ...
def convert(value):
    """Convert a value."""
    return value

raise RuntimeError('Must never execute')
`);
  const result = extract();
  assert.equal(result.status, 0, result.stderr);
  const { objects } = JSON.parse(result.stdout);
  assert.equal(objects['example.ORIGIN'].kind, 'data');
  assert.equal(objects['example.ORIGIN'].signature, 'example.ORIGIN: int = 0');
  assert.deepEqual(objects['example.convert'].overloads, [
    'example.convert(value: int) -> int', 'example.convert(value: str) -> str',
  ]);
  await writeFile(join(directory, 'example.py'), `def f(value: int):
    """Compute.

    Parameters
    ----------
    missing : int
        This parameter does not exist.
    """
`);
  const invalid = extract();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /missing/);
});
