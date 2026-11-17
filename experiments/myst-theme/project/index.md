---
title: MyST with Astro
kernelspec: {name: python3, display_name: Python 3, language: python}
---

This page is resolved by MyST and rendered by Starlight.

## A live calculation

```{code-cell} python
:tags: [hide-input]
:label: triangular-result

n = 6
print(f"The triangular number is {n * (n + 1) // 2}")
```

The computed value in prose is {eval}`n * (n + 1) // 2`.

See [the equation](second.md#triangle) on the second page.

```{include} _included.md
```
