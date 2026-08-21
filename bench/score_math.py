"""Score the app's real equation.py path against the formula benchmark."""
import os, sys, json, re, time
from collections import defaultdict

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(BENCH))  # the app package lives one level up
import equation  # the app's actual model wrapper


def lev(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def normalize(t):
    """Collapse cosmetic LaTeX differences that do not change the rendered math."""
    t = t.strip().strip("$").strip()
    t = re.sub(r"\\dfrac|\\tfrac", r"\\frac", t)
    t = re.sub(r"\\left|\\right|\\quad|\\qquad|\\,|\\;|\\!|\\:", " ", t)
    t = re.sub(r"\\operatorname\s*\{([^}]*)\}", r"\\\1", t)
    t = re.sub(r"\{\s*([A-Za-z0-9])\s*\}", r"\1", t)  # {x} -> x
    t = re.sub(r"\s+", "", t)
    return t


def tokens(t):
    return re.findall(r"\\[A-Za-z]+|.", t)


def main():
    manifest = json.load(open(os.path.join(BENCH, "manifest_math.json"), encoding="utf-8"))
    agg = defaultdict(lambda: {"ce": 0, "nc": 0, "te": 0, "nt": 0, "ex": 0, "n": 0})
    rows, t0 = [], time.time()

    for k, m in enumerate(manifest, 1):
        with open(os.path.join(BENCH, "img_math", m["file"]), "rb") as fh:
            pred = equation.process_image(fh.read())
        g, p = normalize(m["gt"]), normalize(pred)
        gt_tok, p_tok = tokens(g), tokens(p)
        a = agg[m["cond"]]
        a["ce"] += lev(g, p); a["nc"] += len(g)
        a["te"] += lev(gt_tok, p_tok); a["nt"] += len(gt_tok)
        a["ex"] += (g == p); a["n"] += 1
        rows.append({**m, "pred": pred, "gt_n": g, "pred_n": p,
                     "cer": lev(g, p) / len(g), "exact": g == p})
        print(f"\r  {k}/{len(manifest)}", end="", flush=True)

    el = time.time() - t0
    print(f"\r  done in {el:.0f}s ({el / len(manifest):.2f}s per formula)\n")
    tot = defaultdict(int)
    print(f"{'condition':<10}{'char acc':>10}{'token acc':>11}{'exact match':>15}{'n':>5}")
    for c in dict.fromkeys(m["cond"] for m in manifest):
        a = agg[c]
        for k2 in a:
            tot[k2] += a[k2]
        print(f"{c:<10}{1 - a['ce'] / a['nc']:>9.2%}{1 - a['te'] / a['nt']:>11.2%}"
              f"{a['ex']}/{a['n']} = {a['ex'] / a['n']:>7.0%}{a['n']:>5}")
    print("-" * 51)
    print(f"{'OVERALL':<10}{1 - tot['ce'] / tot['nc']:>9.2%}{1 - tot['te'] / tot['nt']:>11.2%}"
          f"{tot['ex']}/{tot['n']} = {tot['ex'] / tot['n']:>5.0%}{tot['n']:>5}")
    json.dump(rows, open(os.path.join(BENCH, "results_math.json"), "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)
    print("\nmismatches (normalized):")
    for r in [r for r in rows if not r["exact"]][:8]:
        print(f"  [{r['cond']}] CER {r['cer']:.0%}\n    GT  : {r['gt_n']}\n    PRED: {r['pred_n']}")


if __name__ == "__main__":
    main()
