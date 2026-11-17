# Frozen lexical provenance baseline

These development fixtures preserve the parser, custom syntax, and original
source-map attachment from commit `bd7fa84`. They let migration checks compare
against the previous implementation independently of changes to production
provenance code. They are excluded from the published package, whose files are
limited to `dist` and the npm shrinkwrap.

This is a lexical baseline: it parses an individual source document. It does
not expand includes, resolve a project, execute Python, or render pages. It is
not a second production parser or evidence of complete semantic equivalence.
`check-provenance-parity.mjs` validates the actual finalized MyST page JSON
against canonical source separately from the comparison.

The coverage denominator counts the baseline's own-page `text` and `inlineCode`
characters carrying authored origins, both exact and range. Included-file
contributions and declared generated nodes are excluded; unmapped and
unclassified characters are reported separately. The comparison also reports
the union of exact source intervals, so repeated AST nodes do not inflate that
measure. Notebook inputs use their declared canonical MyST representation.
With `--baseline-prefix`, pages outside the selected authored-source prefix
(such as generated API pages) are excluded from the lexical denominator while
all their published origins remain subject to validation.
