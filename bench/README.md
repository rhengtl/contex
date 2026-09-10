# Benchmark fixtures

Synthetic pages with known ground truth, used by the edge test suite to measure
the offline conversion path against something it cannot have memorised.

```
img_mixed/    prose and mathematics, printed and handwritten, in combination
img_pages/    whole pages: headings, lists, display maths, at two qualities
img_math/     isolated expressions, for formula recognition
manifest_*.json   the ground truth for each set
```

## These are frozen, not generated

They used to be produced by `gen_*.py` from a Python toolchain — PIL, numpy,
matplotlib, and for `img_pages/` the LaTeX pipeline of the Flask implementation
that used to live in this repository. That implementation has been removed, so
the images are committed instead.

That is a deliberate trade. It costs ~3 MB in Git and means the corpus can no
longer be extended or regenerated; it buys a test suite that runs on a clean
checkout, which the previous arrangement did not — the images were gitignored,
so they existed only on the machine that had once run the generators.

The generators are in the Git history if the corpus ever needs to grow again.

## Who reads them

| Suite | Reads |
|---|---|
| `edge/tests/fallback.mjs` | `img_mixed/`, `img_pages/`, `manifest_mixed.json`, `manifest_pages.json` |
| `edge/tests/integration.mjs` | `img_mixed/print_prose_print_math.png`, `img_pages/headings_hi.png` |
| `edge/tests/formulas.mjs` | `img_math/`, `manifest_math.json` |
| `edge/tests/serve.mjs` | serves the tree to the browser suites at `/bench/` |

Scores are printed by the suites that use them; nothing here is a pass/fail
gate on its own, because a recogniser's accuracy is a measurement rather than
an assertion.
