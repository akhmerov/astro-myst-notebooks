# Astro MyST Notebooks

Write documentation in [MyST Markdown](https://mystmd.org/) or Jupyter
notebooks, build it with [Astro](https://astro.build/), and publish a
[Starlight](https://starlight.astro.build/) documentation site. Python cells
run during the build. Readers can then edit and rerun them in a Python kernel
inside their browser, without a server behind the published page.

Astro owns the website and its configuration. This integration runs MyST's
document engine to process pages, includes, references, and computed outputs,
then renders the resolved documents through Astro. Your repository keeps its
pages, branding, components, and scientific Python dependencies.

**Unpublished alpha:** these instructions describe the `0.5.0-alpha.0`
migration. Build an archive from this branch to try it. Older `0.4.x` preview
archives use the previous document pipeline and configuration. The package is
not published on npm. The [public documentation](https://akhmerov.github.io/astro-myst-notebooks/)
tracks `main` and may describe a different version.

[![Check and package](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml/badge.svg)](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml)

## Quick start

You need [Node.js](https://nodejs.org/) 22.12 or newer and
[Pixi](https://pixi.sh/), which manages the Python and build tools.
First build the package archive from this checkout:

```sh
pixi run pack
```

This produces `astro-myst-notebooks-0.5.0-alpha.0.tgz` in the checkout root.
Then run the following from the root of the project you want to document:

```sh
archive=/absolute/path/to/astro-myst-notebooks-0.5.0-alpha.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

The initializer creates a `docs/` directory with Astro and Starlight
configuration, `myst.yml`, a welcome page containing a Python cell, and an
`environment.yml` for browser Python. It adds a Pixi environment named `docs`
and tasks for development, builds, and preview. The last command starts the
site at <http://localhost:51300>. Click **Enable interactivity** on the welcome
page to start browser Python, then **Run all** to execute its cell.

Use `--api mypackage` to include Python API documentation, or
`--dir site --pixi-environment site` to choose different directory and environment
names. `--dry-run` lists the intended changes without writing them.

Commit the generated configuration and lockfiles. Keep the local archive
available for later installs: the npm lockfile records its location and integrity.
Use the compiled `.tgz`, rather than a Git dependency or source archive.
Continue with [Set up a site](docs/src/content/docs/setup.md).

## What runs where

Build-time Python uses `nbclient`, a Jupyter execution client, in the Pixi
environment you select. Browser Python uses Xeus, a Python kernel compiled for
the browser. Thebe supplies its editors and execution controls. Declare browser
packages separately in `environment.yml`; installing a package in Pixi does not
make it available in a reader's browser. There is no separate Python package to
install for this integration.

Use normal Astro commands in the site directory. The integration invokes MyST
for you; you do not run a separate MyST development server.

## Documentation

- [Overview](docs/src/content/docs/index.md)
- [Set up a site](docs/src/content/docs/setup.md)
- [Executable walkthrough](docs/src/content/docs/walkthrough.md)
- [Author MyST](docs/src/content/docs/authoring.md)
- [Browser execution](docs/src/content/docs/browser.md)
- [Configuration and API](docs/src/content/docs/reference.md)
- [Development and validation](docs/src/content/docs/development.md)

To build this repository's documentation:

```sh
pixi run docs
pixi run docs-preview
```

`pixi run docs-dev` starts the development server. The site output is
`docs/dist/`; the compiled npm package is in the root `dist/`.

## Contribute

```sh
pixi run test
pixi run check
pixi run docs-test
pixi run pack
pixi run npm run release:check -- --api --browser
```

These checks exercise the compiled package and a fresh consumer installed from
the archive. Browser checks require Playwright's Chromium and Firefox binaries;
see [development](docs/src/content/docs/development.md) for setup and scope.
Pymablock is the downstream integration consumer and must be checked separately
before switching its document pipeline.

The repository uses npm workspaces. The standalone
[`myst-python-autodoc` package](packages/myst-autodoc/README.md) uses Griffe to
read Python docstrings and publish typed Sphinx inventories without an Astro
dependency. The root archive contains its runtime files, so Astro consumers do
not need an unpublished workspace package.

Distributed under the BSD-2-Clause license; see [LICENSE](LICENSE).
