---
title: Configuration and API
description: Configure the Astro-led MyST compiler, Python execution, content loading, and API documentation.
---

Use the Starlight preset for a documentation site, or the default integration
for another Astro site:

```ts
import notebooks from 'astro-myst-notebooks/starlight';
// For plain Astro: import notebooks from 'astro-myst-notebooks';
import type { Options } from 'astro-myst-notebooks';
import type { ExecutionOptions, InteractiveOptions } from 'astro-myst-notebooks/types';
```

Astro owns the build and development commands. The integration launches the
pinned MyST CLI to produce resolved documents, then loads and renders those
results. MyST owns includes, labels, references, and document transforms. The
integration supplies nbclient execution, source provenance, and browser assets.

## Integration options

| Option | Purpose |
| --- | --- |
| `myst` | Authored MyST configuration, content source directory, and document-build deadline |
| `execution` | Build-time Jupyter settings and execution cache inputs |
| `api` | Optional static Python API extraction and generated pages |
| `interactive` | Browser Python settings; `false` disables live execution site-wide |
| `presentation` | Defaults for input, output, cell, stdout, and stderr visibility |

Resolve configuration paths from `astro.config.mjs` with URL objects, for
example `new URL('../', import.meta.url)`. API search paths accept strings relative
to the Astro root or file URL objects. Astro's deployment `base` and trailing-slash setting apply to
rendered document links and published assets.

### MyST project

| `myst` field | Default | Meaning |
| --- | --- | --- |
| `config` | `myst.yml` in the Astro root | Authored MyST project configuration |
| `source` | `src/content/docs/` | Directory for automatic page discovery |
| `buildTimeout` | `180000` | Deadline for the MyST document command, in milliseconds |

The integration supports one MyST project per Astro site. `myst.config` must
reside in the Astro root so generated configuration preserves relative paths.
An explicit
`project.toc` in `myst.yml` chooses the pages and their order. Without one,
Markdown and notebook files are discovered under `myst.source`; names beginning
with `_` or `.` are excluded from automatic page discovery. Nested `index.md`
pages use their containing directory's route. Frontmatter `slug` can select an
explicit route.

The authored `myst.yml` remains yours. `.astro-myst.generated.yml`, `_build/`,
and `.astro/` are generated build input, resolved documents, and caches; ignore
them in Git. Change website appearance and components through Astro/Starlight,
rather than a MyST HTML template.

### Native execution

| `execution` field | Default | Meaning |
| --- | --- | --- |
| `cwd` | Astro root | Python working directory and source-map root |
| `python` | `python` | Existing interpreter for nbclient and its kernel |
| `timeout` | `30` | Per-cell timeout in seconds |
| `concurrency` | `1` | Maximum native kernels executing together |
| `dependencies` | `[]` | Additional Python or data inputs, as paths or file URLs |
| `pixi` | Unset | `{ manifest: URL, feature: string }` for declared Jupyter-version checks |

The adapter executes each page that needs computation in a fresh kernel. It
uses the selected interpreter directly, rather than choosing a different Python
through an installed kernelspec. Python kernel names `python`, `python3`, and
`ipython3` are accepted; other names and languages fail explicitly.
Pages with `kernelspec` frontmatter and Jupyter notebooks execute from their
source directory. Other pages use `execution.cwd`.

The adapter checks `nbclient`, `nbformat`, and `ipykernel` against the package's
environment contract. `pixi` also checks the named feature's declared versions.
Per-cell timeouts fail the build. The outer execution deadline covers startup
and cleanup, and terminates the kernel process as well as the adapter if they
hang. Reader-side browser Python has a separate lifecycle.

Successful outputs are cached under the managed Astro cache. Executable source,
cell tags, settings, Python source under the project and execution directories,
and environment manifests/lockfiles contribute to the cache key. Prose-only
edits reuse computed outputs. Declare external or data inputs explicitly:

```js
notebooks({
  execution: {
    cwd: new URL('../', import.meta.url),
    timeout: 60,
    concurrency: 2,
    dependencies: [new URL('../data/measurements.csv', import.meta.url)],
  },
})
```

Paths given as strings in `dependencies` resolve from the Astro root. For an
input represented by an environment variable, list its name in page frontmatter:

```yaml
execute:
  skip: false
  cache: true
  depends_on_env: [DOCUMENT_DATA_VERSION]
```

`execute.skip` disables build execution for the page; `execute.cache: false`
disables output reuse. `depends_on_env` invalidates outputs when the listed
values change. These are the supported `execute` keys; other keys fail rather
than being ignored. The older `skip_execution` alias is accepted, with an
explicit `execute.skip` taking precedence. Cell tags can skip individual cells
or allow an expected exception; see [execution controls](authoring.md#execution-is-independent).

Restart the development server after changing the installed interpreter or its
packages. An external data file changes the cache key when a build runs; if it
is outside the watched source tree, trigger a rebuild after editing it.

### Interactive execution

Xeus is the Python kernel used in the reader's browser. Thebe provides its
editors and buttons. Building that environment requires JupyterLite tools in
an existing Pixi environment; those tools are distinct from reader Python.

| `interactive` field | Default | Meaning |
| --- | --- | --- |
| `python` | The selected execution Python | Optional existing interpreter for browser-build tooling |
| `environment` | `environment.yml` in the Astro root | Browser conda environment declaration |
| `command` | `['jupyter', 'lite']` | Browser environment builder prefix |
| `refresh` | `false` | Resolve and build the browser environment again |
| `setup` | Empty string | Python run in each new browser session |
| `startupTimeout` | `120000` | Browser startup deadline in milliseconds |
| `kernelName` | `xpython` | Browser kernel name |
| `wheel` | Unset | `{ project: URL, command?: string[] }` for one pure-Python wheel |
| `mounts` | `[]` | `{ source: URL, target: string }[]` for browser files or directories |

`interactive.python` selects build tools only. It does not change the reader's
kernel from Xeus or install a second Python distribution. Set it when the
JupyterLite tools already live in another Pixi environment. See
[browser execution](browser.md) for environment caching, mounts, and wheels.

Site-wide `interactive: false` removes live execution. Page frontmatter
`thebe: false` disables controls only on that page. Top-level page
`presentation` and `thebe` settings remain supported by the Astro metadata adapter.

## Loader options

The standard Starlight collection is:

```ts
import { notebookCollections } from 'astro-myst-notebooks/starlight/content';
export const collections = notebookCollections();
```

For a custom collection:

```ts
import { sourceLoader } from 'astro-myst-notebooks/loader';

sourceLoader({
  sources: { 'lessons/intro.md': { id: 'intro', title: 'Introduction' } },
});
```

The loader reads MyST's resolved documents and does not execute Python during
rendering. `sources` supplies route IDs and titles for paths relative to the
content source directory. Choose the directory with integration `myst.source`;
`base` remains available as a loader override. The old glob `pattern` and
`generateId` callback are not part of this loader. Use `project.toc`, frontmatter
`slug`, or `sources` for page selection and routing.

The `/loader` export also provides `notebookToMyst()` to regenerate the MyST text
representation used for notebook source-map offsets.
`navigationFromManifest()` reads the resolved MyST manifest and retains its
group headings and page slugs for navigation tooling. Astro still owns the sidebar.

In development, edits to included files and local document assets rebuild the
affected site. Document inputs do not invalidate the notebook execution cache
unless they are also execution inputs, such as imported Python source or files
listed in `execution.dependencies`.

## Reference inventories

A Sphinx inventory (`objects.inv`) lists named objects and the pages that
document them. MyST's `myst.xref.json` also advertises document targets and
resolved page data. The integration publishes both, including typed Python
entries when API extraction is enabled. Locations respect the deployment prefix.

Configure cross-project MyST references in `myst.yml`:

```yaml
project:
  references:
    other: https://example.org/documentation/
```

Then write `[A target](xref:other#target-name)`. For Python inventory references
inside API prose or `{autolink}` roles, use `api.externalReferences` as shown
below. Missing names, wrong Python kinds, and ambiguous short names fail
explicitly.

## Python API documentation

Griffe reads source files without importing the package. Install
`griffe>=1,<3` in the extraction environment; RST docstrings also require
`rst-to-myst>=0.4,<0.5`. The initializer's `--api` option adds these requirements.
Configure the ordinary Starlight plugin:

```js
import notebooks from 'astro-myst-notebooks/starlight';

notebooks({
  api: {
    modules: ['mypackage'],
    searchPaths: ['..'],
    parser: 'numpy',
    markup: 'myst',
    externalReferences: { numpy: 'https://numpy.org/doc/stable/' },
  },
})
```

`modules` lists the Python modules to document. A module's explicit `__all__`
limits its public members. Add another module or an individual dotted object
path to this list when it needs documentation outside that public export set.
This does not select test modules merely because they live in the package.

`parser` selects the docstring convention: `numpy`, `google`, or `sphinx`.
`markup` selects the prose syntax: `myst` or `rst`. These choices are independent;
NumPy-style docstrings can contain RST.

By default extraction uses `execution.python`. Optional `api.python` selects
another existing interpreter with Griffe, without changing the kernel used to
execute examples. This can use an already configured Pixi environment; it does
not create or install a Python distribution.

The integration generates module, class, function, and data pages under `api/`, using
public Python names for their routes. Public aliases share the documented
object's target. Class pages include inherited public members and merge
constructor documentation. Typed Sphinx inventory entries retain Python's
case-sensitive names.

`api.timeout` sets the deadline for static extraction in milliseconds. It defaults
to 30,000.
Class pages also show statically declared bases, linking known local classes.
Unavailable external bases remain code text. Static extraction cannot discover
attributes created at runtime or members of an unavailable external base.

For RST document roles such as `` :doc:`guide` ``, map the document name to its
destination with `api.documents`, for example `{ guide: '/guide/' }`. Destinations
can also be relative links or full URLs. The default `docstringWarnings: 'error'`
fails malformed docstring sections. Set `api.docstringWarnings: 'warn'` to
retain existing prose while reporting Griffe diagnostics as warnings. Missing
optional NumPy parameter type labels are warnings with either policy. Unsupported
RST syntax and unresolved references still fail.

### Inline API blocks

Place an object in an authored page when it needs surrounding explanation:

````markdown
```{autodoc} mypackage.calculate
:heading-level: 3
```

```{autodoc} mypackage
:summary-only:
```
````

`heading-level` accepts integers from 2 to 6. `summary-only` omits the signature.
Use `:members: *` or comma-separated member names to include public members of
a class. An authored placement suppresses that object's automatically generated
page; duplicate authored definitions fail.

Use `{py:func}`, `{py:class}`, `{py:meth}`, `{py:attr}`, `{py:mod}`, `{py:data}`,
or `{py:obj}` for typed references. `{autolink}` accepts any Python kind.
Unqualified names must identify one canonical object; `~` shortens the visible
name without changing the target.

The root archive carries the canonical standalone plugin's runtime files.
Consumers do not import anything from this checkout and need no unpublished
workspace dependency. See [development](development.md#standalone-autodoc-workspace)
for packaging that plugin independently.

## Migrate from the previous alpha

This is a breaking alpha migration. Keep your Astro configuration and browser
runtime settings, then make these changes:

- Replace `api.packages` and `api.runner` with `api.modules`, `api.searchPaths`,
  `api.parser`, and `api.markup`.
- Use the ordinary `/starlight` plugin and `notebookCollections()`; remove
  Pydocs middleware, component overrides, and API collections.
- Put MyST project settings in `myst.yml`. Replace loader glob callbacks with
  a MyST table of contents, frontmatter slugs, or explicit source metadata.
- Let the integration publish inventories. The previous Pydocs inventory and
  docstring adapters are not part of the recommended API.
- Move cross-project links to MyST `project.references` and Python inventory
  mappings to `api.externalReferences`. The old top-level `references`,
  `localInventory`, `referenceCache`, and `documents` options are rejected.
- Remove obsolete generated caches, then run the archive consumer checks and
  your project's build, links, source-map, and browser tests.

Source files, presentation settings, notebook tags, and browser environment
choices remain authored in the consumer. The archive includes its Python
adapter; there is no separately published Python integration package.
