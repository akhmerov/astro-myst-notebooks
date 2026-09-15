# Astro MyST Notebooks

MyST documents, native Jupyter execution, rich MIME outputs, browser-local
Python, and text source maps for Astro and Starlight. Extracted from Pymablock;
this is an experimental package, not a published release.

## Add documentation to a project

The Starlight preset manages MyST rendering, Jupyter execution, references, and
the prepared Xeus browser environment. Its initializer creates a working site
and Pixi tasks:

```sh
npx astro-myst-notebooks init --dir docs --pixi-environment docs
pixi run -e docs docs-dev
```

Add `--api mypackage` to include Python API documentation. Version 0.3 is
prepared in this source repository; registry publication is pending. See the
[unpublished release workflow](docs/src/content/docs/development.md#test-an-unpublished-release)
for testing its archive.

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
```

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
