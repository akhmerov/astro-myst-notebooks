---
title: Development
description: Build the Astro-led MyST integration, validate its archives, and check downstream consumers.
---

This repository's documentation imports the compiled package through its public
Starlight plugin and content collection. Astro starts the build. The integration
runs the pinned MyST CLI, adds the nbclient and provenance plugins, then renders
MyST's resolved documents. It does not access MyST's engine Session API.

## Build and preview

From the repository root:

```sh
pixi run docs
pixi run docs-preview
```

The site is written to `docs/dist/`; the compiled package stays in the root
`dist/`. `docs/myst.yml` is the authored project configuration. Ignore
`docs/.astro-myst.generated.yml`, `docs/_build/`, and `docs/.astro/`: they contain
generated MyST input, resolved documents, and caches.

For authoring:

```sh
pixi run docs-dev 51300
```

The port defaults to 51300. Additional Astro flags go after `--`, for example
`pixi run docs-dev 51300 -- --host 0.0.0.0`. Astro watches pages, included
Markdown, the MyST configuration/table of contents, and Python source. The
integration rebuilds document data before updating the content collection.
Unchanged executable inputs reuse successful outputs, so a prose edit does not
need another kernel. Restart after editing the integration implementation or
changing installed Python packages.

Build-time examples use the selected Pixi Python. Browser Python is declared
separately in `docs/environment.yml`; its prepared Xeus environment is cached
between builds. `api.python` and `interactive.python` can select other existing
Pixi interpreters for static API extraction and browser-build tools. Neither
changes reader Python or installs another Python distribution.

## Validation

```sh
pixi run test
pixi run check
pixi run docs-test
```

Tests exercise compiled output. Execution checks use real kernels and cover
cell errors, timeouts, adapter termination, and cached-output invalidation.
Provenance checks compare source slices with mapped text; a successful build
alone does not establish accurate source locations. Rendering checks cover
references, citations, grouped content, includes, and generated outputs.

`docs-test` builds this site, checks its TypeScript, and verifies output, links,
source origins, and browser assets. To check deployment below a prefix:

```sh
DOCS_BASE=/manual/ pixi run docs-test
```

Browser checks require Playwright's browsers:

```sh
pixi run npx playwright install chromium firefox
pixi run docs-browser
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` or `PLAYWRIGHT_FIREFOX_EXECUTABLE` to select
existing browser binaries. `DOCS_PORT` chooses the preview port. The npm browser
setup also installs Firefox and its system dependencies in CI. Browser tests
exercise activation, real Python execution, preserved presentation settings,
plots, source selection, and recovery from an infinite loop. Initial browser
package downloads require network access.

A failed main run must be investigated at its failed step. Distinguish an
assertion failure from a cancelled or timed-out runner, and retain diagnostic
logs before changing code. Do not increase a job limit without identifying what
used it.

## Build the distribution

```sh
pixi run pack
```

This runs `npm run package`, compiles the package, and assembles a `.tgz` archive
in a temporary staging directory. Dependency manifest patches and a production
shrinkwrap are written in staging. A completed archive replaces the previous
one; failures leave the prior archive and installed dependencies intact.

Use this command instead of bare `npm pack`, which stops with guidance. The
root archive includes compiled modules and declarations, the Python adapter,
execution contracts, styles, browser files, and a runtime copy of the canonical
autodoc workspace. It contains no dependency on a local workspace link.
Documentation source and site output are excluded.

This branch targets unpublished `0.5.0-alpha.0`. An archive from the previous
`0.4.x` pipeline does not test the new API. Before sharing a build, validate the
actual archive in fresh consumers and retain its checksum. Publication is a
separate action; building or testing an archive does not publish a release.

Pymablock is the downstream gate for scientific examples, API routes, and Xeus.
Install the packed archive there and check build contracts, links, inventories,
source-map behavior, development reload, and reader execution. Record the
actual commands and limitations. Passing this repository's tests does not prove
full Pymablock compatibility.

## Test an unpublished release

```sh
pixi run pack
pixi run npm run release:check -- --browser
pixi run npm run release:check -- --api --browser
```

The check runs the initializer from the archive in a fresh temporary consumer.
The consumer imports only installed package exports, builds at `/` and
`/manual/`, and checks executable cells, notebook sources, inline results,
tabs/grid, citations, source markers, public inventories, and resolved page
JSON. With `--api`, it also checks generated API pages, inherited member and
constructor documentation, and typed Python inventory entries.

`--browser` serves the built consumer under `/manual/`, executes Python in
Chromium, and checks recovery from an infinite loop. Use an installed Chromium
binary or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The consumer is retained for
inspection. To validate a specific local archive:

```sh
pixi run npm run release:check -- --archive /absolute/path/to/astro-myst-notebooks-0.5.0-alpha.0.tgz --api --browser
```

To initialize another project from that archive, run in the consumer's root:

```sh
archive=/absolute/path/to/astro-myst-notebooks-0.5.0-alpha.0.tgz
npm exec --yes --package="$archive" -- astro-myst-notebooks init --package "$archive"
```

The npm lockfile records the archive's path and integrity. Keep that archive
available for subsequent `npm ci` runs.

GitHub Actions runs package, documentation, browser, and archive-consumer checks.
Successful runs upload an artifact named `astro-myst-notebooks-<commit>` with
the tested `.tgz` and `SHA256SUMS`. Artifact downloads require sign-in and expire
after 30 days. Retain local copies used by consumers. Verify downloaded files
with `sha256sum -c SHA256SUMS`. The check workflow does not publish to npm.

## Standalone autodoc workspace

The repository uses npm workspaces with independently versioned packages.
`packages/myst-autodoc` is the canonical `myst-python-autodoc` plugin. It uses
Griffe and typed inventories independently of Astro. Root builds copy its
runtime files into `dist/engine/autodoc/`; change the workspace source rather
than that generated copy.

Build its archive and run the standalone interoperability checks:

```sh
pixi run npm pack ./packages/myst-autodoc
pixi install --locked -e interop
pixi run npm run autodoc:test
```

The tests consume the packed plugin, run MyST, and use a separate Sphinx
consumer to resolve published Python names over HTTP. The isolated Sphinx
dependencies live in the existing `interop` Pixi environment. See the
[workspace README](https://github.com/akhmerov/astro-myst-notebooks/tree/main/packages/myst-autodoc)
for standalone configuration. That public link follows `main`; use the local
workspace README when testing this unpublished migration.

## Migration acceptance

The public entry points are Astro and Starlight. The historical static-theme
experiment is evidence for the resolved-document boundary, rather than a
second supported website entry point.

Before replacing the previous document pipeline, require:

- source origins that never label mismatched text as `exact`, with agreed
  coverage against the old pipeline;
- explained differences in rendered text, routes, anchors, links, citations,
  include handling, and presentation;
- supported or explicitly rejected execution settings, bounded kernel
  concurrency, correct invalidation, and kernel termination;
- a consumer installed from archives, without checkout imports, with build and
  development reload, inventories, a deployment prefix, and browser execution;
- recorded Pymablock validation and an independent review of remaining gaps.

A prototype probe or successful export command is insufficient on its own.
The old resolver can be removed after those gates pass; a permanent second
pipeline would duplicate the same correctness obligations.

## Publish the documentation

The [public documentation](https://akhmerov.github.io/astro-myst-notebooks/)
tracks `main` and displays an alpha notice. It can describe changes newer than
the latest downloadable preview. The unpublished migration must not be confused
with an existing release archive.

The documentation workflow builds with the Pages origin and repository path,
checks the output, and runs browser notebook tests before deployment. GitHub
Pages must use **GitHub Actions** as its publishing source. Pushes to `main`
deploy automatically; pull requests do not deploy.

Check the same path locally:

```sh
DOCS_SITE=https://akhmerov.github.io DOCS_BASE=/astro-myst-notebooks pixi run docs-test
DOCS_SITE=https://akhmerov.github.io DOCS_BASE=/astro-myst-notebooks pixi run npm run docs:test:browser
```

## Dependency maintenance

Pin the MyST CLI version and gate upgrades on real document, execution,
provenance, and consumer checks. The adapter consumes MyST's manifest and page
JSON rather than its Session internals; that still requires versioned fixtures
and compatibility tests. Probe reports must record the executable version that
actually ran.

The release build minifies browser JavaScript and copies supported classic
Xeus workers. Consumers serve those assets unchanged. Package identities and
license notices are in `dist/notebooks/browser/`. Debug JavaScript source maps
remain in the archive for debugging, but deployed scripts do not reference or
copy them. These are separate from the MyST source-selection markers on pages.
The archive consumer check enforces a 20 MB browser-JavaScript budget.

Keep overridden sanitizer and CSV parser versions exact, and pin the direct
KaTeX dependency used by the `rehype-katex` override. Ranged overrides can cause
`npm ci` to resolve newer versions and reject the committed lockfile. Update
pins and the lockfile together; KaTeX rendering and styles must match.

The archive carries the tested bundled MyST dependency graph, corresponding
manifest patches, and a production shrinkwrap. Patch checks fail when upstream
manifests change, so each dependency upgrade needs deliberate review. Inspect
both development and fresh-consumer audit results; compiled browser libraries
need their own scrutiny. Keep install-script permissions version-specific.
