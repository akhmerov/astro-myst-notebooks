# Astro MyST Notebooks

An Astro integration for MyST Markdown, Jupyter execution, MIME outputs,
browser-local Python, and source mappings for commenting. Extracted from the
Pymablock Starlight prototype; this is an experimental package, not a published
release. Pymablock remains the full-site integration test consumer.

## Develop and package

```sh
pixi run test
pixi run check
pixi run pack
```

Pixi locks Node, Python, and the Jupyter executor environment. npm locks the
JavaScript dependency graph. `npm pack` compiles TypeScript, includes the Python
adapter and runtime assets, and produces `astro-myst-notebooks-0.1.0.tgz`.
Tests import that compiled output and execute real Jupyter kernels.

The npm package is the distribution unit. There is no Python distribution:
`execute.py` is a versioned JSON adapter around `nbclient`, running with the
consumer's Python interpreter. Consumers own their Pixi requirements and lockfile.
The configured Pixi feature is checked before execution; incompatible installed
`nbclient`, `nbformat`, or `ipykernel` versions fail before page execution. This
checks declared ranges and the adapter protocol, not every possible combination
of Jupyter versions.

## Use in a Starlight site

Install the packed artifact with npm, then register the integration before
Starlight in `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import notebooks from 'astro-myst-notebooks';

export default defineConfig({
  integrations: [
    notebooks({
      execution: {
        cwd: new URL('../../', import.meta.url),
        timeout: 120,
        pixi: {
          manifest: new URL('../../pyproject.toml', import.meta.url),
          feature: 'docs',
        },
      },
      documents: new URL('./.astro/documents.json', import.meta.url),
      referenceCache: new URL('./.astro/references/', import.meta.url),
      interactive: { packages: ['numpy', 'matplotlib'] },
    }),
    starlight({ title: 'My project' }),
  ],
});
```

Paths above assume a site in `docs/site/`; adapt them to your project. Run Astro
inside your Pixi docs environment, with Python 3.11 or later and `nbclient`,
`nbformat`, `ipykernel`, and `packaging` installed. Use PEP 440 version ranges for
the three Jupyter dependencies in the named Pixi feature. Scientific packages
needed by authored examples belong to that consumer environment.

Load MyST through the public Astro glob loader wrapper in `src/content.config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { sourceLoader } from 'astro-myst-notebooks/loader';

export const collections = {
  docs: defineCollection({
    loader: sourceLoader({
      base: new URL('./content/docs/', import.meta.url),
      pattern: '**/[^_]*.md',
      documents: new URL('../.astro/documents.json', import.meta.url),
      // Optional files under base with an explicit route and title:
      // sources: { 'lessons/intro.md': { id: 'intro', title: 'Intro' } },
    }),
    schema: docsSchema(),
  }),
};
```

Use the same `documents` URL in the loader and integration. It records actual
routes for cross-page references. For sources in multiple directories, set `base`
to their common ancestor, use relative patterns, and supply Astro's `generateId`
callback to control routes. Astro does not accept patterns starting with `../`.
Rendering is deferred until page build so
execution failures fail the build. Ordinary Python fences do not execute;
MyST `{code-cell}` directives do. One fresh Jupyter kernel runs each page,
preserving cell order and hidden setup cells. No persistent execution cache is
used: every build reexecutes pages. Restart the dev server after library or
environment changes.

## API documentation and references

Use `starlight-pydocs` for API extraction, pages, and navigation. This package
provides an optional `pydocsInventory(options, destination)` loader from
`astro-myst-notebooks/pydocs`; it wraps Pydocs' public loader and writes the real
object routes to a local inventory. Pass that destination as `localInventory`
to the integration. Install `starlight-pydocs` in the consuming site when using
this adapter. Package-specific API settings and presentation belong to the site.

The integration's `references` maps project keys to either
`{ url: 'https://example.org/objects.inv' }` or
`{ file: new URL('./objects.inv', import.meta.url), base: 'https://example.org/' }`.
Sphinx v2 inventories support MyST `xref:project#target` links and the registered
`{autolink}` role. Ambiguous or missing targets fail the build. Downloaded
inventories are validated and cached; `refresh: true` explicitly refreshes them.

## Browser execution

Thebe and Thebe Lite start a JupyterLite/Pyodide kernel on activation. Runtime
assets resolve from installed dependencies and are copied by Vite. No server
backend is required. First activation needs internet access for Python and its
packages. Optional `interactive.wheel` accepts `{ project: URL, command: string[] }`;
the integration appends `-d OUTPUT_DIRECTORY`, requires exactly one wheel, and
serves it to Pyodide. `setup`, `packages`, `startupTimeout`, and `kernelName`
configure the browser environment. `interactive: false` disables live execution.

Run all preserves source order; reset terminates the kernel worker, including
an infinite loop, and preserves edited cells. Static and live output use one
MIME selection policy for text, HTML, images, LaTeX, and Plotly. Notebook output
is trusted content. Widgets and arbitrary JavaScript MIME bundles are unsupported.
Pyodide packages are separate from native Pixi packages and are not yet fully
locked. Thebe Lite 0.5 also needs a documented terminal-manager disposal guard.

## MyST and source maps

Parsing and semantics use `myst-parser`, `myst-transforms`, `myst-to-html`, and
Citation.js. Includes, local BibTeX citations, numbered targets, and cross-page
references are supported. Unsupported constructs fail explicitly; this does
not implement the entire MyST project system or arbitrary Sphinx extensions.

`window.mystSourceMap.resolve(range)` maps a DOM selection to authored text.
Results contain repository-relative paths, Git revision, content SHA-256,
UTF-16 offsets, selected text, and coverage. `kind: "exact"` identifies precise
text; `kind: "range"` is a containing source region. Generated text is unmapped.
CommonMark/GFM source positions and MyST directive tokens supply origins;
filtered includes must map uniquely to a contiguous region. Comment persistence
and relocation across revisions belong to consumers. Executable cell metadata
and structured failures retain source origins; edits in the browser do not
rewrite those original origins.

## Consumer validation

Pymablock installs a checked-in npm tarball, so its build needs no sibling path
or npm link. Its build-contract test covers repeated execution and failure
recovery; Playwright covers the complete rendered site and real browser kernels.
To update that consumer, pack this repository, replace its vendored tarball,
reinstall the file dependency to update the lockfile, and run those checks.

Originally developed in Pymablock. Distributed under its BSD-2-Clause license;
see LICENSE. Source files and runtime assets ship in `dist/`, with TypeScript
declarations for the public integration and loader APIs.
