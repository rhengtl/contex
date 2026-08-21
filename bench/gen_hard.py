"""Harder, more realistic degradations: phone photos, poor scans, low DPI."""
import os, json, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

OUT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(OUT, "img_hard"); os.makedirs(IMG, exist_ok=True)

from gen_text import SENTENCES, FONTS, render  # reuse corpus + renderer


def main():
    random.seed(11); np.random.seed(11)
    manifest = []

    def noise(im, sigma):
        a = np.asarray(im).astype(np.float32) + np.random.normal(0, sigma, np.asarray(im).shape)
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

    def lighting(im, strength=90):
        """Uneven illumination: a diagonal shadow gradient like a hand-held photo."""
        a = np.asarray(im).astype(np.float32)
        h, w = a.shape
        yy, xx = np.mgrid[0:h, 0:w]
        grad = (xx / w * 0.7 + yy / h * 0.3)
        return Image.fromarray(np.clip(a - grad * strength + strength * 0.25, 0, 255).astype(np.uint8))

    def perspective(im, k=0.06):
        """Slight keystone, as when photographing a page at an angle."""
        w, h = im.size
        dx = w * k
        src = [(0, 0), (w, 0), (w, h), (0, h)]
        dst = [(dx, h * 0.03), (w - dx * 0.3, 0), (w, h), (dx * 0.5, h * 0.97)]
        # solve for the 8 perspective coefficients (dst -> src mapping PIL expects)
        A, B = [], []
        for (x, y), (u, v) in zip(dst, src):
            A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
            A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
        coef = np.linalg.solve(np.array(A, dtype=float), np.array(B, dtype=float))
        return im.transform((w, h), Image.PERSPECTIVE, coef, Image.BICUBIC, fillcolor=255)

    def speckle(im, p=0.04):
        a = np.asarray(im).copy()
        m = np.random.rand(*a.shape)
        a[m < p / 2] = 0; a[m > 1 - p / 2] = 255
        return Image.fromarray(a)

    def emit(cond, i, im, gt, ext="png", q=None):
        name = f"{cond}_{i:02d}.{ext}"
        im.convert("L").save(os.path.join(IMG, name), **({"quality": q} if q else {}))
        manifest.append({"file": name, "cond": cond, "gt": gt})

    for i, s in enumerate(SENTENCES):
        f = FONTS[i % len(FONTS)]
        base = render(s, f, 42)
        # 1. phone photo: perspective + uneven light + blur + noise + jpeg-ish downscale
        ph = perspective(base)
        ph = lighting(ph)
        ph = ph.filter(ImageFilter.GaussianBlur(1.1))
        ph = noise(ph, 12)
        ph = ph.resize((int(ph.width * 0.55), int(ph.height * 0.55)), Image.LANCZOS)
        emit("photo", i, ph, s, ext="jpg", q=60)
        # 2. very low DPI (~72dpi, 11px type) — the classic OCR killer
        emit("lowdpi", i, render(s, f, 11, pad=10), s)
        # 3. heavy defocus
        emit("blur", i, base.filter(ImageFilter.GaussianBlur(2.4)), s)
        # 4. degraded photocopy: speckle + contrast loss
        emit("photocopy", i, noise(speckle(render(s, f, 42, bg=225, fg=70)), 22), s)
        # 5. strongly rotated (10 deg) — user snapped the page crooked
        emit("skew10", i, base.rotate(10, expand=True, fillcolor=255), s)

    json.dump(manifest, open(os.path.join(OUT, "manifest_hard.json"), "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)
    print(f"generated {len(manifest)} hard images across {len(set(m['cond'] for m in manifest))} conditions")


if __name__ == "__main__":
    main()
