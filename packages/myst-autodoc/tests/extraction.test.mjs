import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('static extraction preserves overloads and module data; docstring warnings fail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-extract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extract = (options = {}) => spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({ modules: ['example'], searchPaths: [directory], ...options }), encoding: 'utf8',
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
  const warned = extract({ docstringWarnings: 'warn' });
  assert.equal(warned.status, 0, warned.stderr);
  const model = JSON.parse(warned.stdout);
  assert.ok(model.diagnostics.some(item => item.level === 'warning' && item.message.includes('missing')));
  const parameters = model.objects['example.f'].sections.find(section => section.kind === 'parameters');
  assert.equal(parameters.entries[0].name, 'missing');
  assert.match(parameters.entries[0].description, /This parameter does not exist/);
});

test('RST document roles normalize wrapped titles and require an explicit destination mapping', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-rst-doc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'example.py'), `def f():
    """See :doc:\`second quantization
    documentation <../second_quantization>\` and :doc:\`guide\`.

    Also see :doc:\`a   wrapped
    title <../second_quantization>\`.
    """
`);
  const extract = documents => spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({ modules: ['example'], searchPaths: [directory], markup: 'rst', documents }), encoding: 'utf8',
  });
  const result = extract({ '../second_quantization': '/second_quantization/', guide: '/guide/' });
  assert.equal(result.status, 0, result.stderr);
  const text = JSON.parse(result.stdout).objects['example.f'].sections.find(section => section.kind === 'text').text;
  assert.match(text, /\[second quantization documentation\]\(\/second_quantization\/\)/);
  assert.match(text, /\[guide\]\(\/guide\/\)/);
  assert.match(text, /\[a wrapped title\]\(\/second_quantization\/\)/);

  const missing = extract({ guide: '/guide/' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RST document reference '\.\.\/second_quantization' requires an api\.documents mapping/);
});

test('public aliases include inherited members and constructor documentation with distinct subclass targets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-inheritance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'example.py'), `class Base:
    """Base class description."""

    def __init__(self, value: int = 2):
        """Initialize the value.

        Parameters
        ----------
        value : int
            The initial value.
        """
        self.value = value

    def scale(self, factor: int = 2) -> int:
        """Multiply the stored value."""
        return self.value * factor

class Child(Base):
    """Child class description."""

from example import Child as Alias
`);
  const result = spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({ modules: ['example'], searchPaths: [directory] }), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { objects } = JSON.parse(result.stdout);
  assert.equal(objects['example.Child'].signature, 'example.Child(value: int = 2)');
  assert.deepEqual(objects['example.Child'].bases, [{ name: 'Base', target: 'example.Base' }]);
  const sections = objects['example.Child'].sections;
  assert.match(sections.find(section => section.kind === 'text').text, /Child class description[\s\S]*Initialize the value/);
  assert.equal(sections.find(section => section.kind === 'parameters').entries[0].name, 'value');
  assert.ok(objects['example.Child'].members.includes('example.Child.scale'));
  assert.equal(objects['example.Child.scale'].canonical, 'example.Child.scale');
  assert.equal(objects['example.Base.scale'].canonical, 'example.Base.scale');
  assert.equal(objects['example.Alias.scale'].canonical, 'example.Child.scale');
  assert.ok(objects['example.Child.scale'].aliases.includes('example.Alias.scale'));
});

test('module __all__ excludes undocumented submodules while explicit configured modules remain available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-public-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = join(directory, 'example');
  await mkdir(pkg);
  await writeFile(join(pkg, '__init__.py'), 'from ._impl import Public\n__all__ = ["Public"]\n');
  await writeFile(join(pkg, '_impl.py'), 'class Public:\n    """A public class."""\n');
  await writeFile(join(pkg, 'extra.py'), '__all__ = ["useful"]\ndef useful():\n    """An explicitly documented function."""\nclass Hidden:\n    """An explicitly documented class outside __all__."""\n');
  await writeFile(join(pkg, 'tests.py'), 'def test_private():\n    """Unsupported :not-a-real-role:`test-only prose`."""\n');
  const extract = modules => spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({ modules, searchPaths: [directory], markup: 'rst' }), encoding: 'utf8',
  });
  const result = extract(['example', 'example.extra', 'example.extra.Hidden']);
  assert.equal(result.status, 0, result.stderr);
  const { objects } = JSON.parse(result.stdout);
  assert.ok(objects['example.Public']);
  assert.deepEqual(objects.example.members, ['example.Public']);
  assert.ok(objects['example.extra.useful']);
  assert.ok(objects['example.extra.Hidden']);
  assert.deepEqual(objects['example.extra'].members, ['example.extra.useful']);
  assert.ok(!Object.keys(objects).some(name => name.startsWith('example.tests')));
  const explicitInvalid = extract(['example.tests']);
  assert.notEqual(explicitInvalid.status, 0, 'explicitly selected invalid documentation must still fail');
  assert.match(explicitInvalid.stderr, /Unsupported RST role: not-a-real-role/);
});

test('optional NumPy parameter types preserve their prose and produce structured diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'autodoc-types-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'example.py'), '"""Compute.\n\nParameters\n----------\nvalue\n    An untyped, documented input.\n"""\n');
  const result = spawnSync('python', [fileURLToPath(new URL('../extract.py', import.meta.url))], {
    input: JSON.stringify({modules:['example'],searchPaths:[directory]}), encoding:'utf8',
  });
  assert.equal(result.status,0,result.stderr);
  const model=JSON.parse(result.stdout);
  assert.ok(model.diagnostics.some(item=>item.message.includes('No types or annotations')));
  assert.match(JSON.stringify(model.objects.example.sections),/An untyped, documented input/);
});
