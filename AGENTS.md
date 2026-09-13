# Development

This is the reusable Astro/MyST/Jupyter integration extracted from Pymablock.
Keep project content, Python scientific dependencies, branding, and API packages
in consumer repositories. Python execution uses nbclient in the selected Pixi
environment; do not introduce a separate Python distribution.

Use `pixi run test` and `pixi run check`. Tests exercise the compiled package.
Use `pixi run pack` to build a distributable archive, then test that archive in
the Pymablock consumer before changing browser or Astro integration boundaries.
The package includes its Python adapter, contract JSON, CSS, and browser modules.

Preserve source-map precision markers and explicit failures for unsupported MyST.
Never replace kernel termination with merely disposing its client connection.

When committing, add `Co-authored-by: Codex <codex@openai.com>`.
