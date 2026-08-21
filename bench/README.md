# OCR accuracy benchmark

ConTex ships two independent OCR pipelines and neither had a way to measure how well
it works. These scripts build a synthetic corpus with **exact ground truth**, run it
through the app's real code paths, and report character/word/token error rates.

- `textract_fast.extract_text_from_file` — Tesseract, plain document text
- `equation.process_image` — `breezedeus/pix2text-mfr` (TrOCR + ONNX Runtime), LaTeX formulas

## Running

```bash
pip install -r ../requirements.txt      # plus matplotlib, used to render formulas
python gen_text.py                      # 61 clean/typical text images
python gen_hard.py                      # 50 degraded text images
python gen_math.py                      # 75 formula images

python score_text.py                              # clean set, app's default PSM
python score_text.py manifest_hard.json img_hard  # degraded set
python score_text.py manifest_hard.json img_hard 1  # try another PSM
python score_math.py                              # formula set (loads the ONNX model)
python rescore_math.py                            # re-score, ignoring cosmetic LaTeX
python deskew_test.py                             # does deskewing fix rotated pages?
```

Tesseract is located via `TESSERACT_CMD`, then `PATH`, then the usual install
directories. Generated images, manifests and results are gitignored — regenerate them.

## Results (Tesseract 5.5, `eng`; pix2text-mfr on CPU)

Text, character accuracy = 1 − CER:

| Condition | Char acc | Exact lines |
|---|---|---|
| Clean print (hi/lo-res, noisy, JPEG, low-contrast, multi-line page) | 99.95% | 59/61 |
| Blurred / defocused | 99.84% | 9/10 |
| Phone photo (perspective + uneven light + noise) | 99.68% | 8/10 |
| Degraded photocopy | 95.42% | 1/10 |
| Very low DPI (~72dpi) | 87.52% | 0/10 |
| Skewed 10° | **28.44%** | 0/10 |

Formulas, scored after normalizing LaTeX that renders identically
(`\operatorname*{lim}` ≡ `\lim`, `\mathop{=}` ≡ `=`, font wrappers):

| Condition | Char acc | Token acc | Exact |
|---|---|---|---|
| Clean | 96.10% | 97.35% | 14/15 |
| Noisy | 96.10% | 97.35% | 14/15 |
| Blur | 95.45% | 97.35% | 14/15 |
| Photo | 99.68% | 99.47% | 14/15 |
| Low-res | 91.56% | 94.71% | 12/15 |
| **Overall** | **95.78%** | **97.25%** | **68/75 (91%)** |

Without that normalization the same predictions score 86.82% / 80% exact — most of
the apparent gap is markup style, not misread math. Throughput is ~0.32 s/formula on
CPU after a ~25 s model load at import.

## Findings

1. **Rotated pages silently return an empty string.** At 10° skew Tesseract emits
   nothing at the default PSM, so the user sees a blank result and no error. `--psm 1`
   does not help (OSD only detects 90° steps). The projection-profile deskew in
   `deskew_test.py` takes this from 28.44% → **99.84%** char accuracy, and leaves
   already-straight images untouched (it estimates 0.0°). Worth moving into
   `textract_fast.py` as a preprocessing step.
2. **Low DPI is the other weak spot** (87.52%, 0/10 exact). Upscaling small inputs
   before OCR is the standard mitigation.
3. `textract_fast.py` hardcodes `C:\Program Files\Tesseract-OCR\tesseract.exe`; on a
   machine that installed it elsewhere the whole `/textract` route fails with a string
   error. `score_text.tesseract_path()` shows the lookup order to use instead.

## What this does *not* measure

Every image is machine-rendered and degraded programmatically. There is **no
handwriting** (Tesseract cannot do it; pix2text-mfr is trained on printed formulas),
no real camera captures, and no language other than `eng`. Treat the clean-print
number as a ceiling and the degraded range as the realistic band.
