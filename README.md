# Astro MyST Notebooks

MyST documents, native Jupyter execution, rich MIME outputs, browser-local
Python, and text source maps for Astro and Starlight. Extracted from Pymablock;
this is an experimental package distributed as GitHub development previews.
It is not published on npm.

[![Check and package](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml/badge.svg)](https://github.com/akhmerov/astro-myst-notebooks/actions/workflows/check.yml)

## Add documentation to a project

With Node and Pixi available, run the initializer from the project you want to
document. This installs a tested [GitHub preview](https://github.com/akhmerov/astro-myst-notebooks/releases/tag/preview-2026-09-20)
directly from its archive; no GitHub sign-in or local package build is needed:

```sh
archive=https://github.com/akhmerov/astro-myst-notebooks/releases/download/preview-2026-09-20/astro-myst-notebooks-0.3.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
pixi run -e docs docs-dev
```

The Starlight preset manages MyST rendering, Jupyter execution, references, and
the prepared Xeus browser environment. The initializer creates a working site
and Pixi tasks. Add `--api mypackage` to include Python API documentation, or
`--dir docs --pixi-environment docs` to select the site directory and environment.
The generated npm lockfile records the archive URL and integrity. Existing
consumers can run `npm install "$archive"` in their documentation site's npm
directory to install the same package. Use the attached `.tgz` asset, not
GitHub's automatically generated source archives or a Git dependency.

To build the current source yourself:

```sh
git clone https://github.com/akhmerov/astro-myst-notebooks.git
cd astro-myst-notebooks
pixi run pack
```

Then use the absolute path to that `.tgz` in place of the URL above. Keep local
archives at a stable path for subsequent `npm ci` runs.

## Read and run the documentation

This repository builds its own documentation with its public integration and
content loader. The executable walkthrough runs through real Jupyter at build
time and can be edited and rerun in the browser.

```sh
pixi run docs
pixi run docs-preview
```

For live authoring, run `pixi run docs-dev 51300` (the port defaults to 51300).
Pass additional Astro flags after `--`, for example
`pixi run docs-dev 51300 -- --host 0.0.0.0`. The site output is `docs/dist/`;
the compiled npm package stays in the root `dist/`.

- [Overview](docs/src/content/docs/index.md)
- [Set up a site](docs/src/content/docs/setup.md)
- [Executable walkthrough](docs/src/content/docs/walkthrough.md)
- [Author MyST](docs/src/content/docs/authoring.md)
- [Browser execution](docs/src/content/docs/browser.md)
- [Configuration and API](docs/src/content/docs/reference.md)
- [Development and validation](docs/src/content/docs/development.md)

## Develop and package

```sh
pixi run test
pixi run check
pixi run docs-test
pixi run pack
pixi run npm run release:check -- --api --browser
```

`pixi run pack` (or `npm run package`) prepares the archive in an isolated staging
directory, including its dependency fixes, without modifying `node_modules`.
Bare `npm pack` directs you to this packaging command.
GitHub Actions runs the package, documentation, browser, and fresh-consumer
checks before uploading an archive and checksum. It does not publish to npm.

`docs-test` builds the site, checks its TypeScript, and verifies rendered output,
links, included-source origins, and browser assets. Use
`DOCS_BASE=/manual/ pixi run docs-test` to check a deployment prefix.

For real browser execution and reset checks:

```sh
pixi run npx playwright install chromium
pixi run docs-browser
```

An existing Chromium binary can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`; `DOCS_PORT` selects the test server port.
Browser-runtime downloads require network access.

The npm archive includes the Python adapter and runtime assets; there is no
separate Python distribution. Consumers own their content, branding, scientific
Python dependencies, and browser environments. Native execution uses `nbclient`
in the selected Pixi environment.

Pymablock remains the downstream integration consumer. Before changing browser
or Astro integration boundaries, pack this repository, install the archive in
Pymablock, and run its build-contract and browser checks.

Distributed under the BSD-2-Clause license; see [LICENSE](LICENSE).
