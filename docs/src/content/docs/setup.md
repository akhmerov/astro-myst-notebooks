---
title: Set up a site
description: Create a working Starlight site with native Jupyter and a prepared Xeus browser environment.
---

The initializer creates a working site and connects it to a Pixi environment.
Your repository owns its pages, branding, and Python packages. The installed
integration owns rendering, routes, caches, and browser assets.

## Create the site

The package is not published on npm yet. Build it with `pixi run pack` in a
checkout of the [source repository](https://github.com/akhmerov/astro-myst-notebooks).
With Node and Pixi available, run from your project's root:

```sh
archive=/absolute/path/to/astro-myst-notebooks-0.3.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

Keep the archive at a stable path for later `npm ci` runs. Add `--api mypackage`
to include Python API documentation. See the
[packed-release workflow](development.md#test-an-unpublished-release) for checks
you can run before adopting an archive.

The initializer writes the Astro and content configuration, an executable
welcome page, and `environment.yml`. It adds the build tools and documentation
tasks to Pixi, installs the npm dependencies, and refuses to replace existing
site files or tasks. `--dry-run` lists its intended changes. Existing `pyproject.toml` projects are initialized through Pixi itself,
preserving their project configuration.

Commit the generated configuration, `environment.yml`, `pixi.lock`, and
`docs/package-lock.json`. Add the scientific packages imported by your examples
to the selected Pixi environment and their browser equivalents to
`docs/environment.yml`.

## Work on the documentation

Write pages in `docs/src/content/docs/`. The welcome page already contains a
Python code cell. Its published output comes from a native Jupyter kernel;
**Enable interactivity** starts a separate Xeus kernel in the browser.

```sh
pixi run -e docs docs-dev 51300
pixi run -e docs docs
pixi run -e docs docs-preview
```

The dev port defaults to 51300. Additional Astro flags go after `--`, for example
`pixi run -e docs docs-dev 51300 -- --host 0.0.0.0`.
The first build prepares the browser environment. Later builds reuse it until
its inputs change or you explicitly request a refresh.

## Add to an existing Starlight site

Install the package and add its plugin to the existing Starlight configuration:

```js
import notebooks from 'astro-myst-notebooks/starlight';

// Inside starlight({ ... }):
plugins: [notebooks()]
```

Register the content collections in `src/content.config.ts`:

```ts
import { notebookCollections } from 'astro-myst-notebooks/starlight/content';

export const collections = notebookCollections();
```

The default source directory is `src/content/docs/`. Manifest and reference
cache paths are managed internally. The plugin also exports `objects.inv` for
other documentation projects to reference.

Provide an [environment.yml](browser.md#declare-browser-packages) in the Astro
root and run Astro inside Pixi with the dependencies specified by the package's
`environment-contract.json`. The initializer creates these declarations for
new sites. For a nested site, set the execution directory once:

```js
notebooks({ execution: { cwd: new URL('../', import.meta.url) } })
```

## Include Python API documentation

For a new site, pass `--api mypackage` to the initializer. It adds Pydocs,
Griffe, and the docstring converter, and configures the API module. On an
existing site, supply `api` as described in the [reference](reference.md#python-api-documentation).

Continue with the [walkthrough](walkthrough.md) for shared cell state, rich
output, includes, and source selections.
