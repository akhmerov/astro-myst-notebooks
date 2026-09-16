---
title: Author MyST
description: Write executable cells, references, includes, equations, and source-aware prose.
---

The integration uses `myst-parser` for syntax and `myst-transforms` for document
semantics. It supports a subset of MyST; unknown roles, unsupported constructs,
missing references, and cyclic includes fail explicitly.

## Executable cells

A MyST `code-cell` directive executes Python. An ordinary Python fence is
displayed without execution.

````markdown
```{code-cell} python
x = 41
x + 1
```

```python
raise RuntimeError("This fence is displayed without running")
```
````

Each executable page gets a fresh native Jupyter kernel. Cells run in source
order and share state only within that page. A cell error or timeout fails the
build. The default working directory is `execution.cwd`; a page with
`kernelspec` frontmatter instead executes from its source directory.

### Hide setup or output

Tags belong to the directive options:

````markdown
```{code-cell} python
:tags: [hide-input]

print("The code is collapsible; this output stays visible")
```
````

| Tag | Static page behavior |
| --- | --- |
| `hide-input` | Put the input in a “Show code” disclosure |
| `remove-input` | Omit the displayed input |
| `hide-output` or `remove-output` | Omit the output |
| `remove-stdout` or `remove-stderr` | Omit one stream while keeping other outputs |
| `hide-cell` or `remove-cell` | Hide the entire cell |
| `raises-exception` | Expect an error; publish the traceback instead of failing the build |
| `skip-execution` | Publish the input without running it during the build |

A cell that raises without `raises-exception` still fails the build, and a
tagged cell that succeeds is published as is. Browser **Run all** continues
past a tagged cell's error and stops at any other error.

Set `execute: { skip: true }` in page frontmatter to publish every cell on the
page without executing it. Skipped cells have no published output. They are
still editable in the browser and run on request; **Run all** passes over them
just as the build does.

Hidden cells still execute during the build and remain in browser **Run all**
order. Activating interactive mode creates editors from authored source, so
input visibility tags are presentation controls, not a way to conceal source.
Set `thebe: false` in page frontmatter to retain build execution while disabling
that page's interactive controls.

## Equations and links

Label an equation and refer to it by name:

````markdown
(energy)=
```{math}
E = mc^2
```

See {eq}`energy`.
````

Labelled equations are numbered unless an explicit MyST enumeration option
says otherwise. The [walkthrough's sum](walkthrough.md#triangular-sum) is a live
example of a file-qualified equation link. Cross-page `.md` links resolve
through the collection manifest. Local labels take precedence; ambiguous
remote labels need a file-qualified link.

## Include another source file

````markdown
```{include} _partials/_explanation.md
```
````

Include paths resolve relative to the including file. Keep include-only files
outside the loader's pattern; this site's underscore-prefixed filenames are
excluded by `**/[^_]*.md`. Included prose retains its own file origin. A filtered
include must map uniquely to a contiguous region of the original source.

Until relative included assets are rebased by the integration, use a
root-relative public asset URL such as `/figures/diagram.svg` inside includes.

## Citations and inventories

Declare a local BibTeX file in frontmatter, then cite its keys:

````markdown
---
title: References
bibliography: references.bib
---

See {cite:p}`example`.

```{bibliography}
```
````

If citations are present without a bibliography directive, the renderer appends
the cited entries. Bibliography paths resolve relative to the page source.

For external API references, configure Sphinx v2 inventories and write
`[Array](xref:numpy#numpy.ndarray)` or the role
`` {autolink}`~numpy.ndarray` ``. Local API definitions take precedence over
external matches. Missing or ambiguous targets fail the build. See
[configuration](reference.md) for inventory options and caching.

## Source maps for commenting

In a browser with a text selection:

```js
const selection = window.getSelection();
const mapped = window.mystSourceMap.resolve(selection.getRangeAt(0));
console.log(mapped);
```

The result contains selected text, a `complete` coverage flag, and individual
text ranges. Inspect each range's `origin` before attaching a comment:

| Field | Meaning |
| --- | --- |
| `file` | Path relative to the configured execution root |
| `revision` | Git revision, or `null` outside a Git checkout |
| `digest` | SHA-256 of the full source text |
| `encoding` | `utf-16`, matching JavaScript and DOM offsets |
| `start`, `end` | Source offsets, with an exclusive end |
| `kind` | `exact` text correspondence or a containing `range` |

Generated text has no authored origin, and transformed or ambiguous text can
have only a containing range. Comment persistence and relocation across
revisions belong to the consumer. Browser edits preserve the original document
provenance rather than inventing offsets for the edited code.
