# ConTeX conversion pipeline

One upload — image, PDF, Word document, photo or handwriting on a canvas —
becomes one `.tex` file. The user never chooses a converter; there is one
conversion feature, and which engine reads a page is an implementation detail.

```
accept terms ─▶ provide input ─▶ check AI availability ─▶ convert ─▶ .tex
                                          │                            │
                                 available│  unavailable               ├─▶ download
                                          │      │                     ├─▶ copy
                                          │      └─▶ warn the user,    └─▶ PDF preview
                                          │          they choose
                                          ▼
                              ┌───────────┴────────────┐
                              │                        │
                      AI reads the page        Tesseract + pix2text
                      and writes LaTeX         merged by position
                          (normal)                 (fallback)
```

Word documents take neither path: a `.docx` already knows its own headings,
cells and words, so it is read structurally by `docx_input.py` and only its
LaTeX form is decided — by the model when available, deterministically when not.

**Why AI-first.** Measured on the same corpus with the same model, against the
older arrangement where the local converters produced a draft and the model
reviewed it:

| page corpus, 8 pages | converters + review | AI-first |
|---|---|---|
| text | 98.78% | 97.52% |
| structure | 95.83% | **100.00%** |
| math | 95.47% | **99.81%** |
| wall clock | 309.8s | **145.8s** |

| isolated formulas, 8 | pix2text alone | pix2text + review | AI-first |
|---|---|---|---|
| math | 86.39% | 93.06% | **100.00%** |

The specialist formula model does not win on formula transcription, and the
elaborate text/maths merge does not beat the model reading the page directly.
Handing the model a mediocre draft appears to *anchor* it.

**Why the converters stay.** The AI path can fail, and on a free tier it does:
free-tier daily quota runs out in ordinary use. When that happens the converter
path still produces a usable document. Set `AI_FIRST=false` to force it.

---

## Falling back is never silent

A user who is about to get a materially worse document is told before it
happens, not after.

**Before processing** (`ai_status.check()`, called by `/api/ai-status` and again
inside `convert()`): configuration is checked, plus a remembered record of the
last real failure. If the AI cannot be used, the page shows which service is
down, what a fallback would cost in quality, whether recovery time is known —
and offers *Continue without AI* / *Cancel and wait* / *Check again*. Cancelling
means nothing is converted. `convert()` raises `FallbackNotAuthorized` if a POST
arrives without that agreement, so the gate is not merely a dialog.

**Quota failures rotate models before they ever reach the user.** The role has
an ordered chain, and a model returning a 429 says nothing about the next one —
free-tier quota is spent one model at a time:

| role | chain, best first |
|---|---|
| `document` | `gemini-3.1-flash-lite` → `gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-3.7-flash` |

### Rounds

One conversion is one **round**, however many pages it has (`ai_qa.Rotation`).

- The round **opens on the role's preferred model** — the first entry of its
  chain.
- If that model reports itself out of quota, the round **advances and stays
  there** for the remaining pages, rather than re-probing an exhausted model
  once per page. A ten-page PDF pays for that discovery once, not ten times.
- When the chain runs out the round is `exhausted`; `convert.py` sees that,
  **stops calling the API, and finishes the document with the local
  converters**. The conversion always completes — the user gets a finished
  `.tex`, never an error.
- **The next conversion is a new round and opens on the preferred model
  again.** Deliberate: free-tier quota returns without warning, and nothing
  should keep a user on the fourth-choice model because the first was busy an
  hour ago.

The one exception to re-trying the preferred model is a window the *provider
itself* stated (`ai_status.hard_blocked`). Calling before a stated retry time
wastes a round trip and on some limits extends the block, so its instruction
beats our optimism. A model parked only by our own 900-second guess is always
re-tried — but with its retry budget cut to a single attempt, so confirming a
model is still out costs one quick call instead of three with backoff.

So there are **two levels of fallback**, and the user only ever hears about the
second: model → model happens silently and costs nothing but a retry; AI → local
converters is the one that degrades quality, and that is the one that gets a
warning and a choice. Before this existed, an exhausted primary took the whole
AI path down and every user dropped to Tesseract until someone edited `.env` by
hand — which is exactly what happened on 2026-08-23. **No hand edit switches a
model any more, during a conversion or between them.**

A rejected API key does *not* rotate: it dooms every model, so trying three more
would spend the user's time reaching the same answer. Anthropic does not rotate
either — no free tier, so its 429s are short per-minute limits that clear on
their own, and rotating to Opus would raise the bill 2.5× to solve a problem
waiting solves for free.

**The availability check costs no quota.** It deliberately does not probe the
API: on a free tier a pre-flight probe consumes exactly the quota that runs out,
so it would cause the outage it is meant to detect. The cost of that choice is
staleness, so every remembered outage expires two ways — at the retry time
the provider itself supplied, and otherwise after `AI_OUTAGE_ASSUME_SECONDS`
(default 900). A successful call clears that model's record immediately. The app
cannot get stuck on the fallback, or on a worse model, after recovery.

**Recovery times are never invented.** One is shown only when the provider
supplied one, parsed from `google.rpc.RetryInfo` in the error body. A *daily*
quota is excluded even when a retry delay comes with it: that delay says when to
retry the request, not when the day's allowance resets, and the API does not
publish the reset schedule. In every other case the UI says, in those words,
*"No estimated recovery time is currently available."*

**Mid-conversion failure keeps what was finished.** This is why a PDF is sent to
the model one page at a time rather than whole. If quota runs out on page 7 of
10, pages 1–6 keep their AI output, pages 7–10 are converted locally, the two
halves are spliced into one document by `latex_tools.merge_documents()`, and the
result says exactly where the change happened and what it costs. It buys that
guarantee with one API call per page instead of one per document.

---

Two rules shape the whole design.

**The AI is an enhancement, never a gate.** No API key, dead network, exhausted
free-tier quota, unparseable reply — every failure path falls back to the local
converters, with a note saying why. A user never loses a conversion because the
model was unavailable.

**Source fidelity outranks tidiness.** For mathematics especially, the model is
told to treat the page as evidence and to leave unusual-but-valid expressions
alone. "This looks odd" is not grounds for a change; "the image clearly shows
something else" is.

---

## Handwriting and print

The converter handles four kinds of content, in any combination on one page:

| | handwritten | typewritten |
|---|---|---|
| **prose** | Tesseract fails → the model transcribes | Tesseract, near-perfect |
| **equations** | pix2text-mfr | pix2text-mfr |

**Tesseract is 95.4% word-error-rate on handwriting** — the worst of nine tools
in an independent 2026 benchmark, because it pattern-matches shapes designed for
print. Nothing tunes that away. Vision models sit at 11–14% WER on the same
task, so on a handwritten line the model is not polishing an OCR result, it
*is* the transcriber. The prompt says so explicitly.

**pix2text-mfr reads handwritten mathematics as well as printed.** Measured on
`bench/img_mixed`: hand-lettered `E = mc²`, `a² + b² = c²`,
`s = ut + ½at²` and `E_k = ½mv²` all came back exactly right with no AI
involvement. No change was needed there.

### Three failures this exposed, and their fixes

Building the mixed corpus broke the pipeline in three ways that the printed
corpus never could:

**A handwritten line vanished from the output.** Tesseract returned *nothing at
all* for "This idea changed how physics was understood." — so the region looked
like unread ink, was nominated as an equation, came back as `\mathrm` letter
soup, was rejected as prose, and was discarded. Silent content loss. Now a
rejected region that no text engine read is *salvaged*: the letter soup is
unwrapped back into words (`layout.unwrap_text`) and kept, flagged uncertain.
Rough — "phigsics" for "physics" — but present rather than silently lost.

**Printed equations were missed.** `E = mc²` in a serif font is ordinary glyphs,
so Tesseract reads it happily at confidence 80 and the confidence discriminator
never fires. Position is the signal that remains: displayed mathematics is
centred, prose and table rows start at the left margin. `layout.is_centred`
now nominates a confidently-read but centred non-prose line.

**Centring was measured on the wrong box.** When the segmenter merges a caption
with the formula beneath it, the carved remainder keeps the *band's* full width,
hiding that the formula inside is centred. Centring is now judged on the words
Tesseract found, not on the region.

### Uncertain lines are counted

On the fallback path, any line no engine read confidently is marked
`uncertain` by `layout.py` and counted into `summary['uncertain_lines']`. It is
the honest measure of how much of a fallback conversion is guesswork.

The model is told **not** to mark handwriting up differently. A handwritten
sentence and a printed one both become ordinary LaTeX prose; a handwritten
formula and a printed one both become ordinary LaTeX mathematics. What the page
was written with changes how carefully the model must read, not how the result
is typeset.

### Limits

The corpus uses handwriting *fonts* (Segoe Script, Ink Free), not real pen
strokes. That tests routing, segmentation and ordering honestly, but a font
never runs two letters together the way a hand does, so these are not
handwriting-accuracy figures — treat the 11–14% WER benchmark range as the
realistic expectation instead. Without an API key, handwritten prose degrades to
the rough salvaged text rather than failing, and handwritten mathematics is
unaffected.

---

## The unified pipeline

`convert.py` orchestrates; `layout.py` decides. Neither converter knows the
other exists.

**Tesseract runs first, on purpose.** Its confidence map is better information
than the segmenter has alone, so pix2text — the slow component — only sees the
handful of regions that look like formulas rather than every ink block on the
page. Sending it prose is what produced runs of `\qquad`.

**The merge is by position, not by text matching.** Both engines report boxes in
the same coordinate space (the preprocessed page), so an equation displaces
exactly the lines it overlaps. That is also the deduplication mechanism: the
garbled prose Tesseract produced for a formula region is removed by construction,
not by fuzzy matching.

Three refinements, each forced by a measured failure:

| Problem | Fix |
|---|---|
| A caption and the formula under it merge into one band, and the caption is lost | Carve prose spans out of a region before nominating what is left |
| An equation number `(1)` is read confidently and splits the formula into slivers — took a page from 2 equations to 0 | Only *prose* (three or more real words) may carve |
| Tesseract reports **nothing at all** for a displayed derivative, so there is no low-confidence line to trigger nomination | Unread ink nominates as loudly as misread ink |

Then a last line of defence: pix2text returns prose as spaced letters inside
`\mathrm`, so a result with no relation, operator or script is discarded and the
text engine's reading of that region stands.

Live, on `mixed_hi.png`: the merge deliberately left `Einstein's mass-energy
relation is E = mc?...` as text, because it is a sentence with inline
mathematics rather than a displayed formula.

### An honest limitation

On this corpus — machine-rendered, perfectly clean LaTeX pages — a capable model
rebuilds structure and mathematics from the image alone, which is why the AI
path does not need the merge at all. The merge earns its place on the path that
has no model:

| without any AI | unified | text-only |
|---|---|---|
| text | **78.69%** | 70.62% |
| structure | **61.98%** | 0.00% |
| math | **13.40%** | 0.00% |

That is the path that runs whenever the free tier is rate-limited or exhausted,
which is a normal operating condition here — so it matters. The unified pipeline
also handles pages that mix prose and formulas in one pass, which neither
converter did before.

---

## The fallback: text half (Tesseract)

Tesseract reads the document and `generate_tex_source()` wraps the text in a
minimal LaTeX document. On the fallback path that draft is the result; it is
what the merge in `layout.py` builds on:


---

## The fallback: mathematics half (pix2text)

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
which is why that judgement belongs to the AI path, not to a guess here.

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


---

## Privacy

> **On Gemini's free tier, Google uses submitted documents to train its models.**

The model reads the document itself, so on the normal path the upload leaves
this server. `templates/partials/qa_notice.html`, shown above the upload
control, says so plainly: the document is sent to the provider, and the
*fallback* is the only path on which nothing leaves the machine.

To replace the training warning with a quieter notice, enable billing on the
Google Cloud project (paid-tier inputs are not used for training) and set
`GEMINI_PAID_TIER=true`. The document still leaves the server, and the notice
still says so. To keep everything local, set `AI_QA_ENABLED=false` or
`AI_FIRST=false`; users are then warned and asked to confirm before each
conversion.

**Terms of Service and Privacy Policy.** Nothing can be uploaded, captured,
drawn or converted until the agreement checkbox is ticked; `convert_route()`
re-checks the session on every POST, so the disabled fieldset is a courtesy
rather than the enforcement. Both documents open in an in-app modal fetched from
`/legal/<doc>`. Signed-in users' acceptance is stored on their Firestore profile
(`termsAcceptedVersion`) so they are not asked again; guests accept once per
session. Bumping `TERMS_VERSION` asks everyone again.

> **The shipped legal documents are complete, but unreviewed.** They were
> written from the source code, for a specific set of facts: an individual
> operator, Philippine governing law, a worldwide audience (so RA 10173, GDPR
> and CCPA), a minimum age of 16, and deletion carried out by hand within 30
> days of an emailed request. They have **not been reviewed by a lawyer** and
> make no claim of compliance. See *What a lawyer should still look at* below.

Everything else:

- **API keys never reach the browser** — read from the environment inside the
  Flask process; no template, response or log contains them. `/api/ai-status`
  reports service names and model ids only.
- **Uploads are held in memory** for the conversion and never written to the
  upload folder.
- **Results are session-scoped** — each gets an unguessable token tied to the
  requesting session; `/download-converted-tex` and `/preview.pdf` serve only
  the session that owns the token, and both the `.tex` and its compiled PDF
  expire after an hour.
- **History is scoped by uid** — `/history/<id>/...` re-checks ownership
  server-side, so a document id alone is not enough to read someone else's
  conversion.
- **Guest/authenticated behaviour is unchanged** — conversion is open to guests;
  signing in only adds persistent Firestore history.

---

## Cost

One call per page, plus at most one repair — `AI_QA_MAX_API_CALLS` caps it at
3. Typical usage on the live API was ~1,700 input / ~900 output tokens for a
page of prose. Rate limits
are retried with backoff (`AI_QA_RETRY_ATTEMPTS`); an exhausted quota rotates
to the next model in the role's chain; and only an exhausted *chain* degrades to
the converter's own output rather than failing.

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

`bench/score_qa.py` scores the shipped pipeline against ground truth. Three
metrics, since character accuracy alone would punish `\dfrac` for `\frac` as
hard as a wrong exponent:

- **text** — character accuracy of the prose, markup stripped
- **structure** — how many of the source's sections/lists/tables/display-math
  elements survive
- **compiles** — whether the `.tex` actually builds

The baseline it establishes for Tesseract alone on the rendered-page corpus:
**78% text, 0% structure, 0% maths.** Structure and mathematics are precisely
what the fallback cannot recover, and why it is the fallback.

```powershell
cd bench
..\.venv\Scripts\python.exe gen_pages.py       # build the corpus
..\.venv\Scripts\python.exe score_qa.py --mock # check the harness, no API calls
..\.venv\Scripts\python.exe score_qa.py        # the shipped AI pipeline
..\.venv\Scripts\python.exe score_qa.py --corpus mixed
```

A rendered LaTeX page is the easiest input these converters will ever see. Before
trusting any conclusion, add 20–30 of your own pages to `img_pages/` with a
hand-written `gt_tex` in `manifest_pages.json`.

---

## Setup

Every command below runs from the project root, `d:\Projects\Context_App`.

### 1. Install dependencies

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Two system binaries are optional but wanted:

| Binary | Needed for | Without it |
|---|---|---|
| A LaTeX engine (MiKTeX / TeX Live) | PDF preview, compile check | `.tex` still downloads and copies; the preview shows a clear message |
| Poppler (`pdftoppm` on PATH) | rasterising PDFs for the **fallback** | PDFs still convert on the AI path; the fallback reports the missing binary |
| Tesseract | the fallback's text half | the AI path is unaffected |

### 2. API key

Set `GEMINI_API_KEY` in `.env` (gitignored). Get a free key at
<https://aistudio.google.com/apikey>. Without one the app still runs: every
conversion warns the user and offers the local fallback.

### 3. Run

```powershell
.venv\Scripts\python.exe app.py
```

Then open <http://127.0.0.1:5000/>.

### 4. Verify

```powershell
.venv\Scripts\python.exe test_ai_qa.py    # 127 offline checks, no API key needed
```

---

## Manual setup still required

These cannot be done from the code and are **not** done:

1. **Monitor the published contact address.** The Privacy Policy commits to
   actioning access, correction, portability and deletion requests within
   **30 days**, by hand, via the Firebase console. There is no self-service
   delete or export in the app. That promise is only true if someone reads
   `rheniergustilo06@gmail.com`.
2. **Firebase service account.** `FIREBASE_SERVICE_ACCOUNT_PATH` must point at a
   real admin SDK JSON, and the web keys must match the project.
3. **Paid tier, if the free-tier training clause is unacceptable.** Enable
   billing on the Google Cloud project and set `GEMINI_PAID_TIER=true`. The
   pre-upload notice changes automatically.

Already done: the Firestore composite index (`uid` ASC + `timestamp` DESC) is
deployed. Redeploy after changing `firestore.indexes.json` with
`firebase deploy --only firestore:indexes --project <project-id>` — note the
`--only` list is comma-separated, so a trailing comma makes the CLI reject the
whole command.

---

## What a lawyer should still look at

The documents are complete and internally consistent, and every factual claim
in them was taken from the code. These are the parts where being *accurate* is
not the same as being *enforceable*, and where a Philippine lawyer's view is
worth having:

1. **The operator is identified by project name only.** This was a deliberate
   choice, made knowing the trade-off: RA 10173 expects the Personal Information
   Controller to be identifiable, and GDPR Art. 13(1)(a) requires the
   controller's identity. A named individual would be a stronger position. If
   the project ever stops being a personal one, this is the first thing to fix.
2. **Warranty disclaimer and liability cap** (Terms §10–11). The PHP 1,000 cap
   is a number chosen to be nominal for a free service, not one derived from
   anything. Whether a court would uphold it, and how Civil Code Arts. 1170 and
   2176 and the Consumer Act (RA 7394) constrain it, is a legal question.
3. **The free-tier training clause.** Under GDPR this is the weakest point:
   Google's use of free-tier input to train its models is processing we disclose
   but cannot control, retract or undo. The app warns before upload and the
   policy says so plainly, but whether notice alone is a sufficient basis for an
   EEA data subject's content is exactly the question to ask a lawyer. Setting
   `GEMINI_PAID_TIER` (with billing enabled) removes the issue entirely.
4. **International transfers** (Privacy §6). ConTeX relies on Google's standard
   terms and has signed no transfer agreement of its own.
5. **A worldwide audience is a lot of regimes.** The policy addresses RA 10173,
   GDPR and CCPA. It does not address PIPEDA, LGPD, PIPL or others. Restricting
   the audience is cheaper than covering everything.
6. **Breach notification.** Privacy §11 commits to the DPA's 72-hour NPC
   notification. There is no monitoring or breach-detection capability in the
   app, so meeting it depends entirely on the operator noticing.

---

## Which model converts, and why

The preference heads an automatic fallback chain (see *Falling back is never
silent* above) — the table below is what the role reaches for first, not the
only model it will ever use.

| Role | Prefers | Thinking | The job |
|---|---|---|---|
| `document` | `gemini-3.1-flash-lite` | `low` | Whole page in, whole document out |

**Converting a page is reading-dominant.** It fails by not noticing a dropped
line - a reading failure, not a reasoning one. So it runs on the model with the
best *measured* full-page reading among free-tier options: on socOCRbench (an
independent benchmark of 280 document images scoring edit similarity, chrF and
table structure) `gemini-3.1-flash-lite` scores **0.6214**, statistically tied
with the best free-tier model and ahead of `gemini-3.5-flash` at 0.6096. It is
also the cheapest of them if billing is ever enabled. This path carries the
larger payload, so the cheap model is on the expensive half.

### Why not `gemini-3.7-flash`

It was the first choice — newest, strongest Flash reasoner. Measuring it on a
real key killed it:

```
gemini-3.7-flash        0 consecutive calls accepted   (after a clean 75s idle)
gemini-3.6-flash       11 consecutive calls accepted
gemini-3.1-flash-lite  12 consecutive calls accepted
```

Its free-tier **daily** quota ran out after roughly a dozen calls, so most
equation conversions would silently fall back to unreviewed pix2text output.
`gemini-3.6-flash` costs the same on the paid tier ($0.75/$3.75), so this is not
a downgrade — and it is arguably the better model for this job anyway, because
checking a transcription against the image *is* an act of reading, and 3.6 has
the best measured free-tier reading of the lot (socOCRbench 0.6225).

On the same test page, given a formula pix2text had mangled into prose:

| Model | Verdict |
|---|---|
| `gemini-3.7-flash` | reported it under `missing:` |
| `gemini-3.6-flash` | **recovered it** — `F(\omega) = \int_{-\infty}^{\infty} f(t)e^{-i\omega t}\,dt` |

The lesson generalises: newer is not a substitute for measured. `bench/score_qa.py`
scores a corpus per model, so the assignment stays testable rather than assumed:

```powershell
.venv\Scripts\python.exe bench\score_qa.py --corpus math --limit 4
.venv\Scripts\python.exe bench\score_qa.py --corpus math --limit 4 --model gemini-3.1-flash-lite
```

**Claude** is the opt-in alternative, `claude-sonnet-5`.
Sonnet rather than Opus 5 because this is proofreading and Opus costs 2.5x for
it, with the same vision and 1M context. The reason to reach for this provider
is not quality but data handling: Anthropic does not train on API input, so it
is the path for documents that must not go to a free tier.

---

## Configuration

Defaults shown; full list in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Provider credentials. Server-side only. |
| `AI_QA_ENABLED` | `true` | `false` turns the AI off; users are warned and offered the fallback. |
| `AI_FIRST` | `true` | `false` pins every conversion to the local path (still warned). |
| `AI_OUTAGE_ASSUME_SECONDS` | `900` | How long a per-model outage with no provider retry time is assumed to last. |
| `TERMS_VERSION` | `2026-08-24-draft` | Bump to make every user re-accept. |
| `GEMINI_PAID_TIER` | `false` | `true` replaces the training warning with a quieter notice. |
| `AI_QA_PROVIDER` | `gemini` | `gemini` or `anthropic`. |
| `AI_QA_MODEL_DOCUMENT` | `gemini-3.1-flash-lite` | *Preferred* model for reading documents. The built-in chain still stands behind it; a comma-separated list sets your own order. |
| `AI_QA_MODEL` | — | Preferred model for every role. |
| `AI_QA_THINKING_DOCUMENT` | `low` | `low`/`medium`/`high`/`off`. |
| `AI_QA_THINKING` | — | Set to apply one level to every role. |
| `AI_QA_MAX_API_CALLS` | `3` | Per conversion unit: one pass plus one repair. |
| `AI_QA_MAX_PDF_PAGES` | `10` | Pages of a PDF sent to the model. |
| `AI_QA_RETRY_ATTEMPTS` | `3` | Retries on a 429 or an upstream 5xx. |
| `AI_QA_ENABLE_COMPILE` | `true` | Compile the result and repair once. |
| `EQUATION_MAX_REGIONS` | `12` | Most equations detected on one page (fallback). |
| `OCR_PREPROCESS` | `true` | Deskew / EXIF / upscale / alpha flatten. |
| `TEX_STORE_TTL_SECONDS` | `3600` | How long a `.tex` and its PDF preview stay available. |

---

## Files

| File | Role |
|---|---|
| `convert.py` | The one orchestrator: input type, AI path, fallback, merge. |
| `ai_status.py` | Is the AI usable? Per-model outage memory, provider-supplied recovery. |
| `docx_input.py` | Word documents read structurally — never OCR'd. |
| `layout.py` | Text-vs-maths nomination, position merge, LaTeX assembly. |
| `ai_qa.py` | Prompts, parsing, validation, per-page and merged conversion. |
| `llm_providers.py` | Provider adapter — Gemini and Claude behind one interface. |
| `equation.py` | pix2text wrapper, page segmentation (fallback only). |
| `textract_fast.py` | Tesseract OCR, preprocessing, LaTeX escaping (fallback only). |
| `latex_tools.py` | Offline validation, compilation, per-page document merge. |
| `preprocess.py` | EXIF rotation, deskew, low-DPI upscale, alpha flatten. |
| `tex_store.py` | Token-addressed, TTL-expiring store for results and previews. |
| `app.py` | The conversion route, terms gate, status API, preview, history. |
| `templates/legal/terms.html` | Terms of Service — complete, unreviewed. |
| `templates/legal/privacy.html` | Privacy Policy — complete, unreviewed. |
| `templates/partials/convert_section.html` | The single conversion UI. |
| `templates/partials/terms_gate.html` | The agreement checkbox. |
| `templates/partials/modals.html` | Legal, AI-outage, camera and canvas dialogs. |
| `templates/partials/qa_notice.html` | Pre-upload privacy disclosure. |
| `static/scripts.js` | Input plumbing, gate, camera, canvas, preview, history. |
| `bench/score_qa.py` | Before/after scoring for the conversion layer. |
| `test_ai_qa.py` | 127-check verification suite (no API key needed). |

---

## Known limitations

- **Free-tier daily limits are unpublished.** Google removed the rate-limit
  table; check <https://aistudio.google.com/rate-limit>. A 429 is retried with
  backoff, then rotates to the next model in the chain, and only degrades to
  the converter's output when every model is exhausted. Because the limits are
  unpublished, there is no way to know in advance how much headroom the chain
  actually buys — it is measured only by hitting it.
- **The fallback chain lists four Gemini models.** If Google retires or renames
  one, that entry starts failing with a model-not-found error, which is skipped
  (and parked for an hour) rather than being fatal — but it wastes one call the
  first time each hour. Prune `MODEL_CHAIN` in `llm_providers.py` when that
  happens.
- **Segmentation is vertical only.** On the fallback path, two equations side
  by side on one line are treated as one region.
- **The benchmark corpus is synthetic** — rendered LaTeX and handwriting
  *fonts*, no real handwriting, no camera captures, English only. Clean pages
  flatter the direct-to-AI path; on a phone photo of genuinely messy
  handwriting the gap to the fallback could narrow.
- **Word equations lose their layout.** Word stores mathematics as OMML, not
  LaTeX. `docx_input.py` extracts the symbols in reading order, but
  superscripts, fractions, roots and limits arrive flattened and have to be
  rebuilt from context. This is the least reliable part of `.docx` conversion
  on either path, and the result says so.
- **Per-page PDF conversion costs one API call per page.** That is the price of
  surviving a quota failure half way through a document.
- **A PDF preview needs a LaTeX engine.** Without one the `.tex` still
  downloads and copies; the preview panel shows a clear message instead.
- Do not rotate API keys to dodge rate limits: Google's limits are per project
  and multi-account rotation violates the terms of service.
