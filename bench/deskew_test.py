"""Does a projection-profile deskew recover the skew failures?"""
import os, json, subprocess, re
import numpy as np
from PIL import Image
from score_text import lev, norm, tesseract_path  # reuse metrics + binary lookup

BENCH = os.path.dirname(os.path.abspath(__file__))
OUTD = os.path.join(BENCH, "img_deskewed"); os.makedirs(OUTD, exist_ok=True)

def estimate_skew(im, limit=15.0, step=0.5):
    """Pick the rotation whose horizontal ink-projection profile is most peaked."""
    a = (np.asarray(im.convert("L")) < 128).astype(np.float32)
    best, best_score = 0.0, -1.0
    for ang in np.arange(-limit, limit + step, step):
        rot = np.asarray(Image.fromarray((a * 255).astype(np.uint8))
                         .rotate(ang, resample=Image.BILINEAR, fillcolor=0)) > 128
        prof = rot.sum(axis=1).astype(np.float32)
        score = ((prof[1:] - prof[:-1]) ** 2).sum()  # sharper line edges = better aligned
        if score > best_score:
            best, best_score = float(ang), score
    return best

def ocr(path):
    r = subprocess.run([tesseract_path(), path, "stdout", "-l", "eng"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout or ""

man = [m for m in json.load(open(os.path.join(BENCH, "manifest_hard.json"), encoding="utf-8"))
       if m["cond"] in ("skew10", "photo", "photocopy")]
agg = {}
for m in man:
    src = os.path.join(BENCH, "img_hard", m["file"])
    im = Image.open(src)
    ang = estimate_skew(im)
    fixed = im.convert("L").rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=255)
    dst = os.path.join(OUTD, m["file"].replace(".jpg", ".png"))
    fixed.save(dst)
    gt, hyp = norm(m["gt"]), norm(ocr(dst))
    d = agg.setdefault(m["cond"], {"ce": 0, "nc": 0, "ex": 0, "n": 0, "ang": []})
    d["ce"] += lev(gt, hyp); d["nc"] += len(gt); d["ex"] += (gt == hyp); d["n"] += 1
    d["ang"].append(round(ang, 1))

print(f"{'condition':<12}{'char acc AFTER deskew':>24}{'exact':>9}   est. angles")
for c, d in agg.items():
    print(f"{c:<12}{1 - d['ce']/d['nc']:>23.2%}{d['ex']}/{d['n']:<7}  {d['ang']}")
