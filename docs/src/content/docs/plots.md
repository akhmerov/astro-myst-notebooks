---
title: Plotly figures
---

Plotly figures use their authored height, or 420 pixels when no height is set.
They resize with the page. TeX labels such as $C/k_B$ use a locally bundled
MathJax SVG renderer, downloaded only for figures containing math labels.
Document equations continue to use KaTeX.
If the label renderer cannot be downloaded, the chart still appears with plain
text labels. See the browser console for the download error.

These examples emit Plotly JSON directly, so they need no Python plotting
package. Enable interactivity and run the cell to recreate the figures in
browser Python.

```{code-cell} python
from IPython.display import display

for height in [250, 520, None]:
    layout = {
        "title": {"text": "Heat capacity"},
        "xaxis": {"title": {"text": "Atomic number"}},
        "yaxis": {"title": {"text": "$C/k_B$"}},
        "annotations": [{"x": 2, "y": 3, "text": r"$\frac{1}{2}$", "showarrow": False}],
        "margin": {"l": 80, "r": 30, "t": 45, "b": 55},
    }
    if height is not None:
        layout["height"] = height
    if height == 520:
        layout["width"] = 360
    display({"application/vnd.plotly.v1+json": {
        "data": [{"x": [1, 2, 3], "y": [1, 4, 2], "type": "scatter",
                  "mode": "lines+markers", "line": {"color": "#d00080", "width": 4},
                  "marker": {"size": 12, "color": "#d00080"}}],
        "layout": layout,
    }}, raw=True)

display({"application/vnd.plotly.v1+json": {
    "data": [{"x": [0, 1, 2], "y": [0, 2, 1], "z": [0, 1, 2],
              "type": "scatter3d", "mode": "lines+markers",
              "line": {"color": "#d00080", "width": 8},
              "marker": {"size": 8, "color": "#d00080"}}],
    "layout": {"height": 360, "margin": {"l": 0, "r": 0, "t": 20, "b": 0}},
}}, raw=True)
```
