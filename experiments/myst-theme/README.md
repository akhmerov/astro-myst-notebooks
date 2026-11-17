# Experimental MyST static theme

This prototype builds a Starlight site through MyST's `build.render` hook,
introduced in `mystmd` 1.11.0. MyST parses the source, expands includes, resolves
references, and numbers equations. An Astro content loader consumes the resolved
document trees from MyST's local content server. It never sends those trees back
through our Markdown parser or reference resolver.

Build-time execution uses this package's `nbclient` adapter in the current Pixi
environment through a MyST document plugin. The plugin supplies standard MyST
outputs before inline expressions, references, embeds, and exports are processed.
The theme consumes these results without executing Python. The existing browser
runtime supplies editable cells, Xeus Python,
activation, reruns, and kernel termination. A companion MyST plugin adds source
provenance before project references are resolved and preserves cell tags that
MyST otherwise consumes.

## Run the experiment

Use this checkout's Pixi environment; it supplies Node and Python. Install the
locked npm dependencies once:

```sh
pixi run install
pixi run npm run myst:test
pixi run npm run myst:browser
```

`myst:test` compiles the package, invokes the real `myst build --html --strict`
command, and checks its rendered output and failure cases. The five-page site
is written to `experiments/myst-theme/project/_build/html/`. The first build
downloads the browser Python environment. `myst:browser` serves the built site
temporarily and tests it in Chromium, including actual Python execution. Install
Chromium with `pixi run npx playwright install chromium` if necessary.

To inspect the built site:

```sh
MYST_THEME_PORT=51542 pixi run node experiments/myst-theme/serve.mjs
```

Open <http://127.0.0.1:51542/>. `MYST_THEME_PORT` also selects the browser-test
server's port. Check deployment under a URL prefix with:

```sh
BASE_URL=/theme-check/ pixi run npm run myst:test
BASE_URL=/theme-check/ pixi run npm run myst:browser
```

Use the same `BASE_URL` when serving that build. Run `myst:test` without it to
restore a build for the site root.

The launcher accepts another project directory:

```sh
pixi run node experiments/myst-theme/build.mjs /path/to/project
```

That project's `myst.yml` must point `site.template` at this experiment's
`theme/` directory and load `provenance.mjs`, then `execution.mjs`, in
`project.plugins`. Executable pages run in their own directory in the selected
Python environment. This is a checkout-local experiment: the theme imports the
compiled package from this repository and uses its lightweight documentation
browser environment.

Do not add MyST's `--execute` with the default execution plugin. The plugin
rejects combining executors. Saved notebook outputs are replaced by fresh output,
as in the existing Astro integration. `MYST_EXECUTION_TIMEOUT` sets the cell
timeout in seconds (default 30); `MYST_EXECUTION_PYTHON` selects the adapter's
Python executable (default `python` from the selected Pixi environment).

## Compare execution options

The [full pipeline assessment](pipeline-options.md) compares project management,
configuration, plugins, references, rendering, exports, development, and
distribution. Its [pipeline probes](pipeline-probes.mjs) exercise document and
navigation behavior separately from execution. The
[consumer experiment](hybrid-probe.mjs) runs MyST processing followed by a
consumer-owned Astro build; the [independent review](claude-pipeline-review.md)
records the parallel Claude Opus assessment and its follow-up corrections.

The [execution investigation](execution-options.md) compares rendering-time
execution, native MyST execution with three cache policies, and the document
plugin. To repeat its real build, HTML, and Word-export checks, provide a Python
environment containing Jupyter Server for the native cases:

```sh
MYST_NATIVE_PYTHON=/path/to/python-with-jupyter-server \
  pixi run npm run myst:compare -- /tmp/myst-execution-results.json
```

The adapter and comparison kernels still use Python from the selected Pixi
environment. The harness creates temporary projects and a private kernelspec,
links the checkout's locked npm dependencies into each fixture, and emits only
sanitized results. It leaves fixtures in `/tmp` for inspection. Set
`MYST_COMPARE_MODES=document` to focus a rerun on the document plugin using only
the existing Pixi environment.

`MYST_THEME_EXECUTION=native` selects MyST's executor when using `build.mjs`.
This requires Jupyter Server in the launch environment and a valid `kernelspec`
on each executable page. `MYST_THEME_EXECUTION=render` retains the original
renderer-based executor for the comparison fixture; the main demonstration now
contains inline expressions and deliberately rejects that older path.

## What the prototype establishes

- MyST can drive Astro/Starlight without a React theme or a deployed server.
- Markdown code cells and `.ipynb` files render native Python results and run
  in browser Python. Removed setup cells continue to execute.
- Inline expressions see preceding cells' state. Computed outputs can be
  embedded on other pages and exported to Word without running during rendering.
- MyST's structured MIME bundles and published PNG assets reach our existing
  HTML, Markdown, math, image, and Plotly renderers.
- Activation leaves static output intact and does not execute cells. Readers
  can edit, rerun, and restart; restart also terminates an infinite loop.
- Cross-page equation links, equation numbering, the Starlight sidebar, code
  highlighting and copy controls work through the new path.
- Markdown prose and unfiltered included prose retain file identity, digest,
  revision, and exact/range markers. Uniquely located cell source also retains
  exact line ranges. Tests compare published offsets against original files.
- The theme copies MyST content assets, computed page JSON, and reference
  inventories. The new hook leaves those copies to the theme; MyST only adds
  user `static_files` afterwards.
- Unsupported syntax, unresolved references, conflicting presentation tags,
  and unsupported renderer nodes fail explicitly.
- The standalone [MyST autodoc plugin](../../packages/myst-autodoc/README.md)
  generates a Python API page before reference resolution. The launcher merges
  typed Python inventory entries into the published site after rendering.
  Generated API prose does not receive Markdown source-selection offsets.

## What remains before migration

This is a feasibility test, not a replacement for the package's current loader.

| Area | Current limitation |
| --- | --- |
| Python API documentation | The standalone Griffe plugin supports authored API pages and typed inventories. Automatic API page trees, inherited members, and constructor-prose merging remain unsupported. |
| Execution configuration | MyST's document hook does not expose resolved frontmatter. The prototype reads local page settings and plugin defaults itself, and rejects inherited configuration. It supports Python only and has no persistent execution cache. |
| Notebook provenance | `.ipynb` prose does not receive source offsets. Mapping MyST's notebook nodes to our generated MyST representation needs a separate adapter. |
| Included provenance | Filtered includes fail explicitly. The resolved tree retains filter metadata, but reconstructing original offsets needs a validated adapter. Contiguous selections are the initial parity target; noncontiguous selections need an explicit policy. |
| Renderer coverage | The allowlist covers basic document nodes and resolved output embeds. Citations, widgets, tabs, cards, and other rich nodes need explicit adapters and tests before being enabled. |
| External MyST links | The engine resolves remote targets, but the theme currently drops their remote base URL. The pipeline probe records the resulting incorrect local link. |
| Configuration | One project and a simple sidebar are supported. Consumer branding, API options, presentation defaults, custom environments, wheels, and mounts are not exposed through `myst.yml`. |
| Development and distribution | `myst start`, watch/reload, a standalone theme archive, and registry discovery are not implemented. |

The experiment reuses package internals from `dist/` without changing the public
integration or browser runtime. Its files are outside the npm archive. It has
not been installed as a MyST theme in Pymablock. A migration should package the
document execution plugin and theme, then validate the packed result in that
consumer.
