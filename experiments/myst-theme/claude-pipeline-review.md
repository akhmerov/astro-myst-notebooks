# Independent Claude Opus pipeline review

Requested by the user; review completed on 2026-10-13 in T3 thread
`68030c4f-0588-4e80-bd09-a6c08775f3e2`. This is the independent reviewer's
assessment, including alternatives it explicitly marks as untested. Read the
follow-up below for corrections to execution-configuration and filtered-include
claims in the initial review. The
[pipeline assessment](pipeline-options.md) records the resulting synthesis and
additional verification.

I recommend MyST as the document engine, with Astro kept as the site driver, rather than MyST as the whole build driver. Of the six probe gaps, five are cheap fixes in the theme or plugin layer; only Word export dropping tab content is a MyST limitation. The bigger risks are elsewhere: the `build.render` hook is new and thin, the three plugins depend on each other's data in undocumented ways, and consumers would lose Astro-level configuration.

**What I ran:** `pipeline-probes.mjs`, once, writing to `/tmp/claude-review/results.json`. Its results match `pipeline-results.json`. I then checked the probe fixtures directly: I pulled the text out of the Word file, read the computed page JSON, and rendered MyST's resolved trees with the shared `mystRehype`. I did not rerun `myst:test`, the browser tests or the autodoc tests, and I edited nothing in the repo.

## 1. The six probe claims, checked against the evidence

| Probe | What I found | Category |
|---|---|---|
| Tabs in the theme | MyST's resolved `tabSet`/`tabItem` tree renders correctly with the existing `mystRehype` handler (tablist, panels, `hidden`). The theme fails only because `theme/content.mjs:14` leaves those node types off its list of supported nodes. | Implementation gap; small |
| Tabs in Word | Confirmed with real text extraction: the document text is just `'Tabs'`, with no panel content. This is MyST's own Word exporter. | Upstream limitation |
| Citations | MyST resolves them fully. The page JSON has `references.cite.data.example.html` and a `cite` node with its rendered text and number. The shared default handler puts a `<div>` inside a `<p>`, so `cite`, `citeGroup` and the bibliography each need a small adapter that reads `page.references`. Word export does contain the citation. | Implementation gap; small |
| Filtered includes | The README says the document hook "does not provide the original selected source slice". That is wrong: the include node carries `filter: {lines: [[2]]}`, and `myst-transforms` exports `filterIncludedContent`. Rerunning that function on the original file reproduces the slice. The current `parseDocument(content, …, fullSource)` path can then map offsets as it does today. | Implementation gap, not architectural |
| Grouped table of contents | MyST sends a flat page list with `level` fields and title-only group entries. `content.mjs:36` rejects anything that isn't flat. Mapping levels to Starlight sidebar groups is straightforward. | Implementation gap |
| Cross-project MyST link | Confirmed: the link is `resolved` with `remoteBaseUrl` set, but `content.mjs:47` builds the href from `node.url` alone, so it renders as `/#shared-target`. | Bug; one-line fix |

## 2. Problems the probes don't cover

1. **The filtered-include check is a regex over the whole source** (`provenance.mjs:13`). Any page that shows `:start-line:` inside a fenced example would fail the build. The current docs don't do this (I grepped), so it is latent.
2. **Execution settings in `myst.yml` are silently ignored.** `execution.mjs:25` rejects only `extends`. Project-level `execute` and `kernelspec`, and every page `execute` key other than `skip` (`:36`), are dropped without an error. This breaks the repo's rule that unsupported configuration fails explicitly, and it should fail now.
3. **A plain `myst build` doesn't work.** `render.mjs:10–17` needs `ASTRO_MYST_PROJECT`, because the 1.11 hook never passes the project path. Separately, typed inventories need the `myst-autodoc build` wrapper. Two possible fixes, both untested:
   - A plugin module sets `process.env.ASTRO_MYST_PROJECT = process.cwd()` when it loads; MyST spawns the render command with `...process.env`, so the theme would inherit it.
   - `render.mjs` calls `augmentInventory` itself, since it already copies `objects.inv`.
4. **Published page JSON can overwrite other files.** `render.mjs:39` writes `${slug}.json` into the site root after `config.json` and the inventories are copied. A page with slug `config` would overwrite `config.json`.
5. **The plugins depend on each other through hidden data fields.** They pass `data.astroNotebookTags`, `data.autodocGenerated` and `data.origin`, and the result depends on their order in `project.plugins`. Correct output relies on that order plus MyST's transform scheduling. This is the main maintenance risk of "independently usable plugins".
6. **Notebook prose loses provenance.** The current package gives `.ipynb` prose offsets marked `representation: 'myst'` (`source-map.mjs:36–39`); the experiment gives it none. This is a regression in the public provenance contract, not just a gap.
7. **The book-theme compatibility evidence is thinner than it sounds.** The autodoc "plain MyST consumer" test runs `myst build --site` and checks only the JSON trees. No test renders autodoc output through the book theme's HTML.
8. **The current pipeline has its own scaling problem.** `documents.mjs:126` re-parses and re-prepares every route for every page rendered, so cost grows with the square of the page count. It also forbids embedding executed cells (`:141`). MyST builds the project graph once and supports output embeds, and those embeds reach Word export. These are real gains of moving to MyST.

## 3. Comparing the options

- **Current Astro-driven package**
  - Keeps: the consumer's own `astro.config` (branding, Starlight components, sidebar), `astro dev` live reload, wide node coverage, notebook provenance, and an established `.tgz` distribution tested in Pymablock.
  - Lacks: Word/PDF/Typst exports, output embeds, `myst.xref.json` for other MyST projects (only Sphinx inventories), a reusable project graph, and the MyST include/reference semantics we currently reimplement.
- **MyST driver + custom Astro theme (the prototype)**
  - Gains: MyST's parsing, includes, numbering, references, cross-project links, exports, `myst.xref.json`, and output embeds.
  - Costs: the consumer's Astro and Starlight configuration moves behind `myst.yml` and template options, which don't exist yet. It also loses `myst start` and watch mode: the template has no `build.start`, MyST falls back to `npm run start`, and the autodoc CLI rejects `--watch`. There is no execution cache. Packaging adds a step: MyST installs template dependencies with `npm ci --ignore-scripts`.
  - Relies on `build.render`, which first appeared in 1.11.0 and has a single tested version.
- **MyST + upstream book theme**
  - Gains: full node coverage, hover previews and `myst start`, with no theme to maintain.
  - Loses: Starlight, Xeus/emscripten-forge browser execution (Thebe there means Binder or Pyodide-based JupyterLite, against the roadmap), provenance markers, our presentation tags, and download controls. Customising a React/Remix theme means forking it.
  - Best used as a CI compatibility target for the plugins, not as the product.
- **A separate MyST preprocessing step before Astro (`myst build --site`, then Astro reads `_build/site`)** — untested, and the best transition path.
  - The experiment's content loader is already almost this; only its data source changes from `CONTENT_CDN` to a directory or URL.
  - It keeps the consumer's `astro.config`, the existing integration's runtime and assets, and `astro dev`, which can watch the content JSON.
  - It keeps MyST semantics and exports, and `render.mjs` becomes a thin optional wrapper over the same loader.
  - Costs: two commands, a base URL that must agree between them, and a sidebar that must come from `config.json` to avoid duplicating the table of contents.

**I'd push back on one boundary.** Make "MyST document engine → shared loader/renderer (an API of this package) → Astro" the contract, and treat MyST-as-driver as one way to invoke it. Don't make it the consumer's entry point.

## 4. Biggest risks

1. The upstream extension points are thin. The document transform gets no resolved frontmatter, the render hook gets no project path, and there is no hook for supplying an executor. The page JSON layout, including compact MIME data and asset paths, is semi-internal to MyST's own themes. Pin MyST exactly and gate upgrades with the probes.
2. The execution workaround keeps growing toward reimplementing MyST's configuration handling (see finding 2).
3. Provenance can quietly lose precision: notebook prose, filtered includes, and code cells matched only by unique text search.
4. The development loop: there is no evidence yet of any working watch path.

## 5. Experiments and fixes needed to justify migration, in order

1. Cheap fixes, each with a test: use `remoteBaseUrl` in links; add tabs, grid, card, footnotes, glossary, iframe, mermaid and `mathGroup` to the supported list; write citation and bibliography adapters; map grouped tables of contents to the sidebar; avoid the slug collision; fail loudly on ignored execution configuration; make the filtered-include check structural; rebuild filtered-include provenance with `filterIncludedContent`.
2. Run the shared loader against `_build/site` from a consumer-owned `astro.config`, alongside `myst build --site --watch` and `astro dev`. Measure edit-to-reload time, including after Python edits.
3. Try removing both wrappers (the environment variable set by a plugin, and inventory merging inside the theme), and make plugin ordering explicit or fail loudly when it is wrong.
4. Notebook provenance that keeps `representation: 'myst'`, with tests that compare offsets against the source text.
5. A parity corpus: build `docs/` and Pymablock through both paths and diff node coverage, links, anchors, inventories, and browser checks under a URL prefix.
6. Packaging: the theme and loader in the npm archive, installed with `--ignore-scripts`, tested through `release:check` and in Pymablock.
7. Execution: the probes' timing is from tiny fixtures. Test cross-page kernel concurrency and memory on a realistic book. Revisit native MyST execution once the upstream cell-timeout request (#2793) lands. Propose a resolved-settings or executor hook upstream.
8. Render autodoc output through the book theme's HTML, to back the claim that the plugins work independently.

## Follow-up: verified settings and provenance, including corrections

Your answer to the user is right: we can define our own settings, but the document hook never receives MyST's resolved page frontmatter. Two of my earlier findings need correcting, though: one overstated what the plugin ignores, and one wrongly called a MyST function public. Nothing in the repo was edited.

## 1. Execution configuration

**What MyST 1.11 accepts** (`node_modules/mystmd/dist/myst.cjs`):
- `execute` and `kernelspec` are page-only keys. They are listed in `PAGE_FRONTMATTER_KEYS` (187559) and absent from `PROJECT_FRONTMATTER_KEYS` (187546).
- `execute` accepts only `skip`, `depends_on_env` and `cache` (`EXECUTE_KEYS`, 191856).
- The deprecated `skip_execution` page key is mapped onto `execute.skip`.
- `jupyter.kernelspec` is moved into `kernelspec` (`unnestKernelSpec`, 192137).
- Page frontmatter inherits only a short fallback list from the project (`USE_PROJECT_FALLBACK`), which has no execution keys.

**Strict mode doesn't reject them.** A local fixture with `project.execute` and `project.kernelspec`, built with `myst build --site --strict`, exited 0. It printed one warning: `'config.project' extra keys ignored: execute, kernelspec`.

**Correction to my finding 2.** Project-level `execute`/`kernelspec` are invalid input that MyST itself ignores, so the plugin silently ignoring them is not a divergence. One more consequence: `extends` can't carry execution settings either, so rejecting it (`execution.mjs:25`) is broader than execution needs.

**Valid page settings the plugin really does ignore:**
- `skip_execution: true`. `execution.mjs:36` reads only `page.execute`, so a page that is correctly marked "skip" in MyST still executes. This is a real bug.
- `execute.cache` and `execute.depends_on_env`. These are valid but meaningless for nbclient, so the plugin should warn or fail rather than accept them silently.
- `kernelspec.name`. Only the language is checked; the kernel name never selects the interpreter, which is always the plugin's one configured Python.

**Output settings are not lost.** `settings.output_stdout`, `output_stderr` and `output_matplotlib_strings` are valid at both project and page level. MyST applies them itself after the document plugins run (`transformFilterOutputStreams`), so they still act on our outputs.

**What the hook receives.** Document plugins are called as `pipe.use(t.plugin, undefined, pluginUtils)` (298948). `pluginUtils` contains only `{select, selectAll}`, the VFile carries no frontmatter, and the parsed frontmatter block has already been stripped from the tree. That forces the plugin to re-read the page file itself and re-apply MyST's aliasing and validation.

So:
- **Plugin options** (timeout, Python) belong in the plugin factory.
- **Theme options** belong in `site.options` / `template.yml`.
- **Built-in page settings** are the gap: the plugin can only approximate them by reimplementing frontmatter validation.

## 2. Filtered-include provenance

**Correction: `filterIncludedContent` is not public.** It exists in `myst-transforms` 1.3.50 at `dist/include.js`, but neither `dist/index.js` nor the package `exports` (a single `"./dist/index.js"`) exposes it. Importing it returns `false`. My earlier "exported, so the gap is easy" claim was wrong.

**A public but indirect route exists (untested).** `includeDirectiveTransform` is exported. Run it on a copied include node with a stub `loadFile` that returns the raw file; its `parseContent(name, content)` callback then receives the filtered text. For the starting line, mark the copy `literal` with `startingLineNumber: 'match'` and read back the `startingLineNumber` field on the generated `code` child (logic at 232212).

**What the tree already gives us.** Included children's positions are relative to the filtered string. In the probe, "Selected line." is at `line: 1` even though it is line 2 of `part.md`. Recovering the text plus its starting line therefore gives an exact base offset for contiguous filters (`start-line`, `start-after`/`end-before`, a single `lines` range). That is better than the current `fullSource.indexOf(source)` search (`source-map.mjs:27`), which fails whenever the slice also appears elsewhere in the file.

**Noncontiguous `:lines: 1-2,5` selections can't be mapped from the public API.** MyST joins the selected segments with `\n` and returns only the content and the first starting line, with no map from each segment back to its original lines. Mapping them would mean reimplementing MyST's private range logic (`index3`, negative indices), which could drift between versions, or asking upstream to return a line map.

The current pipeline doesn't handle noncontiguous selections either: the joined text is not a substring of the file, so it throws "Cannot map filtered include uniquely". The realistic parity target is therefore exact mapping for contiguous filters and an explicit failure for noncontiguous ones.

**Further requirements:**
- Nested includes inside a filtered include need the same treatment.
- Literal includes produce `code` nodes without positions, so those can only be marked as a range.
- Replace the regex check at `provenance.mjs:13` with checks on `node.filter`.
- Pin MyST exactly: the bundled filter and the standalone package are separate copies.
