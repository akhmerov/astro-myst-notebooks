---
title: Development
description: Build this documentation site, run its checks, and validate the distribution in consumers.
---

This repository's documentation is an Astro/Starlight consumer of its own
compiled package. `docs/astro.config.mjs` imports `astro-myst-notebooks/starlight`, and the
content collection imports `astro-myst-notebooks/starlight/content`. There is no copied
renderer or separate documentation execution script.

## Build and preview

From the repository root:

```sh
pixi run docs
pixi run docs-preview
```

The build compiles the package, renders this site's MyST files, and executes the
[walkthrough](walkthrough.md) with real Jupyter. Static files go to `docs/dist/`;
package output stays in the root `dist/`. Preview prints its local URL.

For authoring:

```sh
pixi run docs-dev 51300
```

The port is optional and defaults to 51300. Additional Astro CLI options go
after `--`, for example `pixi run docs-dev 51300 -- --host 0.0.0.0`.
The dev task compiles the package once before
starting Astro. Restart it after changing package implementation or Python
dependencies. Source prose edits and page additions/removals are handled by Astro's watcher.

This site's native examples use standard-library Python and IPython. The Pixi
environment also contains the Xeus build tools. `docs/environment.yml` declares
the browser environment, whose completed artifacts are cached between builds.


## Validation

```sh
pixi run test
pixi run check
pixi run docs-test
```

Package tests exercise compiled output and real native kernels. The docs test
builds the site and checks rendered results, document links, included-source
origins, and the emitted browser assets. It also catches missing pages in the
site's own navigation.

To check a deployment prefix:

```sh
DOCS_BASE=/manual/ pixi run docs-test
```

Browser checks use Playwright against the built site:

```sh
pixi run npx playwright install chromium
pixi run docs-browser
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium binary, or
`DOCS_PORT` to choose the local test server port. The browser suite checks the
rendered page, source selections, and real Python activation, execution, and
reset. Initial browser-runtime downloads require network access.

## Build the distribution

```sh
pixi run pack
```

This runs `npm run package`: it builds the package, asks npm which files belong in
the archive, and copies them into a temporary staging directory. Dependency
manifest patches and the production shrinkwrap are written only in that
directory. A completed archive replaces the previous one; failures leave the
previous archive and installed dependencies intact.

Use `pixi run pack` or `npm run package`, rather than bare `npm pack`. The latter
stops with guidance so it cannot accidentally distribute unpatched dependency
manifests. When publishing, pass the prepared `.tgz` archive to `npm publish`.

The npm archive includes the compiled modules, TypeScript declarations, Python
adapter, contract JSON, styles, and browser files. Documentation source and
site output are development assets and are excluded from the archive.

Pymablock remains the downstream consumer for broader Python API and Xeus
coverage. Before changing browser or Astro integration boundaries, install the
packed archive in that consumer and run its build-contract and browser checks.
The local site does not exercise every optional provider or Griffe adapter.

## Test an unpublished release

```sh
pixi run pack
pixi run npm run release:check -- --browser
pixi run npm run release:check -- --api --browser
```

The release check runs the CLI from the packed archive in an empty temporary
consumer, installs its dependencies, and builds at `/` and `/manual/`. It also
checks notebook input, tabs and cards, inline Python results, and both default
and explicit dev-port arguments. With `--api`, it also checks Python API
documentation. `--browser` also starts the built site under `/manual/`, executes
Python in Chromium, and checks recovery from an infinite loop. Install Chromium
as described above or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The temporary consumer
is retained for inspection. Run this check before sharing an archive.

GitHub Actions runs these checks for pushes and pull requests. Successful runs
provide an artifact named `astro-myst-notebooks-<commit>`, containing the tested
`.tgz` and `SHA256SUMS`. Artifact downloads require GitHub sign-in and remain
available for 30 days; keep a local copy for consumers that depend on one.
To verify a downloaded archive, run `sha256sum -c SHA256SUMS` in the extracted
artifact directory. The workflow has no npm publication step.

GitHub prereleases retain a tested CI archive and its checksum at a fixed,
public download URL. A preview tag identifies the source commit; its assets
must not be replaced with a different build. These attachments are distinct
from GitHub's automatically generated source archives, which lack the compiled
package assets. To check a published attachment through the same consumer flow:

```sh
pixi run npm run release:check -- --archive https://github.com/akhmerov/astro-myst-notebooks/releases/download/preview-2026-09-20/astro-myst-notebooks-0.3.0.tgz --api --browser
```

To initialize another project from an unpublished archive, run from that
project's root (use an absolute archive path):

```sh
npm exec --package=/path/to/astro-myst-notebooks-0.3.0.tgz -- astro-myst-notebooks init --package /path/to/astro-myst-notebooks-0.3.0.tgz
```

## Publish the documentation

The [public documentation](https://akhmerov.github.io/astro-myst-notebooks/)
tracks `main` and displays an alpha notice on every page. It can describe changes
newer than the most recent downloadable preview.

The Deploy documentation workflow builds with the Pages origin and repository
path, checks the output, and runs the browser notebook tests before deploying
`docs/dist/`. GitHub Pages must use **GitHub Actions** as its publishing source.
Pushes to `main` deploy automatically; the workflow can also be run manually.
Pull requests do not deploy.

To check the same deployment path locally:

```sh
DOCS_SITE=https://akhmerov.github.io DOCS_BASE=/astro-myst-notebooks pixi run docs-test
DOCS_SITE=https://akhmerov.github.io DOCS_BASE=/astro-myst-notebooks pixi run npm run docs:test:browser
```

## Dependency maintenance

The release build bundles browser JavaScript and copies the supported classic
Xeus workers. Consumers serve these files unchanged; their Astro build does not
compile Jupyter workers. Exact bundled package identities and license notices
are included in `dist/notebooks/browser/`.

The tested MyST dependency graph is bundled into the npm archive. This carries
patched transitive versions and matching dependency declarations to consumers,
where npm would otherwise ignore our root overrides. The small manifest
patches are checked against both installed manifests and the lockfile, then
recorded in the archive's `dist/DEPENDENCY-PATCHES.json`. A production shrinkwrap
is generated alongside them in staging. Review
both development and fresh-consumer audits; browser libraries that ship their
own compiled code need separate scrutiny.

The upstream Markdown-it 13 advisories remain: upgrading it breaks MyST's math
plugin's internal imports. The development tree also retains upstream Thebe
peer dependencies and deprecation warnings; consumers do not install Thebe or
Pyodide packages. Keep the reviewed `allowScripts` entries version-specific.
