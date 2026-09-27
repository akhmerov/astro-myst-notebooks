# Python autodoc for MyST

This experimental plugin turns Python docstrings into MyST API pages. It uses
Griffe to read Python source without importing the package. Its output uses
standard MyST nodes and works independently of Astro or Starlight.

The build command also publishes Python object types in `objects.inv`, the index
that Sphinx uses to link to other projects. Public re-exports and implementation
names point to the same documented object. Ordinary MyST targets remain available
in `myst.xref.json`.

## Install and configure

You need Node 22.12 or newer, MyST 1.11, and a Python environment with
`griffe>=1,<3`. For reStructuredText docstrings, also install `rst-to-myst>=0.4,<0.5`.
The plugin uses that environment's `python`; it does not install an interpreter.

The package is not published. From this repository, create an archive:

```sh
pixi run npm pack ./packages/myst-autodoc
```

Install that archive and MyST in your documentation project:

```sh
npm install /path/to/astro-myst-notebooks-autodoc-0.1.0.tgz mystmd@1.11.0
```

Create `autodoc.mjs` beside `myst.yml`:

```js
import { createAutodoc } from '@astro-myst-notebooks/autodoc';

export default createAutodoc({
  modules: ['mypackage'],
  searchPaths: ['../src'],
  parser: 'numpy',
  markup: 'myst',
});
```

Paths are relative to the directory where you run MyST. `python` can specify
another Python executable. `parser` selects the docstring section convention:
`numpy`, `google`, or `sphinx`. `markup` selects the prose syntax: `myst` or `rst`.
These are separate choices; NumPy-style docstrings can contain either markup.

Register the plugin:

```yaml
version: 1
project:
  plugins:
    - autodoc.mjs
  toc:
    - file: index.md
    - file: api.md
site:
  template: book-theme
```

Write API pages yourself and place objects where you want them:

````md
# Python API

:::{autodoc} mypackage.solve
:::

:::{autodoc} mypackage.Result
:members: scale, value
:heading-level: 2
:::

See {py:func}`mypackage.solve` and {py:class}`mypackage.Result`.
````

`members` accepts comma-separated direct public members, or `*` for all direct
public members. It does not recurse. Headings default to level 2. `summary-only`
omits the signature and cannot be combined with `members`. Document each object
once; use references for additional appearances.

Python roles include `py:func`, `py:class`, `py:meth`, `py:attr`, `py:mod`,
`py:data`, and `py:obj`, with unprefixed aliases. In docstrings, short names resolve
in the containing Python scope. Explicit titles and `~` shortening are supported.
RST equivalents such as `:class:` are converted when `markup: 'rst'` is selected.

## Build and publish

```sh
npx myst-autodoc build -- --html --strict
```

This runs MyST, merges typed Python entries into `_build/site/objects.inv`, and
updates `_build/html/objects.inv`. Publish the entire `_build/html` directory.
The wrapper is needed because MyST 1.11 exports targets as generic labels.
It reads resolved page URLs and anchors; it does not derive routes from Python names.

For content JSON without HTML, run `npx myst-autodoc build`. To augment an existing
build or a theme's custom output, run:

```sh
npx myst-autodoc inventory --site _build/site --output path/to/published/objects.inv
```

`--output` can be repeated. For a site hosted below `/docs/`, set MyST's
`BASE_URL=/docs` and pass `--base /docs/` before the `--` separator. Exported
inventory destinations are relative to the inventory, so Sphinx preserves that
hosting prefix. Restart the build after Python edits; watch mode is unsupported.

Other Sphinx projects can use normal Intersphinx configuration and typed Python
references without installing this plugin. Other MyST projects can use their
`project.references` configuration and links such as
`[Result](xref:yourproject#mypackage.result)`. MyST labels are case insensitive;
the Sphinx inventory preserves Python's case-sensitive names. Conflicting Python
names that differ only in case are rejected.

To link from Python docstrings to external documentation, map Python prefixes to
documentation URLs (or explicit inventory URLs):

```js
// An additional createAutodoc option:
externalReferences: { numpy: 'https://numpy.org/doc/stable/' }
```

An explicit `py:class` reference to `numpy.ndarray` then uses that inventory.
Both local and external Python references are checked for the expected kind.
The plugin preserves case in Sphinx's `$` anchor shorthand, avoiding a bug in
MyST 1.11's bundled inventory reader. Inventories are fetched once per build;
missing or ambiguous Python references fail explicitly. Ordinary MyST `xref:`
links continue to use MyST's own `project.references` configuration and resolver.

## Scope and validation

The initial implementation supports modules, classes, functions, methods,
attributes, properties, overload signatures, structured docstring sections,
and public aliases. It does not generate page trees, merge constructor prose,
expand inherited members, automatically link signature annotations, or inspect
extension modules. Relative links in docstrings resolve from the authored API
page. Generated prose carries Python file/line metadata, not Markdown source offsets.
Unknown constructs and extraction warnings fail explicitly.

From this repository:

```sh
pixi install -e interop
pixi run npm run autodoc:test
```

Tests consume a packed plugin, build API content, and check signatures, aliases,
rebuilds, errors, and links in both directions. A separate temporary Sphinx 9
project reads the published inventory through HTTP; its dependencies live only
in the `interop` Pixi environment. A plain MyST consumer has no autodoc plugin.
The theme example in `experiments/myst-theme/` exercises the same plugin.
