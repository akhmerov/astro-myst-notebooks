# Astro MyST Notebooks

Write documentation in [MyST Markdown](https://mystmd.org/) or Jupyter
notebooks, run the Python cells during the [Astro](https://astro.build/) build,
and publish the results as a [Starlight](https://starlight.astro.build/) site.
Readers can then start a Python kernel in their browser to edit and rerun the
examples, with no server behind the page.

The package takes care of MyST rendering, Jupyter execution, cross-references,
equations, and the browser Python environment. Your repository keeps its own
pages, branding, and scientific Python dependencies.

**Alpha:** this package was extracted from
[Pymablock](https://gitlab.kwant-project.org/qt/pymablock) and is distributed as
GitHub development previews, not on npm. APIs and behavior may change. Read the
[documentation and interactive examples](https://akhmerov.github.io/astro-myst-notebooks/)
to see it in action.

[![Check and package](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml/badge.svg)](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml)

## Quick start

You need [Node.js](https://nodejs.org/) 22.12 or newer to run the initializer
and [Pixi](https://pixi.sh/) to manage the Python environment. Run the
following in the root of the project you want to document. An empty directory
works too.

```sh
archive=https://github.com/akhmerov/astro-myst-notebooks/releases/download/v0.4.1/astro-myst-notebooks-0.4.1.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

The first command downloads the tested
[GitHub preview](https://github.com/akhmerov/astro-myst-notebooks/releases/tag/v0.4.1)
and creates a `docs/` directory with a working Starlight site, a welcome page
containing one Python cell, and a browser environment declaration. It also
adds a Pixi environment named `docs` with the Jupyter tools and the tasks
`docs-dev`, `docs`, and `docs-preview`. The second command starts the dev
server at <http://localhost:51300>. Open the welcome page, then click
**Enable interactivity** to run the cell in your browser.

Useful options for the initializer:

- `--api mypackage` adds Python API documentation generated from docstrings.
- `--dir site --pixi-environment site` chooses the site directory and the
  Pixi environment name.
- `--dry-run` lists the files and tasks it would create without writing them.

Commit the generated configuration, `environment.yml`, `pixi.lock`, and the
npm lockfile. The lockfile records the archive URL and integrity, so later
`npm ci` runs install the same package. Existing sites can run
`npm install "$archive"` in their npm directory to update. Always use the
`.tgz` asset attached to a release, not GitHub's automatically generated source
archives or a Git dependency: those lack the compiled package.

Continue with [Set up a site](https://akhmerov.github.io/astro-myst-notebooks/setup/)
and the [executable walkthrough](https://akhmerov.github.io/astro-myst-notebooks/walkthrough/).

## Documentation

The site at <https://akhmerov.github.io/astro-myst-notebooks/> is built from
`docs/` with this package. Its source pages:

- [Overview](docs/src/content/docs/index.md)
- [Set up a site](docs/src/content/docs/setup.md)
- [Executable walkthrough](docs/src/content/docs/walkthrough.md)
- [Author MyST](docs/src/content/docs/authoring.md)
- [Notebook source](docs/src/content/docs/notebook.ipynb)
- [Browser execution](docs/src/content/docs/browser.md)
- [Configuration and API](docs/src/content/docs/reference.md)
- [Development and validation](docs/src/content/docs/development.md)

To build and read the documentation locally:

```sh
git clone https://github.com/akhmerov/astro-myst-notebooks.git
cd astro-myst-notebooks
pixi run docs
pixi run docs-preview
```

`pixi run docs-dev` starts a live-reloading server on port 51300; pass another
port as an argument and further Astro flags after `--`, for example
`pixi run docs-dev 51300 -- --host 0.0.0.0`. The site output is `docs/dist/`;
the compiled npm package stays in the root `dist/`.

## Contribute

```sh
pixi run test
pixi run check
pixi run docs-test
pixi run pack
pixi run npm run release:check -- --api --browser
```

`pixi run pack` (or `npm run package`) builds a distributable `.tgz` in an
isolated staging directory, including its dependency fixes, without modifying
`node_modules`. Bare `npm pack` directs you to this command. Use the absolute
path of that archive in place of the release URL above to try unreleased
changes in another project.

`docs-test` builds the site, checks its TypeScript, and verifies rendered output,
links, included-source origins, and browser assets. Use
`DOCS_BASE=/manual/ pixi run docs-test` to check a deployment prefix. The
release check installs the packed archive in a fresh consumer project and
builds it, optionally with API documentation and real browser execution.

For real browser execution and reset checks:

```sh
pixi run npx playwright install chromium
pixi run docs-browser
```

An existing Chromium binary can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`; `DOCS_PORT` selects the test server port.
Browser-runtime downloads require network access.

GitHub Actions runs the package, documentation, browser, and fresh-consumer
checks before uploading an archive and checksum. It does not publish to npm.
See [Development and validation](docs/src/content/docs/development.md) for the
release and Pages workflows.

The npm archive includes the Python adapter and runtime assets; there is no
separate Python distribution. Native execution uses `nbclient` in the selected
Pixi environment. Pymablock remains the downstream integration consumer: before
changing browser or Astro integration boundaries, pack this repository, install
the archive in Pymablock, and run its build-contract and browser checks.

Distributed under the BSD-2-Clause license; see [LICENSE](LICENSE).
