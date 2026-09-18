---
title: Browser execution
description: Declare an Emscripten-forge environment and run examples in a Xeus browser kernel.
---

The browser backend is Xeus with packages from Emscripten-forge. The docs build
prepares the environment and publishes it with the site. Readers download that
environment when they enable interactivity. Thebe provides editors,
controls, and Jupyter MIME rendering.

## Declare browser packages

The initializer creates `environment.yml` in the Astro root:

```yaml
name: notebooks
channels:
  - https://repo.prefix.dev/emscripten-forge-4x
  - https://repo.prefix.dev/conda-forge
dependencies:
  - xeus-python
  - python
  - ipython
  - xeus-python-shell
```

Add packages such as `numpy`, `scipy`, or `matplotlib` to this declaration.
They must be available for the browser platform. A native package installed
in Pixi is not automatically available in the browser.

The default environment path needs no configuration. To use another file:

```js
interactive: {
  environment: new URL('./browser/environment.yml', import.meta.url),
}
```

Set `interactive: false` to publish executed output without live notebooks.
Pyodide is not supported in 0.3.

## Include your Python package

For a pure-Python project, enable a local wheel:

```js
interactive: {
  wheel: { project: new URL('../', import.meta.url) },
}
```

The default command uses `python -m build --wheel --no-isolation`. Install the
project's build backend in its Pixi environment. A custom `wheel.command` can
supply an executable and prefix arguments; the integration appends `-d` and
the output directory, as supported by Hatchling.

Exactly one pure-Python wheel must be produced. It is mounted in the prepared
environment and added to Python's import path. Its dependencies belong in
`environment.yml`; compiled wheels are rejected. Include compiled libraries
through Emscripten-forge.

## Include data files

Use `interactive.mounts` to include files that examples read. Each `source` is
a local file or directory, resolved from the config file. Each `target` is an
absolute directory in the browser's filesystem:

```js
interactive: {
  mounts: [
    { source: new URL('./data/measurements/', import.meta.url), target: '/data/measurements' },
    { source: new URL('./data/description.txt', import.meta.url), target: '/data' },
  ],
}
```

A directory's contents are copied recursively; a single file keeps its name.
The second mapping therefore creates `/data/description.txt`. These mappings
are used by this documentation site. This cell reads the same data during the
native build and in browser Python:

```{code-cell} python
import csv
import sys
from pathlib import Path

data = Path('/data') if sys.platform == 'emscripten' else Path('docs/data')
print((data / 'description.txt').read_text().strip())
with (data / 'measurements/readings.csv').open() as stream:
    total = sum(int(row['value']) for row in csv.DictReader(stream))
print(f'Measured total: {total}')
```

Native execution continues to use your project files and `execution.cwd`;
mounts only populate browser Python. Files are bundled with the published site
and restored when Python restarts. Changes made in the browser do not update
your source files. Restart the dev server after changing mounted files.

Missing sources, symbolic links, overlapping file destinations, and invalid
targets fail the build. `/files` is reserved by JupyterLite, and mounted files
cannot replace the wheel under `/opt/wheels` when `interactive.wheel` is used.

## Reuse and refresh environments

The environment cache records the declaration, builder versions, command,
normalized local-wheel contents, mounted file contents and destinations, and
hashes of the completed output files.
Ordinary prose edits reuse the prepared environment. Wheel ZIP timestamps do
not force a rebuild. Changing environment inputs or finding damaged output
triggers a new build; a failed refresh leaves the previous cache intact.

Use `interactive: { refresh: true }` to resolve packages again, then remove the
flag. An unchanged declaration can resolve differently when upstream channels
change. The cache records the resulting artifacts but is not a portable conda
lockfile. Preserve the built site when exact redistribution matters.

## Run, edit, and restart

**Enable interactivity**, beside the page title or through the wand beside any
code cell’s copy button, starts Python and enables editing without executing
cells. **Run all** then executes cells in source order, including hidden setup.
Execution stops after an error. To run just one cell,
use its run button or press **Shift+Enter** in its editor. Other cells are not
rerun; they share the Python state established by earlier executions.

**Restart Python** terminates
the kernel worker and starts a new session while preserving edits; run all
again to initialize the examples.

Reset uses Jupyter's public kernel shutdown API, so an infinite Python loop
cannot block recovery by keeping the execution queue busy. Startup and cleanup
failures expose retry controls; removing a notebook releases its session.

Static and live outputs follow the same MIME policy for Plotly JSON, HTML,
Markdown, SVG, LaTeX, PNG, JPEG, and plain text. Widgets and arbitrary JavaScript
MIME bundles are unsupported. Notebook output is trusted content.
