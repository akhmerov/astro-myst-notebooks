---
title: Notebook presentation
description: Show, collapse, or remove notebook inputs and outputs without changing execution.
presentation:
  input: hide
  output: hide
  stdout: remove
---

This page overrides the site's presentation defaults in its frontmatter.
Inputs and outputs start collapsed; stdout is removed. The site also removes
stderr. Open **Show code** or **Show output** to inspect a cell. Enable
interactivity and run the page: the same presentation settings still apply.

```{code-cell} python
import sys
from IPython.display import display, clear_output
print("Filtered stdout")
print("Filtered stderr", file=sys.stderr)
display({"text/plain": "Visible result: 42"}, raw=True)
```

Cell tags override page and site defaults. This cell shows both streams:

```{code-cell} python
:tags: [show-input, show-output, show-stdout, show-stderr]

print("discarded")
clear_output(wait=True)
print("Kept stdout")
print("Kept stderr", file=sys.stderr)
handle = display("old result", display_id=True)
handle.update("updated result")
```

A whole cell can be revealed with one disclosure:

```{code-cell} python
:tags: [hide-cell, show-input, show-output, show-stdout]

print("Inside the cell disclosure")
```

Removed inputs stay out of view even after activation. **Run all** still runs
them:

```{code-cell} python
:tags: [remove-input, show-output, show-stdout]

print("Output without a displayed input")
```

Outputs can be removed independently. Expected errors still have their normal
execution meaning, even when the traceback is removed:

```{code-cell} python
:tags: [show-input, remove-output, raises-exception]

raise ValueError("Expected hidden traceback")
```

This removed setup cell defines a value used by the last cell:

```{code-cell} python
:tags: [remove-cell]

hidden_value = 6 * 7
```

```{code-cell} python
:tags: [show-cell, show-input, show-output, show-stdout]

print(f"Hidden setup ran: {hidden_value}")
```

See the [authoring guide](authoring.md#notebook-presentation) for configuration,
precedence, and migration from the input-only setting.
