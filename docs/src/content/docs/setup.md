---
title: Set up a site
description: Create an Astro and Starlight site with MyST documents, native Jupyter execution, and browser Python.
---

The initializer creates a documentation site inside your project and connects
it to a Pixi environment. Your repository owns its pages, branding, and Python
packages. Astro starts the build and development server; the installed
integration runs MyST and renders its resolved documents.

## Before you start

You need [Node.js](https://nodejs.org/) 22.12 or newer to run npm and the
initializer, and [Pixi](https://pixi.sh/) to manage Python and the build tools.
Your project can contain `pixi.toml` or `pyproject.toml`, or start as an empty
directory. After initialization, its Pixi environment provides Node and Python.

Download `astro-myst-notebooks-0.5.0-alpha.0.tgz` from the [GitHub prerelease](https://github.com/akhmerov/astro-myst-notebooks/releases/tag/v0.5.0-alpha.0).
To build the archive from a checkout, run `pixi run pack`. Earlier `0.4.x`
releases use a different configuration.

## Create the site

Run from the root of the project you want to document:

```sh
archive=/absolute/path/to/astro-myst-notebooks-0.5.0-alpha.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

The initializer creates:

- `docs/astro.config.mjs` and `docs/src/content.config.ts`, registering
  Starlight and the MyST content loader;
- `docs/myst.yml`, where you configure document structure and MyST settings;
- `docs/src/content/docs/index.md`, with a working Python cell;
- `docs/environment.yml`, which declares packages for browser Python;
- `docs/package.json` and its installed npm dependencies.

It adds a Pixi feature and environment named `docs`, with tasks `docs-install`,
`docs`, `docs-dev`, and `docs-preview`. A project with only `pyproject.toml` is
initialized with Pixi while preserving its existing configuration. The
initializer refuses to replace existing site files or Pixi tasks.

Useful options:

- `--api mypackage` adds Griffe and the docstring tools and configures your
  module for [Python API documentation](#include-python-api-documentation).
- `--dir site --pixi-environment site` selects different names.
- `--dry-run` lists the intended changes without writing them.

Commit the authored configuration, `environment.yml`, `pixi.lock`, and
`docs/package-lock.json`. Retain the archive at the path recorded in the npm
lockfile for later installs. Ignore generated `.astro/`, `_build/`, and
`.astro-myst.generated.yml` files; the initializer creates those ignore rules.

## Work on the documentation

```sh
pixi run -e docs docs-dev 51300
pixi run -e docs docs
pixi run -e docs docs-preview
```

The development server runs at <http://localhost:51300>; the port argument is
optional. Additional Astro flags go after `--`, for example
`pixi run -e docs docs-dev 51300 -- --host 0.0.0.0`. The `docs` task builds the
static website into `docs/dist/`, and `docs-preview` serves that build.

Write Markdown and notebooks in `docs/src/content/docs/`. The integration
rebuilds documents when source pages, includes, Python source, or the MyST
configuration change. Successful cell results are reused when their inputs
are unchanged. Restart after changing the installed Python environment or the
integration itself.

By default, the site publishes Python output from the build. Add `interactive: {}`
to `notebooks()` in `docs/astro.config.mjs` to enable browser Python. The first
build with this setting downloads packages from Emscripten-forge. Later builds
reuse that environment. On the welcome page, **Enable interactivity** starts a
browser kernel and **Run all** executes the cell.

Add scientific packages for build-time examples to Pixi, for example
`pixi add --feature docs numpy`. Add their browser equivalents to
`docs/environment.yml`; see [browser execution](browser.md).

## Configure the document project

`docs/myst.yml` is the authored MyST configuration. With no table of contents,
the integration discovers Markdown and notebook pages in the content directory.
Underscore-prefixed files and directories can hold include-only content.
To choose the page set and order explicitly, add a table of contents:

```yaml
version: 1
project:
  title: My project
  toc:
    - file: src/content/docs/index.md
    - title: Guide
      children:
        - file: src/content/docs/guide.md
```

Paths here are relative to the Astro root containing `myst.yml`. Starlight's
sidebar controls website navigation; you can configure it in `astro.config.mjs`.
The integration generates its own MyST build input from the authored settings.
You do not need a MyST theme or a separate `myst start` command.

## Add to an existing Starlight site

Install the local archive in the site's npm directory, then add the plugin:

```js
import notebooks from 'astro-myst-notebooks/starlight';

// Inside starlight({ ... }):
plugins: [notebooks()]
```

Register the collection in `src/content.config.ts`:

```ts
import { notebookCollections } from 'astro-myst-notebooks/starlight/content';

export const collections = notebookCollections();
```

Add `myst.yml` in the Astro root and an
[environment.yml](browser.md#declare-browser-packages) for browser packages.
Run Astro inside a Pixi environment satisfying the package's
`environment-contract.json`. For a site nested inside a Python project, set
its execution directory once:

```js
notebooks({ execution: { cwd: new URL('../', import.meta.url) } })
```

The default content directory is `src/content/docs/`; use `myst.source` to
choose another. Build-time output, browser assets, and public inventories are
managed by the integration. See the [reference](reference.md) for the full
configuration.

## Include Python API documentation

For a new site, use `--api mypackage`. For an existing site, add Griffe and the
optional RST converter to the selected Pixi environment and configure:

```js
notebooks({
  execution: { cwd: new URL('../', import.meta.url) },
  api: { modules: ['mypackage'], searchPaths: ['..'], parser: 'numpy' },
})
```

Griffe reads Python source without importing your package. The integration
creates API pages and typed reference inventories; you can also place an
`autodoc` directive in an authored page. No Pydocs plugin or middleware is
required. See [Python API documentation](reference.md#python-api-documentation).

Existing alpha consumers must replace the old `api.packages` and `api.runner`
configuration with `api.modules` and `api.searchPaths`. Follow the
[configuration migration](reference.md#migrate-from-the-previous-alpha) before
adopting this archive.
