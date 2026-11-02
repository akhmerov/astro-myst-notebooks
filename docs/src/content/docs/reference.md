---
title: Configuration and API
description: Public integration options, content loaders, API documentation adapters, and inventories.
---

The Starlight preset manages integration ordering, content references, API adapters,
and the public inventory. The default export remains available for custom Astro
sites:

```ts
import notebooks from 'astro-myst-notebooks';
import type { Options } from 'astro-myst-notebooks';
import type { ExecutionOptions, InteractiveOptions } from 'astro-myst-notebooks/types';
```

Paths in the public options use `URL` objects. Resolve them from the config file
with `new URL('./relative/path', import.meta.url)`.

## Integration options

| Option | Purpose |
| --- | --- |
| `execution` | Native Jupyter settings; defaults to the Astro root and selected Python |
| `documents` | Advanced route-manifest override; defaults to the managed Astro cache |
| `referenceCache` | Advanced inventory-cache override; managed by default |
| `interactive` | Browser settings; `false` disables live execution site-wide |
| `presentation` | Defaults for `input`, `output`, `cell` (`show`, `hide`, `remove`) and `stdout`, `stderr` (`show`, `remove`); all default to `show`. Page frontmatter and cell tags override individual fields. See [notebook presentation](authoring.md#notebook-presentation). |
| `references` | Map of project keys to Sphinx v2 inventories |
| `localInventory` | Optional local API inventory, usually written by `pydocsInventory` |

The integration installs the MyST processor, native execution, MIME rendering,
KaTeX styles, source-selection support, and Plotly rendering. When interactive
execution is enabled, it also publishes Thebe and JupyterLite assets. Astro's
deployment `base` is applied to root-relative document links and assets.

### Native execution

| `execution` field | Default | Meaning |
| --- | --- | --- |
| `cwd` | Astro root | Execution root and source-map root |
| `python` | `python` | Executable used for the adapter and its kernel |
| `timeout` | `120` | Per-cell timeout in seconds |
| `pixi` | Unset | `{ manifest: URL, feature: string }` to check installed Jupyter versions against a named feature |

The adapter checks the versioned JSON protocol and the presence of `nbclient`,
`nbformat`, and `ipykernel`. Configuring `pixi` adds declared-version checks; it
does not prove compatibility with every possible Jupyter version combination.
The enclosing process also has a deadline covering hung startup and cleanup.
Each new build process executes executable pages again; there is no persistent
execution cache. Restart the dev server after changing library code or the
execution environment.

### Interactive execution

| `interactive` field | Default | Meaning |
| --- | --- | --- |
| `environment` | `environment.yml` in the Astro root | Conda environment for Xeus |
| `command` | `['jupyter', 'lite']` | Browser environment builder prefix |
| `refresh` | `false` | Resolve and build again even when a valid cache exists |
| `setup` | Empty string | Python executed on each new session |
| `startupTimeout` | `120000` | Startup deadline in milliseconds |
| `kernelName` | `xpython` | Browser kernel name |
| `wheel` | Unset | `{ project: URL, command?: string[] }` for one pure-Python wheel |
| `mounts` | `[]` | `{ source: URL, target: string }[]` copying local files or directory contents into absolute browser directories |

Native `timeout` uses seconds; browser `startupTimeout` uses milliseconds.
See [browser execution](browser.md) for environment caching and wheel requirements.

## Loader options

```ts
import { sourceLoader } from 'astro-myst-notebooks/loader';

sourceLoader({
  base: new URL('./content/docs/', import.meta.url),
  pattern: '**/[^_]*.md',
  sources: { 'lessons/intro.md': { id: 'intro', title: 'Introduction' } },
});
```

`base` defaults to `src/content/docs/`, `pattern` to `**/[^_]*.{md,ipynb}`, and
`documents` to the integration's managed cache path. Jupyter notebooks are
registered as a content entry type by the integration and rendered through the
same MyST processor; `notebookToMyst()` exposes their text representation.
`sources` supplies route IDs and titles without copying or rewriting authored
files. Its keys are paths relative to `base` and are included in the glob
patterns automatically. `generateId` accepts Astro's glob-loader callback;
explicit `sources` IDs take precedence.

The loader records Markdown and notebook routes and updates the manifest when Astro adds,
changes, or removes collection entries. Nested `index.md` pages resolve to their
containing directory. The deployment base and trailing-slash setting are applied
to the recorded URLs.

## Reference inventories

```js
references: {
  numpy: { url: 'https://numpy.org/doc/stable/objects.inv' },
  project: {
    file: new URL('./references/project.inv', import.meta.url),
    base: 'https://example.org/docs/',
  },
}
```

Use either `url` or `file`; local files also need a `base` URL for resolved
targets. Downloads are validated before entering the disk cache. A cached
inventory supports offline builds. Set `refresh: true` on an inventory to
download it again explicitly.

Write `xref:PROJECT#target` to choose a project, or use the `autolink` role for
automatic lookup. Local objects win over external matches; ambiguous external
matches need an explicit project key.

## Python API documentation

The initializer's `--api mypackage` option installs the API tools. For an existing
site, install `starlight-pydocs` and add Griffe and `rst-to-myst` to Pixi, then
configure the API-enabled Starlight preset:

```js
import notebooks from 'astro-myst-notebooks/starlight/api';

notebooks({
  api: {
    packages: [{ name: 'mypackage', search: ['..'], docstringStyle: 'numpy' }],
    runner: { command: ['python', '-m', 'griffe'] },
  },
})
```

Use `notebookCollections()` in the content configuration. The preset connects
Pydocs' public loaders, the Griffe converter, inline API components, local
references, and the combined public `objects.inv`. The consumer declares only
its packages and presentation choices. API package paths are relative to the
Astro root. Existing component customizations can use the lower-level adapters.

This package provides the following optional adapters:

| Export | Purpose |
| --- | --- |
| `pydocsInventory` from `/pydocs` | Wrap Pydocs' public loader and write actual object routes to a local inventory |
| `griffe_myst.py` from `/griffe` | Convert NumPy/RST docstrings using `rst-to-myst` |
| `/AutodocContent.astro` | Starlight MarkdownContent override rendering inline MyST API blocks through Pydocs components |
| `/CheckedDocstrings.astro` | Pydocs DocstringSections override rejecting missing prose and unknown section types |
| `exportInventory` from `/inventory` | Combine API and document targets into a public Sphinx inventory |

The Griffe extension takes `class_only`, `exclude`, and `documents` options for
class-doc conventions, excluded modules, and Sphinx document-role routes.
Consumers install `griffe` and `rst-to-myst` in their Pixi environment.

### Inline API blocks

With Pydocs and the MarkdownContent override configured:

````markdown
```{autodoc} mypackage.calculate
:heading-level: 3
```

```{autodoc} mypackage
:summary-only:
```
````

`heading-level` must be an integer from 2 to 6. `summary-only` retains a module
introduction without repeating its members. The component accepts an optional
mapping of old anchors to current anchors; `@top` means the page content start.

The `/autodoc` export also exposes `autodocOutline`, `autodocParts`, and
`assertRenderedDocstrings` for consumer presentation. These parse placements,
preserve surrounding HTML and source markers, and detect lost docstring prose.

### Export a public inventory

The Starlight preset exports this automatically. In a custom Astro integration,
call it after the content collection has rendered, for example in an
`astro:build:done` hook:

```js
await exportInventory({
  api: localInventory,
  documents,
  root: execution.cwd,
  destination: new URL('objects.inv', dir),
  base,
  labels: {},
});
```

Pass the site's deployment `base` so exported locations resolve relative to the
inventory, including under a nested prefix. Optional `labels` map names to
`{ location, display }` entries. Duplicate document labels at different
locations fail instead of silently selecting one.
