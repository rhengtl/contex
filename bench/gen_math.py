"""Render LaTeX formulas with known ground truth, at several image qualities."""
import os, json, random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageFilter
import numpy as np

OUT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(OUT, "img_math"); os.makedirs(IMG, exist_ok=True)

FORMULAS = [
 r"E = mc^2",
 r"a^2 + b^2 = c^2",
 r"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}",
 r"\int_0^1 x^2 dx",
 r"\sum_{i=1}^{n} i^2",
 r"\alpha + \beta = \gamma",
 r"\lim_{x \to 0} \frac{\sin x}{x} = 1",
 r"f(x) = e^{-x^2}",
 r"\frac{\partial f}{\partial x}",
 r"\log_2(n)",
 r"P(A|B) = \frac{P(B|A) P(A)}{P(B)}",
 r"\sigma = \sqrt{\frac{1}{N} \sum_{i=1}^{N} (x_i - \mu)^2}",
 r"A \cup B \subseteq C",
 r"\frac{dy}{dx} = 3x^2 + 2x",
 r"\theta = \tan^{-1}\left(\frac{y}{x}\right)",
]

def render_latex(tex, fontsize=28, dpi=200):
    fig = plt.figure(figsize=(0.01, 0.01))
    fig.text(0, 0, f"${tex}$", fontsize=fontsize)
    buf = os.path.join(IMG, "_tmp.png")
    fig.savefig(buf, dpi=dpi, bbox_inches="tight", pad_inches=0.25,
                facecolor="white", transparent=False)
    plt.close(fig)
    return Image.open(buf).convert("L").copy()

def noise(im, s):
    a = np.asarray(im).astype(np.float32) + np.random.normal(0, s, np.asarray(im).shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def main():
    random.seed(3); np.random.seed(3)
    manifest = []
    def emit(cond, i, im, gt, ext="png", q=None):
        n = f"{cond}_{i:02d}.{ext}"
        im.convert("RGB").save(os.path.join(IMG, n), **({"quality": q} if q else {}))
        manifest.append({"file": n, "cond": cond, "gt": gt})

    for i, tex in enumerate(FORMULAS):
        hi = render_latex(tex)
        emit("clean", i, hi, tex)                                              # ideal crop
        emit("lowres", i, render_latex(tex, dpi=72), tex)                      # small screenshot
        emit("noisy", i, noise(hi, 20), tex)                                   # camera sensor noise
        emit("blur", i, hi.filter(ImageFilter.GaussianBlur(1.6)), tex)         # out of focus
        emit("photo", i, noise(hi.filter(ImageFilter.GaussianBlur(0.9)), 10), tex, "jpg", 55)

    os.remove(os.path.join(IMG, "_tmp.png"))
    json.dump(manifest, open(os.path.join(OUT, "manifest_math.json"), "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)
    print(f"generated {len(manifest)} formula images ({len(FORMULAS)} formulas x "
          f"{len(set(m['cond'] for m in manifest))} conditions)")


if __name__ == "__main__":
    main()
