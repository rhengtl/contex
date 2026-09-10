# Architecture

ConTeX turns a photographed or scanned page into LaTeX. This describes the
Cloudflare edge application, which is the only one deployed.

The engineering record of how it was built — stage by stage, with what each
suite verifies — is [`edge/README.md`](edge/README.md). This document is the
shape, not the history.

---

## The shape of it

```
  browser                          Cloudflare Worker            Google
  ───────                          ─────────────────            ──────
  page + client modules   ──────▶  /api/convert/page   ──────▶  Gemini
        │                          (owns the prompt)
        │                          /api/auth/*         ──────▶  Identity Toolkit
        │                          /api/history        ──────▶  Firestore
        │
        ├── pdfTeX (WASM) ─┐
        └── recognisers ───┴──────▶ static assets, served without the Worker
```

Two decisions explain most of the rest.

**The heavy work runs in the browser.** Compiling LaTeX and the offline
recognisers both run on the viewer's machine. There is no compile queue, no
server timeout, and no gigabyte TeX installation to host — and the offline path
sends nothing anywhere.

**Static assets never invoke the Worker.** `run_worker_first = false` means the
TeX tree, the engine and the model weights are served by the platform, free and
unmetered. The cost is that the Worker cannot add headers to them, which is why
`public/_headers` exists as a flat file.

## The Worker

| Module | Responsibility |
|---|---|
| `index.js` | the router, and the security headers on every response |
| `session.js` | the signed session cookie: who this is, terms acceptance |
| `accounts.js` | sign-in, sign-up and password reset against Identity Toolkit |
| `firebase.js` | service-account auth for Firestore |
| `history.js` | saved conversions, every read scoped by uid |
| `gemini.js` | the model chain, the Files API upload, outage records in KV |
| `prompt.js` | the conversion prompt and the model chain order |
| `ratelimit.js` | per-caller limits, backed by a Durable Object |
| `security.js` | the Content-Security-Policy the Worker sends |

The Worker owns the prompt entirely. The client sends **raw image bytes** as
the request body, never JSON containing text — an earlier design concatenated
the client's body inside a JSON string literal, which was a working prompt
injection. The comment in `gemini.js` records it.

## The client

| Module | Responsibility |
|---|---|
| `app.js` | the page: shell state, the terms gate, the two questions only a person can answer |
| `ui.js` | dialogs, focus traps, toasts, the drawer, the legal reader |
| `input.js` | the four ways a page gets in: picker, drag-and-drop, camera, writing canvas |
| `convert.js` | the conversion itself: model chain, page-by-page, fallback authorisation |
| `pages.js` | what the input is, and splitting a PDF into pages |
| `auth.js` | the auth forms and the Firebase SDK for federated sign-in |
| `history.js` | both histories — the guest list in this browser, the saved list from the Worker |
| `preview.js` | rendering the compiled PDF with pdf.js |
| `latex/` | `validate` (refuse unsafe input), `compile` (pdfTeX in WASM), `assemble`, `documents` (merge per-page documents), `repair` |
| `recognise/` | the offline path: `preprocess`, `segment`, `text` (Tesseract), `formulas` (ONNX), `resample`, `local` |

Anything with a decision in it lives outside `app.js`, so its failure modes can
be exercised without a browser click. `tests/fallback.mjs` drives the whole
conversion against a Gemini that is down, rate-limited, or dies on page three.

## Rules the code keeps

**Never quietly produce a lesser document.** If the AI is unavailable when the
user presses Convert, they are asked before the offline path runs. The one
deliberate exception is an AI that was up at the start and failed part way:
re-prompting then would discard pages that already converted, so it finishes
locally and says so in the result. `convert.js` and `tests/fallback.mjs` both
record this.

**Who the visitor is is never the client's to assert.** Identity and terms
acceptance are read from the signed session cookie in the Worker on every
request that matters.

**A guest leaves nothing on the server.** Guest history is `sessionStorage`, so
it goes when the tab does, and signing in clears it — a signed-in user never
sees a previous guest's work.

**The preview may be repaired; the `.tex` never is.** When the model names a
package the TeX tree does not carry, the preview is recompiled without it so
the document renders — and the result says which package was dropped. The file
you download is what the model wrote.

## What the pieces are built from

`edge/public/texmf/`, `edge/public/models/` and parts of `edge/public/vendor/`
are build outputs produced by the scripts in `edge/tools/`, and none of them is
committed. Most can be rebuilt from what is here — the ONNX Runtime and
Tesseract from npm, the formula recogniser from the committed
`edge/build/mfr-int8/`. `public/texmf/` cannot: it has to be harvested from a
TeX Live installation, and `build:texmf` only post-processes a tree that
already exists. See the caveat in
[README.md](README.md#a-caveat-you-should-know-before-cloning).

## Data

Firestore holds saved conversions and profiles, reached only through the
Worker's service account. The security rules deny browser access outright — the
Worker bypasses them by design, so uid scoping in `worker/history.js` is the
real control and the rules are the second line.

Cloudflare KV holds per-model outage records. A Durable Object holds rate-limit
state. Neither holds user content.
