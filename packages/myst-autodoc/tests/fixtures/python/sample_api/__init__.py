"""A small API for interoperability tests."""

from ._impl import Result, solve

# Static extraction must never execute the package.
raise RuntimeError("autodoc must not import sample_api")
