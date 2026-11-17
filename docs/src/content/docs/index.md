---
title: Astro MyST Notebooks
description: Build MyST documentation with Astro, execute Python with Jupyter, and let readers run examples in their browser.
---

Write pages in MyST Markdown or as Jupyter notebooks. Run Astro to build the
website. Its integration invokes MyST's document engine for includes,
references, and computed content, then renders the resolved pages with Astro
and Starlight. Your project keeps its own layout, components, and branding.

Python cells run during the build in the Pixi environment you select. Readers
can start a separate Python kernel in their browser to edit and rerun the
examples, without a server behind the published page. The
[walkthrough](walkthrough.md) demonstrates shared state, hidden setup,
equations, source selections, and rich output.

## Start with a working page

[Set up a site](setup.md) explains how to build the unpublished alpha archive
and initialize a documentation project from it. Then follow the
[walkthrough](walkthrough.md) and [Author MyST](authoring.md).

[Browser execution](browser.md) explains which Python packages readers can
use. The [configuration reference](reference.md) describes the integration,
content loader, and Python API documentation.

## What runs where

| Stage | Runtime | Dependencies |
| --- | --- | --- |
| Document build | MyST's engine and a fresh Jupyter kernel for each page that needs execution, driven by nbclient | The selected Pixi Python environment |
| Website build | Astro and Starlight render the resolved MyST documents | The site's npm dependencies |
| Published page | Static HTML, styles, and client-side plots | Assets produced by Astro |
| Interactive session | Browser-local Xeus Python, with editors and buttons supplied by Thebe | Browser packages declared in `environment.yml` |

Nbclient is the Jupyter client that executes build-time cells. Xeus is the
kernel framework used for browser Python. Thebe provides browser editors and
execution controls. Build and browser environments are independent: a Python
package installed in Pixi is not automatically available in the browser.

Successful execution results are cached. Prose edits reuse those results;
changes to executable code, tracked Python inputs, or declared dependencies
invalidate them. See [execution settings](reference.md#native-execution).

## Project status

This documentation describes the unpublished **0.5.0 alpha migration**. APIs
and behavior may change. Build a local archive from the migration checkout;
older `0.4.x` releases do not provide this configuration.

MyST owns document semantics; the Astro adapter supports a defined set of
resolved nodes and fails explicitly when it cannot render one. Source-selection
markers distinguish authored text from generated output. Publish notebook
output only from code you control. See [development](development.md) for
validation requirements and the downstream consumer gate.
