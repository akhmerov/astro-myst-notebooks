---
title: Astro MyST Notebooks
description: Write MyST, execute Python with Jupyter, and let readers run examples in their browser.
---

Write a page in MyST Markdown or as a Jupyter notebook. During the Astro build,
its Python cells run in a real Jupyter kernel and the results are published
next to the code. Readers can start a Python kernel in their browser to edit
and rerun the examples without any server behind the page.

This site is built with the package it documents. The
[walkthrough](walkthrough.md) executes real Jupyter cells at build time and
lets you rerun the same cells in your browser. Its equations, links, includes,
and output are all rendered by the public Astro integration.

## Start with a working page

[Set up a site](setup.md) creates a working documentation site in one command
and explains what the initializer adds to your project. Then follow the
[executable walkthrough](walkthrough.md) to see shared cell state, hidden
setup, rich output, and browser edits.

When you are ready to write your own pages, [Author MyST](authoring.md) covers
executable cells, references, includes, and equations.
[Browser execution](browser.md) explains how to declare the Python packages
available to readers, and the [configuration reference](reference.md) lists
every option and export.

## What runs where

| Stage | Runtime | Dependencies |
| --- | --- | --- |
| Build | A fresh Jupyter kernel for each executable page, driven by `nbclient` | The Pixi environment you select |
| Published page | Static HTML, styles, and client-side Plotly | Assets produced by Astro |
| Interactive session | A browser-local Xeus Python kernel, with editors and controls from Thebe | A prepared Emscripten-forge environment declared in `environment.yml` |

Native and browser Python environments are configured separately. A package
installed in Pixi is not automatically available to a reader's browser; see
[browser execution](browser.md#declare-browser-packages).

## Project status

This package is in **alpha**: APIs and behavior may change. It was extracted
from Pymablock and is distributed as GitHub development previews. It is not
published on npm.

The package implements a supported subset of MyST and fails explicitly on
unsupported constructs rather than rendering them incorrectly. Notebook output
is trusted content: only publish output from code you control. See
[development](development.md) for local commands and validation scope.
