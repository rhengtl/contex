"""Re-score saved math predictions with semantics-aware LaTeX normalization.

Separates cosmetic markup differences (which render identically) from real
recognition errors, so the reported accuracy reflects the math, not the styling.
"""
import os, json, re
from collections import defaultdict
from score_math import lev, tokens

BENCH = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(BENCH, "results_math.json"), encoding="utf-8"))


def normalize2(t):
    t = t.strip().strip("$").strip()
    # font / style wrappers that do not change the math
    t = re.sub(r"\\mathrm|\\mathbf|\\bf\b|\\rm\b|\\displaystyle|\\textstyle", " ", t)
    t = re.sub(r"\\(dfrac|tfrac)", r"\\frac", t)
    t = re.sub(r"\\(big|Big|bigg|Bigg)[lr]?", " ", t)
    t = re.sub(r"\\left|\\right|\\quad|\\qquad|\\,|\\;|\\!|\\:|~", " ", t)
    # \operatorname*{lim} -> \lim ;  \mathop{=} -> =
    t = re.sub(r"\\operatorname\*?\s*\{([^{}]*)\}", r"\\\1", t)
    t = re.sub(r"\\mathop\s*\{([^{}]*)\}", r"\1", t)
    # \underset{x \to 0}{\lim} -> \lim_{x \to 0}
    t = re.sub(r"\\underset\s*\{([^{}]*)\}\s*\{(\\[A-Za-z]+)\}", r"\2_{\1}", t)
    t = re.sub(r"\\limits", " ", t)
    # unwrap braces around a SINGLE token only: {x} -> x, {\alpha} -> \alpha.
    # Must not touch {dy}, which is a two-token group and meaningful.
    for _ in range(3):
        t = re.sub(r"\{\s*(\\[A-Za-z]+|[A-Za-z0-9])\s*\}", r"\1", t)
    t = re.sub(r"\\([()])", r"\1", t)   # \( -> ( : escaped-delimiter artifact
    t = re.sub(r"\s+", "", t)
    # strip one layer of redundant braces around a \frac group: {\frac..} -> \frac..
    t = re.sub(r"\{(\\frac[^{}]*(?:\{[^{}]*\}){0,2})\}", r"\1", t)
    return t


agg = defaultdict(lambda: {"ce": 0, "nc": 0, "te": 0, "nt": 0, "ex": 0, "n": 0})
bad = []
for r in rows:
    g, p = normalize2(r["gt"]), normalize2(r["pred"])
    gt_tok, p_tok = tokens(g), tokens(p)
    a = agg[r["cond"]]
    a["ce"] += lev(g, p); a["nc"] += len(g)
    a["te"] += lev(gt_tok, p_tok); a["nt"] += len(gt_tok)
    a["ex"] += (g == p); a["n"] += 1
    if g != p:
        bad.append({**r, "gt_n": g, "pred_n": p, "cer": lev(g, p) / len(g)})

tot = defaultdict(int)
print(f"{'condition':<10}{'char acc':>10}{'token acc':>11}{'exact match':>16}")
for c in dict.fromkeys(r["cond"] for r in rows):
    a = agg[c]
    for k in a:
        tot[k] += a[k]
    print(f"{c:<10}{1 - a['ce'] / a['nc']:>9.2%}{1 - a['te'] / a['nt']:>11.2%}"
          f"{a['ex']}/{a['n']} = {a['ex'] / a['n']:>7.0%}")
print("-" * 47)
print(f"{'OVERALL':<10}{1 - tot['ce'] / tot['nc']:>9.2%}{1 - tot['te'] / tot['nt']:>11.2%}"
      f"{tot['ex']}/{tot['n']} = {tot['ex'] / tot['n']:>6.0%}")

print(f"\nremaining real errors: {len(bad)}")
for r in bad:
    print(f"  [{r['cond']:<7}] CER {r['cer']:>5.0%}  GT  : {r['gt_n']}")
    print(f"{'':<21}  PRED: {r['pred_n']}")
