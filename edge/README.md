# ConTeX on Cloudflare — migration in progress

This directory is the Cloudflare rebuild of ConTeX. **The Python application in
the repository root remains the source of truth** and stays working until every
stage here has been validated against it. Nothing in `contex/` has been changed
or deleted.

Architecture and the evidence behind it: the specification, revision 1.3.

---

## Stage 1 — complete and verified

The Pages shell plus the secured streaming Worker: upload → Worker → Gemini →
`.tex` download, with the terms gate, rate limiting, session cookie and security
headers carried over.

### What maps to what

| Python (source of truth) | Edge | Notes |
|---|---|---|
| `web/convert.py` conversion half | `worker/index.js` `/api/convert/page` | Error strings copied verbatim |
| `convert.py` `ai_status_route()` | `worker/gemini.js` `aiStatus()` | Still never probes the API |
| `recognise/ai.py` `_DIRECT_SYSTEM` | `worker/prompt.js` | Copied character for character |
| `recognise/ai.py` `fenced_latex()` | `gemini.js` / `app.js` | Same last-document-block preference |
| `services/llm/gemini.py` `MODEL_CHAIN` | `worker/prompt.js` | Same four models, same order |
| `services/llm/gemini.py` `_config()` | `gemini.js` `generationConfig()` | temperature 0, 32000 tokens, thinking LOW |
| `services/llm/availability.py` | `gemini.js` outage helpers | File → KV; still **per model**, not per service |
| `web/session.py` cookie + terms | `worker/session.js` | itsdangerous → Web Crypto HMAC |
| `web/security.py` headers/CSP | `public/_headers` + `worker/security.js` | See the two notes below |
| `web/security.py` rate limiting | `worker/ratelimit.js` | Per-process deque → Durable Object |
| `pipeline/inputs.py` `ACCEPTED` | `public/app.js` `ACCEPTED` | Same list, same picker derivation |

### Three deliberate differences

**The model chain loop moved to the browser.** A streamed body cannot be
replayed, so the Worker cannot retry a different model within one invocation
without buffering — which S1 measured as breaching the CPU budget above ~8 MB.
The client re-posts with the next chain index instead. Order and outage
semantics are unchanged; only the location of the loop moved.

**The CSP lost its nonce, and is stronger for it.** The Flask templates carried
inline `<script>` blocks, so the policy needed a per-request nonce to avoid
`'unsafe-inline'`. This frontend has no inline script at all, so `'self'` alone
is stricter — there is nothing for a nonce to authorise. `'wasm-unsafe-eval'`
and `worker-src` are added for the LaTeX engine and the formula model; they
permit WebAssembly, not `eval()`.

**Rate limiting became global.** `security.py` is explicit that it counts inside
one process, so N gunicorn workers gave a caller N times the allowance. The
Durable Object makes the limit the limit.

### Verified

`node scratchpad/stage1-verify.mjs` — 18/18 against a running Worker:

- Terms gate blocks conversion with the original wording; `That file was empty.`
  likewise.
- Session cookie is signed, `HttpOnly`, `Secure`, `SameSite=Lax`.
- CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` present on
  static assets; no COOP/COEP, so the Firebase Auth popup still works.
- **Same benchmark image as the Python pipeline produced identical output** —
  same `\documentclass`, same package set, identical body between
  `\begin{document}` and `\end{document}`.

One real defect was found and fixed by that comparison: the first port omitted
`thinkingConfig`, and the model then emitted an extra `\usepackage{inputenc}`
the Python pipeline did not. Three control runs confirmed the Python side was
consistent, so this was a divergence rather than model noise. Matching
`gemini.py _config()` closed it.

### Not yet migrated

PDF preview and LaTeX validation (Stage 2), Firebase auth and history
(Stage 3), the local fallback and the full UI (Stage 4). Until those land, this
directory is not a replacement for the Python app.

---

## Running it

```bash
cd edge
npm install
# .dev.vars (gitignored):
#   GEMINI_API_KEY=...
#   SESSION_HMAC_KEY=...      # any long random value
npx wrangler dev --port 8788
```

Before a first deploy: create the KV namespace and put the real id in
`wrangler.toml`, then `wrangler secret put GEMINI_API_KEY` and
`wrangler secret put SESSION_HMAC_KEY`.

---

## Stage 2 — complete and verified

Generated `.tex` → browser validation → SwiftLaTeX/pdftex.wasm → curated TeX
Live 2020 tree → PDF → preview and download. No server touches any of it, and
the whole TeX tree is a static asset, so none of it is metered.

### What maps to what

| Python (source of truth) | Edge | Notes |
|---|---|---|
| `latex/validate.py` `static_validate()` | `public/latex/validate.js` | Direct port; identical issue strings |
| `latex/validate.py` `unsafe_constructs()` | same | One deliberate tightening, below |
| `latex/engine.py` `compile_tex()` | `public/latex/compile.js` | Same result shape, same refusal wording |
| `latex/engine.py` `extract_errors()` | same | Same `_ERROR_LINE` alternation |
| `latex/engine.py` `missing_packages()` | same | Same regex |
| `latex/engine.py` `LATEX_COMPILE_TIMEOUT` | same | 120 s, plus a 60 s engine-load bound |
| `web/output.py` preview + `data/results.py` page images | `public/preview.js` | **Deleted, not ported** — see below |
| `texlive-latex-extra` in the Dockerfile | `public/texmf/` | 2,383 files, 74 MiB, static |

### Verified — 199/199 checks

`npm run test:stage2` compiles **15 crafted failure fixtures + the 26 real
ConTeX benchmark outputs** and compares every result against the original
implementation's own output (`tools/python-reference.py`).

- Validation parity: `staticValidate` issue lists and `unsafeConstructs`
  results match validate.py exactly on all 41 documents.
- Compile parity: `ok` and `attempted` match engine.py on all 41.
- Every successful compile emits a real `%PDF-1.5`.
- `missing-package` reports exactly `['tikz']`; unsafe documents are refused
  with `attempted:false` before the engine runs.
- `undefined-command` surfaces `Undefined control sequence` in `errors`.
- Format file fetched once across 29 compiles.
- Sampled PDFs render through pdf.js with visible content.

### Benchmarks

| | Desktop | Pixel 7 viewport, 4x CPU throttle |
|---|---|---|
| Cold compile (engine + 9.9 MB format) | 291 ms | 311 ms |
| Warm compile | 34–39 ms | 38–41 ms |
| Large document (26 pages concatenated) | 79 ms | 85 ms |
| Network, cold | 12.31 MiB / 43 requests | same |

Corpus compile times: min 24 ms, median 33 ms, max 60 ms. PDFs average 0.891x
the size of the Python pipeline's for the same source — different font
embedding (cm-super vs the local MiKTeX), both valid.

Throttling is emulated, not a real handset; treat it as directional.

### Package and font coverage

The tree is the S3-measured set: TeX Live 2020 vintage, matching the format's
frozen `LaTeX2e <2020-02-02>` kernel. 32 unique files (10.56 MiB, of which
9.88 MiB is the format) are all a typical page actually fetches. T1 is intact —
`ecrm1000`, `sfrm1000.pfb`, `cm-super-t1.enc` resolve, and `amsmath`,
`graphicx`, `keyval`, `booktabs`, `siunitx`, `mathtools`, `geometry`,
`enumitem`, `xcolor`, `tabularx`, `multirow`, `ulem`, `amssymb`/`amsfonts` all
compile. `hyperref`, `tikz` and `cancel` are deliberately absent and degrade
through the missing-package path.

### Bugs found and fixed

1. **The engine hung forever on every compile.** `PdfTeXEngine.js` loads its
   worker from the relative path `swiftlatexpdftex.js`, which resolves against
   the *page* URL — a 404 from any route below the root, after which
   `loadEngine()` never settles. Patched to an absolute path.
2. **Nothing bounded the compile.** engine.py has `LATEX_COMPILE_TIMEOUT`; the
   port had no equivalent, which is why (1) presented as a hang rather than an
   error. Both the compile and the engine load are now bounded and report.
3. **Static hosting cannot speak the engine's package protocol.** Upstream
   expects a `fileid` header and HTTP 301 for a miss. Patched to derive the
   cache path from the request key and accept 404 — which keeps the whole tree
   on the free static path instead of the request meter.
4. **Extensionless font lookups.** kpathsea asks for `ecrm1000`, meaning
   `ecrm1000.tfm`. `tools/build-texmf.mjs` writes an extensionless alias for
   every `.tfm` (+753 files, 1.58 MiB).

### Deliberate differences

**`\openin` detection is stricter.** validate.py writes `\openin\b`, and `\b`
does not match between `n` and a digit — so `\openin1=secret.txt`, the ordinary
form, slips through. The Python app was covered anyway by engine.py's paranoid
kpathsea mode; pdftex.wasm has no equivalent, so the text check has to be the
half that works. **Worth back-porting to validate.py.**

**Page images are gone.** output.py rasterised the PDF with Poppler and served
page images, because a browser hands an `application/pdf` *response* to its own
viewer before the page can show it. That constraint does not apply to bytes we
already hold: pdf.js renders them to canvas directly, so the `texpng_` store in
data/results.py disappears rather than being ported.

**pdf.js is self-hosted** under `/vendor/pdfjs/`, because the CSP is
`script-src 'self'` and stays that way.

### Remaining risks for Stage 3

- Real low-end hardware is untested; only emulated throttling.
- The multi-page merge (`latex/documents.py`) is not ported yet — Stage 2
  compiles one document, and multi-page PDFs need it.
- The `.tex`/PDF are held in memory only; `sessionStorage` persistence and the
  guest-history contract arrive with Stage 3.
