---
title: Executable walkthrough
description: Follow one page from native Jupyter execution to an editable browser notebook.
---

This page computes a small sequence, checks its closed form, and displays the
result in several MIME formats. Everything below uses Python's standard library
and IPython, so the native and browser environments need no scientific packages.

## Shared state across cells

The first cell defines the number of terms. Its output is generated during the
site build. Enable interactivity using the wand beside a cell’s copy button,
then select **Run all** to repeat the calculation in your browser. Change `n`
to see the later outputs change together.

```{code-cell} python
n = 8
values = list(range(1, n + 1))
print(f"Terms: {values}")
```

Every cell on this page shares one kernel. This hidden setup cell imports the
display helpers used later; it also runs when you choose **Run all**.

```{code-cell} python
:tags: [hide-cell]

from IPython.display import display
```

The sum of the first $n$ positive integers is

(triangular-sum)=
```{math}
S_n = \sum_{k=1}^{n} k = \frac{n(n+1)}{2}.
```

We check {eq}`triangular-sum` against the explicit sum. An assertion failure
would stop the documentation build.

```{code-cell} python
total = sum(values)
assert total == n * (n + 1) // 2
print(f"Sum: {total}")
```

## Rich output from MIME bundles

Jupyter records structured MIME bundles. This cell supplies both HTML and plain
text; the renderer selects HTML according to its MIME priority.

```{code-cell} python
display({
    "text/html": f"<p><strong>Computed total:</strong> {total}</p>",
    "text/plain": f"Computed total: {total}",
}, raw=True)
```

The next cell emits Plotly's JSON MIME format directly. No Python Plotly package
is needed for this example. Hover over the points or drag to zoom.

```{code-cell} python
display({
    "application/vnd.plotly.v1+json": {
        "data": [{
            "x": values,
            "y": [k * (k + 1) // 2 for k in values],
            "type": "scatter",
            "mode": "lines+markers",
        }],
        "layout": {
            "title": {"text": "Partial sums"},
            "xaxis": {"title": {"text": "Number of terms"}},
            "yaxis": {"title": {"text": "Sum"}},
            "height": 320,
            "margin": {"t": 50, "r": 20, "b": 50, "l": 50},
        },
    },
    "text/plain": "A plot of partial sums",
}, raw=True)
```

## Included prose and source maps

```{include} _partials/_provenance.md
```

Resetting the interactive session starts a fresh kernel and preserves edited
cells. Choose **Run all** again to recreate the shared state. Reloading the
page restores the authored code and build-time output.

The [authoring guide](authoring.md) shows the source syntax, and
[browser execution](browser.md) explains how to add your own packages.
