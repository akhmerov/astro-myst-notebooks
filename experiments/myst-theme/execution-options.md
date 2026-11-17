# MyST execution options: concrete comparison

This report compares executors. The [full pipeline assessment](pipeline-options.md)
covers project configuration, plugins, rendering, references, exports,
development, and distribution; executor correctness alone does not establish
migration readiness.

The recommended next step for this repository is MyST as the document/build
driver, the nbclient document plugin as its Python executor, and the custom
static theme as the renderer. Browser execution stays in the existing runtime.
The experiment now uses that arrangement by default.

This recommendation is provisional. Native MyST execution with explicit input
digests is an attractive alternative when persistent caching matters, but its
missing cell timeout remains a regression against the current adapter.

## What was run

The [comparison harness](compare-execution.mjs) runs MyST 1.11.0 against five
temporary consumer projects. It uses the selected Pixi Python for both nbclient
and native Jupyter kernels. Native cases additionally launch Jupyter Server;
the server's Python can be selected separately with `MYST_NATIVE_PYTHON`.
Each fixture links this checkout's locked npm dependencies, as a consumer
needs the renderer dependencies available. These are checkout-local experiments,
not tests of an independently distributed theme archive.

Each computational fixture imports a local Python module, records executions,
interleaves inline expressions with cells, labels an output, and embeds that
output on another page. The harness checks repeated builds, changes to imported
Python source, a three-second cell, unexpected/expected exceptions, actual
static HTML, and the XML inside a Word export. It checks execution counts to
rule out execution during rendering of already computed documents.

The [sanitized results](execution-results.json) were recorded on 2026-10-01.
Full Jupyter logs, which can contain connection credentials, are not retained.

## Findings

| Option | Outputs available to MyST embeds and Word exports | Changed imported Python source | Persistent cache | Cell timeout |
| --- | --- | --- | --- | --- |
| nbclient during HTML rendering | No; direct HTML gets results after document processing | Fresh on another build | No | Existing adapter |
| Native MyST, default cache | Yes, including stale results | Stale: `11` remained after changing the module to `1234` | Yes | Unavailable in 1.11.0 |
| Native MyST, cache disabled | Yes | Fresh | Disabled | Unavailable in 1.11.0 |
| Native MyST, explicit input digest | Yes | Fresh for declared inputs | Yes | Unavailable in 1.11.0 |
| nbclient document plugin | Yes | Fresh | No | Existing adapter |

Both native execution and the document plugin produced inline values `1`,
`11`, and `2` in authored order. Both failed unexpected exceptions and allowed
cells tagged `raises-exception`. The document plugin failed the three-second
cell with its configured one-second timeout; native execution completed it.
The native timeout case had a separate bounded harness deadline, so it did not
leave an indefinitely running experiment.

In this tiny two-cell fixture, native execution took about 1.6–1.7 seconds for
the first site build and 0.5–0.6 seconds for a cache hit. The document plugin
took about 1.2 seconds on each build. These are single local measurements of
startup and document processing, not performance estimates for scientific books.
Persistent caching could save considerably more time on expensive computations.

The digest case hashes an explicitly declared Python module, the Pixi lockfile,
and the selected interpreter path, then supplies that value through
`execute.depends_on_env`. This fixes the tested import change without giving up
cache hits. It does not discover imports or data dependencies automatically;
real consumers must define the relevant inputs. See MyST's
[execution configuration](https://mystmd.org/guide/notebooks-with-markdown#control-of-execution).

## What the document-plugin prototype establishes

[execution.mjs](execution.mjs) calls the existing adapter and fills ordinary
MyST `outputs`, `output.jupyter_data`, and `inlineExpression.result` fields.
MyST then handles inline rendering, MIME asset publication, references, embeds,
and document exports. No private MyST session or store API is used.

The theme translates computed cells into the existing browser markup and
restores MyST's compact MIME/asset representation for our MIME renderer. The
public package's implementation is unchanged; the experimental presentation
adapter should be folded into a shared rendering API before packaging.

Additional real-build checks cover plugin defaults and page execution policy,
`skip-execution`, continuation after an expected exception, nested-page working
directories, and explicit rejection of inherited configuration. The existing
source-provenance and typed Python inventory checks continue to pass.

Browser checks in the collaborative T3 browser confirmed activation without
execution, rerunning edits, preserving edits through restart, terminating an
infinite loop, and running hidden setup cells from `.ipynb` input. They also
confirmed exact included-source selections. HTML, Markdown, math, and PNG outputs
rendered; the Plotly output had a painted trace in a 420-pixel-high figure.

The automated checks passed too: eight experiment build/policy tests and five
Chromium theme tests, including deployment under `/theme-check/`; the package's
48 compiled tests, TypeScript check, seven documentation output tests, and 13
documentation browser tests; and archive creation with `pixi run pack`. The
archive still excludes the experimental theme. The npm lockfile was aligned
with its existing sanitizer overrides so `npm ci` could run the required checks.

The custom theme now publishes the computed page JSON advertised by
`myst.xref.json`, alongside assets and inventories. This supplies content for
external MyST consumers. Hover-preview UI in our own theme is still separate
work; the current renderer presents ordinary reference links.

## Limits that affect the choice

MyST 1.11's public document transform receives an AST and VFile, without
resolved frontmatter or an execution-provider interface. The prototype reads
local Markdown frontmatter or notebook metadata itself, and reads `myst.yml`
to reject inherited configurations. It is intentionally limited to one local
project and Python. Supporting MyST's full configuration semantics this way
would duplicate part of the driver; a supported resolved-settings hook would
make the plugin substantially cleaner. MyST acknowledges that its
[plugin extension points are still growing](https://mystmd.org/guide/plugins).

Native execution supports the driver configuration directly and offers
persistent caching, parallelism, and other kernels. It adds Jupyter Server and
kernelspec setup. It does not yet provide the adapter's cell deadline; see the
[upstream timeout request](https://github.com/jupyter-book/mystmd/issues/2793).
A build-wide deadline would be a coarser policy and would need reliable process
cleanup. This experiment has not established that as an equivalent replacement.

The native server environment must not accidentally become the theme's Python
environment. The temporary server environment contained nbclient 0.11, while
the package requires 0.10. Explicitly selecting the Pixi interpreter for the
theme's environment check resolved that mismatch. A future browser-only theme
integration should avoid requiring an unused execution adapter altogether.

Consumer builds also exposed Astro's staging-directory and dependency-resolution
assumptions. The renderer now builds with the consumer as its working directory
and keeps consumer caches separate. The comparison fixtures make installed
dependencies explicit instead of relying on a project being inside this repo.

Watch mode and Python-source dependency watching, an independently packaged
theme, richer renderer coverage, notebook prose provenance, and filtered-include
provenance remain migration work. The post-build typed inventory augmentation
and isolated Sphinx inventory reader remain necessary whichever executor is
chosen.

## Recommended sequence

1. Use the document plugin to establish the computed-document/rendering boundary
   while preserving the selected Python environment and execution safeguards.
2. Extract a shared presentation API and package the theme; complete configuration
   mapping and the development-server contract.
3. Evaluate native execution again after a supported timeout/cleanup policy is
   available. Keep the explicit input-digest strategy for persistent cache
   correctness. Seek a resolved-settings/execution hook upstream if retaining
   nbclient would otherwise require expanding the configuration workaround.

Switching build executors does not require switching browser controls or the
isolated autodoc/Sphinx interoperability package.
