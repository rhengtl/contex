"""Generate a synthetic OCR benchmark with exact ground truth."""
import os, json, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

OUT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(OUT, "img"); os.makedirs(IMG, exist_ok=True)
random.seed(7); np.random.seed(7)

SENTENCES = [
 "The quick brown fox jumps over the lazy dog.",
 "Invoice #48213 was issued on March 7, 2024 for $1,295.50.",
 "Please submit the completed form to registrar@university.edu.ph before 5:00 PM.",
 "Chapter 3: Methodology and Data Collection Procedures",
 "Respondents (n = 250) were selected using stratified random sampling.",
 "Contact numbers: +63 917 555 0123 or (02) 8123-4567.",
 "The correlation coefficient was 0.87, indicating a strong positive relationship.",
 "Section 12.4 - Limitations of the Study and Recommendations",
 "Temperature readings ranged from -3.5 C to 41.2 C across all sites.",
 "Approximately 68% of participants agreed with the proposed policy change.",
]

FONTS = ["C:/Windows/Fonts/times.ttf", "C:/Windows/Fonts/arial.ttf",
         "C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/georgia.ttf",
         "C:/Windows/Fonts/cour.ttf"]
FONTS = [f for f in FONTS if os.path.exists(f)]

def render(text, font_path, size, pad=30, bg=255, fg=0):
    font = ImageFont.truetype(font_path, size)
    tmp = Image.new("L", (10, 10), bg)
    w = ImageDraw.Draw(tmp).textbbox((0, 0), text, font=font)
    iw, ih = w[2] - w[0] + 2 * pad, w[3] - w[1] + 2 * pad
    im = Image.new("L", (iw, ih), bg)
    ImageDraw.Draw(im).text((pad - w[0], pad - w[1]), text, font=font, fill=fg)
    return im

def add_noise(im, sigma=18):
    a = np.asarray(im).astype(np.float32) + np.random.normal(0, sigma, np.asarray(im).shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def main():
    manifest = []

    def emit(cond, idx, im, gt, ext="png", quality=None):
        name = f"{cond}_{idx:02d}.{ext}"
        p = os.path.join(IMG, name)
        im.convert("L").save(p, quality=quality) if quality else im.convert("L").save(p)
        manifest.append({"file": name, "cond": cond, "gt": gt})

    for i, s in enumerate(SENTENCES):
        f = FONTS[i % len(FONTS)]
        # A. clean, high resolution (~300dpi equivalent, 42px type)
        emit("clean_hi", i, render(s, f, 42), s)
        # B. clean but low resolution (~150dpi, 20px type)
        emit("clean_lo", i, render(s, f, 20), s)
        # C. sensor/scan noise
        emit("noisy", i, add_noise(render(s, f, 42)), s)
        # D. skewed 3 degrees (phone photo of a page)
        emit("skew3", i, render(s, f, 42).rotate(3, expand=True, fillcolor=255), s)
        # E. low contrast (grey ink on grey paper) + slight blur
        emit("lowcontrast", i, render(s, f, 42, bg=205, fg=95).filter(ImageFilter.GaussianBlur(0.8)), s)
        # F. jpeg compression artifacts at moderate quality
        emit("jpeg", i, render(s, f, 42), s, ext="jpg", quality=35)

    # G. multi-line paragraph page (tests layout/psm handling)
    para = SENTENCES[:6]
    font = ImageFont.truetype(FONTS[0], 34)
    page = Image.new("L", (1400, 60 + 52 * len(para)), 255)
    d = ImageDraw.Draw(page)
    for j, line in enumerate(para):
        d.text((40, 30 + 52 * j), line, font=font, fill=0)
    emit("page", 0, page, "\n".join(para))

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)
    print(f"generated {len(manifest)} images across {len(set(m['cond'] for m in manifest))} conditions")


if __name__ == "__main__":
    main()
