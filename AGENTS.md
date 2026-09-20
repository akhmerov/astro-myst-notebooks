# Development

This is the reusable Astro/MyST/Jupyter integration extracted from Pymablock.
Keep project content, Python scientific dependencies, branding, and API packages
in consumer repositories. Python execution uses nbclient in the selected Pixi
environment; do not introduce a separate Python distribution.

Use `pixi run test` and `pixi run check`. Tests exercise the compiled package.
The repo's own MyST documentation lives in `docs/` and imports the package's
public exports. Use `pixi run docs-test` for its build, type, and output checks,
and `pixi run docs-browser` for real browser notebook checks. Keep examples
lightweight; use the existing Pixi Python environment.
Use `pixi run pack` to build a distributable archive and
`pixi run npm run release:check -- --api --browser` to initialize and build a
fresh consumer from it. Test the archive in the Pymablock consumer before
changing browser or Astro integration boundaries.
The package includes its Python adapter, contract JSON, CSS, and browser modules.

The README, overview, and setup page are the first things new users read. Keep
them plain: say what a command does and what it produces, name prerequisites,
and explain terms such as Thebe, Xeus, or source maps before relying on them.
Contributor detail belongs in the development page.

Preserve source-map precision markers and explicit failures for unsupported MyST.
Never replace kernel termination with merely disposing its client connection.

When committing, add `Co-authored-by: Codex <codex@openai.com>`.
