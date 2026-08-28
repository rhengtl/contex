"""Run the app's Tesseract pipeline over a benchmark set and score CER/WER.

Usage:
    python score_text.py [manifest.json] [image_dir] [psm]

Defaults to the clean set at Tesseract's default page-segmentation mode, which is
what pytesseract.image_to_string() uses in tesseract.py.
"""
import os, json, subprocess, sys, re, shutil
from collections import defaultdict

BENCH = os.path.dirname(os.path.abspath(__file__))


def tesseract_path():
    """Resolve the tesseract binary: TESSERACT_CMD, then PATH, then common installs."""
    env = os.getenv("TESSERACT_CMD")
    if env and os.path.exists(env):
        return env
    found = shutil.which("tesseract")
    if found:
        return found
    for p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
              r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
              r"D:\Apps\Tesseract-OCR\tesseract.exe"):
        if os.path.exists(p):
            return p
    raise SystemExit("tesseract not found - set TESSERACT_CMD to its full path")


def lev(a, b):
    """Levenshtein distance over any two sequences (strings or token lists)."""
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def ocr(path, psm=None):
    cmd = [tesseract_path(), path, "stdout", "-l", "eng"] + (["--psm", str(psm)] if psm else [])
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout or ""


def main():
    mf = sys.argv[1] if len(sys.argv) > 1 else "manifest.json"
    img = os.path.join(BENCH, sys.argv[2] if len(sys.argv) > 2 else "img")
    psm = int(sys.argv[3]) if len(sys.argv) > 3 else None
    manifest = json.load(open(os.path.join(BENCH, mf), encoding="utf-8"))

    agg = defaultdict(lambda: {"ce": 0, "nc": 0, "we": 0, "nw": 0, "exact": 0, "n": 0})
    rows = []
    for m in manifest:
        gt = norm(m["gt"])
        hyp = norm(ocr(os.path.join(img, m["file"]), psm))
        ce, we = lev(gt, hyp), lev(gt.split(), hyp.split())
        a = agg[m["cond"]]
        a["ce"] += ce; a["nc"] += len(gt)
        a["we"] += we; a["nw"] += len(gt.split())
        a["exact"] += (gt == hyp); a["n"] += 1
        rows.append({**m, "hyp": hyp, "cer": ce / len(gt), "wer": we / len(gt.split())})

    def line(label, a):
        exact = "{}/{}".format(a["exact"], a["n"])
        return (f"{label:<14}{a['ce'] / a['nc']:>8.2%}{1 - a['ce'] / a['nc']:>10.2%}"
                f"{a['we'] / a['nw']:>8.2%}{exact:>10}")

    tot = defaultdict(int)
    print(f"\n=== Tesseract / eng / psm={psm or 'default (3) - as the app calls it'} ===")
    print(f"{'condition':<14}{'CER':>8}{'char acc':>10}{'WER':>8}{'exact':>10}")
    for cond in dict.fromkeys(m["cond"] for m in manifest):
        a = agg[cond]
        for k in a:
            tot[k] += a[k]
        print(line(cond, a))
    print("-" * 50)
    print(line("OVERALL", tot))

    out = os.path.join(BENCH, f"results_{os.path.splitext(mf)[0]}_psm{psm or 3}.json")
    json.dump(rows, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("\nworst samples:")
    for w in sorted(rows, key=lambda r: -r["cer"])[:4]:
        print(f"  [{w['cond']}] CER {w['cer']:.1%}\n    GT : {w['gt'][:88]}\n    OCR: {w['hyp'][:88]}")


if __name__ == "__main__":
    main()
