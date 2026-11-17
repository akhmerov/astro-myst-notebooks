---
title: Rich execution outputs
kernelspec: {name: python3, display_name: Python 3, language: python}
---

This page exercises the structured outputs passed from MyST to the theme.

```{code-cell} python
from IPython.display import display
display({'text/html': '<strong>Rich HTML output</strong>'}, raw=True)
display({'text/markdown': '**Rich Markdown output**'}, raw=True)
display({'text/latex': r'\frac{1}{2}'}, raw=True)
display({'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='}, raw=True)
display({'application/vnd.plotly.v1+json': {
    'data': [{'x': [1, 2, 3], 'y': [1, 4, 9], 'type': 'scatter'}],
    'layout': {'title': {'text': 'Structured Plotly output'}}
}}, raw=True)
```
