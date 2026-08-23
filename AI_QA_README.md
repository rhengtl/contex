# AI QA layer

ConTex has two OCR converters. Both still do their own conversion — **the AI
does no OCR**. It reviews what each converter produced, with the original
upload in front of it, and corrects what the source proves is wrong.

```
Textract:  image/PDF ──▶ Tesseract ──▶ .tex ──▶ AI review ──▶ final .tex
Equation:  image ──▶ pix2text ──▶ [eq 1, eq 2, eq 3] ──▶ AI review ──▶ ordered,
                                                                      grouped .tex
```

Two rules shape the whole design.

**QA is an enhancement, never a gate.** No API key, dead network, exhausted
free-tier quota, unparseable reply — every failure path returns the converter's
own output with a note saying why the review did not happen. A user never loses
a conversion because a review failed.

**Source fidelity outranks tidiness.** For equations especially, the reviewer is
told to treat the image as evidence and to leave unusual-but-valid mathematics
alone. "This looks odd" is not grounds for a change; "the image clearly shows
something else" is.

---

## Pipeline 1 — Textract

Tesseract reads the document and `generate_tex_source()` wraps the text in a
minimal LaTeX document, exactly as before. That draft then goes to the reviewer
together with the original upload, which is asked to check:

- Does the extracted text make sense, and does it say what the page says?
- Is the meaning and context preserved?
- Is the reading order right, and does each piece of text sit in the correct
  place relative to the rest?
- Is any content missing, duplicated, garbled, or invented?
- Does the LaTeX structure match the page (headings, lists, tables)?
- Are there obvious formatting or structural problems?

A clean review replies `LATEX_OK` and the OCR output is returned untouched.
Otherwise the reviewer returns findings plus a corrected document, which is then
validated and — if it does not build — given exactly one repair attempt.

### What this actually fixes

Measured on `bench/img_pages/headings_lo.png` with the live API. Tesseract
produced:

```
1 Introduction

measurements into meaning.        <- "Signal processing turns" was dropped
1.1 Motivation
...
\uFFFDThis note covers the transform      <- garbage character
The derivation proceeds in three steps,   <- comma instead of full stop
```

The reviewer restored the missing words, removed the garbage, fixed the
punctuation, and rebuilt the heading hierarchy as `\section` / `\subsection`.
The result compiles.

---

## Pipeline 2 — Equation

pix2text-mfr recognises *a* formula; it does not find formulas on a page. So the
converter now segments the page first and recognises each region separately,
producing an **ordered list**:

```
1. v = u + at
2. s = ut + \frac{1}{2}at^{2}
3. v^{2} = u^{2} + 2as
```

It deliberately stops there. Working out whether those are three independent
results or one derivation — and how to lay them out — needs the original image,
so that judgement belongs to the review stage, not to a guess in the converter.

### Segmentation

Horizontal ink bands, merged on a gap threshold derived from the median band
height. Measured on rendered pages: the gaps *inside* a fraction (numerator,
bar, denominator) are 1–3 px while the gaps *between* equations are 16–18 px
against a median band height of 28, so `0.35 × median` separates them cleanly.
Verified on six cases — plain equations, fractions, nested fractions, and mixed
pages — all correct.

Each region is then cropped **tightly around its ink, horizontally as well as
vertically**. This matters more than it sounds: given a full-width strip of
mostly blank page, pix2text emitted hundreds of `\qquad` tokens instead of the
expression. With tight crops the same page went from

```
1. \varphi = u + a ^ { t }          <- wrong
2. \qquad \qquad \qquad ... \ 0 \ 0 <- total failure
3. v ^ { 2 } = u ^ { 2 } + 2 u s    <- "2us", wrong
```

to all three correct, before any AI involvement.

### The review

For each expression the reviewer runs two separate checks:

1. **Source fidelity** — does the transcription match the image? The image is
   the evidence, and this check outranks everything else.
2. **Mathematical sanity** — is it coherent, or does it show the signature of a
   recognition failure (a stray operator, unbalanced delimiters, digits fused
   into a variable, `\cdot` where the image shows a decimal point)?

Then, for the group: are they related? Does one follow from another? Does the
image indicate a relationship? What is the correct order? Should any of them be
grouped into one environment?

The reply is parsed into per-equation verdicts (all shown in the UI) plus a
final `.tex`. A key-per-line format is used rather than JSON because every value
is LaTeX, and backslash-heavy strings are exactly what models escape incorrectly
inside JSON — one bad escape would cost the whole review.

On the live API, the three equations above were identified as "the standard
kinematic equations of motion", ordering confirmed, and grouped into a single
`align*` environment.

---

## Privacy

> **On Gemini's free tier, Google uses submitted documents to train its models.**

The OCR itself runs entirely on this server; only the *review* leaves the
machine. The app says so **above both upload controls**, before the user picks a
file, and points out that turning the review off keeps both converters working.

To remove the disclosure, enable billing on the Google Cloud project (paid-tier
inputs are not used for training) and set `GEMINI_PAID_TIER=true`. To disable
the review entirely, set `AI_QA_ENABLED=false`.

Everything else:

- **API keys never reach the browser** — read from the environment inside the
  Flask process; no template, response or log contains them.
- **Uploads are deleted** after Tesseract runs, in a `finally` block, and are
  saved under a server-generated name so a crafted filename cannot escape the
  upload folder.
- **Results are session-scoped** — each gets an unguessable token tied to the
  requesting session; `/download-tex` and `/download-equation-tex` serve only
  the session that owns the token, and everything expires after an hour.
- **Guest/authenticated behaviour is unchanged** — both converters are open to
  guests; signing in only adds persistent Firestore history.

---

## Cost

One review per conversion, plus at most one repair — `AI_QA_MAX_API_CALLS`
caps it at 3. Typical usage on the live API was ~1,700 input / ~900 output
tokens for a page of prose and ~1,900 / ~1,000 for three equations. Rate limits
are retried with backoff (`AI_QA_RETRY_ATTEMPTS`), and an exhausted quota
degrades to the converter's own output rather than failing.

---

## Preprocessing

`preprocess.py` conditions every page before any engine sees it — EXIF rotation,
projection-profile deskew, low-DPI upscale. No API calls, no model time. From
`bench/README.md`, on the 10° skew set:

    Tesseract char accuracy   28.44%  →  99.84%   after deskew

Before this, a rotated page made Tesseract return an empty string, so the user
saw a blank result and no error at all. Straight pages are detected (0.0°) and
left untouched; estimation runs on a downscaled copy, about 0.05 s per page.
Disable with `OCR_PREPROCESS=false`.

---

## Measuring it

`bench/score_qa.py` runs each converter **twice — before and after the review**,
because the only question that matters is whether reviewing helps. Three metrics,
since character accuracy alone would punish `\dfrac` for `\frac` as hard as a
wrong exponent:

- **text** — character accuracy of the prose, markup stripped
- **structure** — how many of the source's sections/lists/tables/display-math
  elements survive
- **compiles** — whether the `.tex` actually builds

The baseline it establishes for Tesseract alone on the rendered-page corpus:
**78% text, 0% structure, 0% maths.** Structure and mathematics are precisely
what the review layer exists to recover.

```powershell
cd bench
..\.venv\Scripts\python.exe gen_pages.py       # build the corpus
..\.venv\Scripts\python.exe score_qa.py --mock # converter alone, no API calls
..\.venv\Scripts\python.exe score_qa.py        # before vs after the review
..\.venv\Scripts\python.exe score_qa.py --mode equations
```

A rendered LaTeX page is the easiest input these converters will ever see. Before
trusting any conclusion, add 20–30 of your own pages to `img_pages/` with a
hand-written `gt_tex` in `manifest_pages.json`.

---

## Setup

### 1. Install dependencies

From the project root (`d:\Projects\Context_App`):

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. API key

Already configured in `.env` as `GEMINI_API_KEY`. To change it, get a free key
at <https://aistudio.google.com/apikey>. `.env` is gitignored.

### 3. Run

```powershell
.venv\Scripts\python.exe app.py
```

Then open <http://127.0.0.1:5000/>.

### 4. Verify

```powershell
.venv\Scripts\python.exe test_ai_qa.py    # 65 offline checks, no API key needed
```

---

## Configuration

Defaults shown; full list in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Reviewer credentials. Server-side only. |
| `AI_QA_ENABLED` | `true` | `false` turns the review off; converters keep working. |
| `GEMINI_PAID_TIER` | `false` | `true` removes the training disclosure. |
| `AI_QA_PROVIDER` | `gemini` | `gemini` or `anthropic`. |
| `AI_QA_MODEL` | `gemini-3.1-flash-lite` | Reviewer model. |
| `AI_QA_MAX_API_CALLS` | `3` | One review plus one repair. |
| `AI_QA_MAX_PDF_PAGES` | `10` | Pages shown to the reviewer. |
| `AI_QA_RETRY_ATTEMPTS` | `2` | Retries on a 429. |
| `AI_QA_ENABLE_COMPILE` | `true` | Compile the reviewed `.tex` and repair once. |
| `EQUATION_MAX_REGIONS` | `12` | Most equations detected on one page. |
| `OCR_PREPROCESS` | `true` | Deskew / EXIF / upscale. |
| `TEX_STORE_TTL_SECONDS` | `3600` | Result retention. |

---

## Files

| File | Role |
|---|---|
| `ai_qa.py` | The review layer: prompts, parsing, validation, fallbacks. |
| `llm_providers.py` | Provider adapter — Gemini and Claude behind one interface. |
| `equation.py` | pix2text wrapper, page segmentation, ordered-list output. |
| `textract_fast.py` | Tesseract OCR, preprocessing, LaTeX escaping. |
| `latex_tools.py` | Offline validation and compilation. |
| `preprocess.py` | EXIF rotation, deskew, low-DPI upscale. |
| `tex_store.py` | Token-addressed, TTL-expiring store for results. |
| `app.py` | Both converter routes and their downloads. |
| `templates/partials/qa_notice.html` | Pre-upload privacy disclosure. |
| `templates/partials/qa_report.html` | Shared QA report block. |
| `bench/score_qa.py` | Before/after scoring for the review layer. |
| `test_ai_qa.py` | 65-check verification suite (no API key needed). |

---

## Known limitations

- **Free-tier daily limits are unpublished.** Google removed the rate-limit
  table; check <https://aistudio.google.com/rate-limit>. A 429 is retried with
  backoff, then degrades to the converter's output.
- **Segmentation is vertical only.** Two equations side by side on one line are
  treated as one region. The reviewer usually notices and splits them, but the
  converter will not.
- **The benchmark corpus is synthetic** — no handwriting, no camera captures,
  English only.
- Do not rotate API keys to dodge rate limits: Google's limits are per project
  and multi-account rotation violates the terms of service.
