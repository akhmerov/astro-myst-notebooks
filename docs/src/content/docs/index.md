---
title: Astro MyST Notebooks
description: Write MyST, execute Python with Jupyter, and let readers run examples in their browser.
---

Write a MyST page once, execute its Python cells during the Astro build, and
publish the results alongside the code. Readers can activate a browser-local
Python kernel to edit and rerun the examples. Text source maps connect rendered
prose to its authored file and revision.

This site uses the package it documents. The [walkthrough](walkthrough.md)
executes real Jupyter cells at build time and exposes the same cells through
Thebe in the browser. Its equations, links, includes, and output are rendered
by the public Astro integration.

## Start with a working page

[Set up a site](setup.md) to register the integration and content loader.
Then use the [executable walkthrough](walkthrough.md) to explore shared cell
state, hidden setup, rich output, and browser edits.

[Author MyST](authoring.md) explains document structure and source maps.
[Browser execution](browser.md) explains the prepared Xeus environment, and
the [API reference](reference.md) lists configuration options and exports.

## What runs where

| Stage | Runtime | Dependencies |
| --- | --- | --- |
| Build | A fresh Jupyter kernel for each executable page, driven by `nbclient` | The consumer's selected Pixi environment |
| Published page | Static HTML, styles, and client-side Plotly | Assets produced by Astro |
| Interactive session | Thebe with a browser-local JupyterLite kernel | A prepared Emscripten-forge environment |

Native and browser Python environments are configured separately. A package
installed in Pixi is not automatically available to a reader's browser.

## Project status

This package is in **alpha**: APIs and behavior may change. It was extracted
from Pymablock and is distributed as GitHub
development previews. It is not published on npm. The npm archive is its
distribution unit. It includes the Python
adapter, environment contracts, CSS, and prepared browser modules, with no separate Python
distribution. Pymablock remains the downstream integration consumer.

The package implements a supported subset of MyST and fails explicitly on
unsupported constructs. Notebook output is trusted content. See
[development](development.md) for local commands and validation scope.
