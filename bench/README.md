# OCR accuracy benchmark

ConTeX ships two OCR converters plus an AI review layer, and none had a way to
measure how well they work.
These scripts build a synthetic corpus with **exact ground truth**, run it through
the app's real code paths, and report error rates.

- `textract_fast.extract_text_from_file` — Tesseract, plain document text
- `equation.process_image` — `breezedeus/pix2text-mfr` (TrOCR + ONNX Runtime), LaTeX formulas
- `ai_qa.review_document` / `review_equations` — the AI review layer, scored by
  running each converter **twice**, before and after the review (see `score_qa.py`)

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

python gen_pages.py                       # 16 full pages with structural ground truth
python score_qa.py --mock                 # converter alone, no API calls
python score_qa.py                        # converter vs converter+review
python score_qa.py --mode equations       # the equation pipeline instead
python score_qa.py --provider anthropic   # compare reviewers on the same corpus
```

`gen_pages.py` needs a LaTeX engine and Poppler: it writes a `.tex` page, compiles
it and rasterises the PDF, so the ground truth *is* the source — which is the only
way to get exact structural ground truth without hand-annotating scans.

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

1. ~~**Rotated pages silently return an empty string.**~~ **Fixed.** At 10 degree skew
   Tesseract emitted nothing at the default PSM, so the user saw a blank result and no
   error; `--psm 1` did not help (OSD only detects 90 degree steps). The
   projection-profile deskew took this from 28.44% to **99.84%** char accuracy while
   leaving straight images untouched, and now lives in `preprocess.py`, applied by both
   `textract_fast.py` and the AI pipeline.
2. ~~**Low DPI is the other weak spot**~~ (87.52%, 0/10 exact). **Mitigated:**
   `preprocess.upscale_small()` enlarges small inputs before OCR.
3. ~~`textract_fast.py` hardcodes the Tesseract path.~~ **Fixed** - it now resolves
   `TESSERACT_CMD`, then `PATH`, then the usual install directories.


## What this does *not* measure

Every image is machine-rendered and degraded programmatically. There is **no
handwriting** (Tesseract cannot do it; pix2text-mfr is trained on printed formulas),
no real camera captures, and no language other than `eng`. Treat the clean-print
number as a ceiling and the degraded range as the realistic band.

This matters most for `score_qa.py`: a rendered LaTeX page is the *easiest* input the
converters will ever see. Before trusting a model choice, drop 20–30 of your own
pages — photographed lecture notes, a scanned problem set, handwriting — into
`img_pages/` with a hand-written `gt_tex` in `manifest_pages.json`. That number is
worth more than any published benchmark, because none of them measure LaTeX output
and yours does.
