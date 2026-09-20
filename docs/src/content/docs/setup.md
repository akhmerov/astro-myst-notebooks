---
title: Set up a site
description: Create a working Starlight site with native Jupyter and a prepared Xeus browser environment.
---

One command creates a documentation site inside your project and connects it
to a Pixi environment. Your repository owns its pages, branding, and Python
packages. The installed integration owns rendering, routes, caches, and browser
assets.

## Before you start

You need:

- [Node.js](https://nodejs.org/) 22.12 or newer, to run the initializer and
  npm. After initialization, the Pixi environment provides its own Node.
- [Pixi](https://pixi.sh/), which installs Python, Jupyter, and the browser
  environment tools.
- A project directory to document. It can already contain a `pixi.toml` or
  `pyproject.toml`, or be empty.

## Create the site

The package is not published on npm yet. Install the tested
[GitHub preview](https://github.com/akhmerov/astro-myst-notebooks/releases/tag/v0.4.0)
from your project's root. This public archive needs no GitHub sign-in:

```sh
archive=https://github.com/akhmerov/astro-myst-notebooks/releases/download/v0.4.0/astro-myst-notebooks-0.4.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

The initializer creates a `docs/` directory containing:

- `astro.config.mjs` and `src/content.config.ts`, which register the
  Starlight plugin and the content collections;
- `src/content/docs/index.md`, a welcome page with one Python cell;
- `environment.yml`, which [declares the browser packages](browser.md#declare-browser-packages);
- `package.json`, with the npm dependencies installed.

In your Pixi manifest it adds a feature and environment named `docs` with the
Jupyter and browser build tools, and the tasks `docs-install`, `docs`,
`docs-dev`, and `docs-preview`. That is why the commands below carry
`-e docs`. A project without a Pixi manifest gets a new `pixi.toml`; a project
with only `pyproject.toml` is initialized with `pixi init`, keeping its
existing configuration.

The initializer refuses to replace existing site files or Pixi tasks.
`--dry-run` lists its intended changes without writing anything. Other options:

- `--api mypackage` adds Python API documentation from your docstrings; see
  [below](#include-python-api-documentation).
- `--dir site` and `--pixi-environment site` choose the site directory and the
  Pixi environment name.
- `--package /absolute/path/to/astro-myst-notebooks-0.4.0.tgz` installs an
  archive you built yourself with `pixi run pack`; keep that file available for
  later installs.

Commit the generated configuration, `environment.yml`, `pixi.lock`, and
`docs/package-lock.json`. The npm lockfile records the archive URL and
integrity for later `npm ci` runs. See the
[packed-release workflow](development.md#test-an-unpublished-release) for checks
you can run before adopting an archive.

## Work on the documentation

```sh
pixi run -e docs docs-dev 51300
pixi run -e docs docs
pixi run -e docs docs-preview
```

The dev server runs at <http://localhost:51300>. The port is optional and
defaults to 51300; additional Astro flags go after `--`, for example
`pixi run -e docs docs-dev 51300 -- --host 0.0.0.0`. The `docs` task builds
the static site into `docs/dist/`, and `docs-preview` serves that build.

Write pages in `docs/src/content/docs/`. Each Markdown file or Jupyter notebook
there becomes a page. The welcome page already contains a Python code cell. Its
published output comes from a native Jupyter kernel during the build;
**Enable interactivity** on the page starts a separate Xeus kernel in the
browser, where you can edit and rerun the cell.

The first build prepares the browser environment, which downloads packages
from Emscripten-forge and takes a few minutes. Later builds reuse it until
`environment.yml` changes or you explicitly request a refresh.

Add the scientific packages your examples import to the `docs` Pixi
environment, for example `pixi add --feature docs numpy`, and their browser
equivalents to `docs/environment.yml`. The two environments are independent.

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
