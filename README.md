# ConTeX

Photograph a page of handwriting, or drop in a PDF, and get LaTeX back — with a
PDF preview compiled in the browser so you can see what you are about to
download.

Live at **https://contex.rhengtl.workers.dev**

---

## Where the application is

Everything that runs in production is in [`edge/`](edge/). It is a Cloudflare
Worker plus a tree of static assets:

| | |
|---|---|
| `edge/worker/` | the API: sessions, auth, conversion, history, rate limiting |
| `edge/public/` | the site itself — pages, client modules, and the runtime assets |
| `edge/pages/` | page sources; `npm run build:ui` expands them into `edge/public/` |
| `edge/design/` | the one stylesheet source, built to `edge/public/app.css` |
| `edge/tests/` | the verification suite |
| `edge/tools/` | build steps for the asset trees |

The repository root holds only what sits *outside* the Worker: the Firestore
security rules and their test, the frozen benchmark fixtures the suite reads,
and this documentation.

There was previously a Flask implementation of the same product in `contex/`,
deployed by Docker to a VM. It has been removed — the edge application replaced
it and is the only thing deployed. It remains in the Git history if it is ever
wanted again.

## How a conversion works

1. The page is sent to the Worker, which calls Gemini with a prompt the Worker
   owns. The client never supplies prompt text.
2. If every model in the chain refuses, the browser is offered a local
   fallback: Tesseract for text and an ONNX formula recogniser for mathematics,
   both running on the viewer's machine, with nothing sent anywhere.
3. The resulting LaTeX is compiled to a PDF **in the browser** by SwiftLaTeX's
   pdfTeX built to WebAssembly, against a TeX Live subset served as static
   files.

Signed-in conversions are saved to Firestore through the Worker and scoped by
uid. Guests get a history held in their own browser and nothing on the server.

## Running it

```bash
cd edge
npm ci
npm run dev          # wrangler dev on :8788
npm test             # the full suite
```

`npm test` needs the runtime asset trees described below.

## A caveat you should know before cloning

**A fresh clone cannot serve this application yet.** 137 MB of what Cloudflare
serves is gitignored build output. Most of it can be rebuilt from what is here;
one tree cannot.

| Tree | Size | Rebuilt by | From the repo? |
|---|---|---|---|
| `edge/public/vendor/ort/`, `vendor/tesseract/` | ~17 MB | `npm ci && npm run build:models` | **yes** — npm packages |
| `edge/public/models/mfr/` | ~32 MB | `npm run build:models -- model-src/mfr-int8` | **yes** — `edge/model-src/mfr-int8/` is committed |
| `edge/public/models/tessdata/` | ~4 MB | same step | no — needs a local Tesseract install |
| `edge/public/texmf/` | 84 MB, 2,384 files | `npm run build:texmf` | **no** |

`build:texmf` is the gap. It works *in place*: it adds the extensionless `.tfm`
copies kpathsea needs to a `public/texmf/` that must already have been
populated by harvesting a TeX Live installation. Nothing in this repository
produces it, and the SwiftLaTeX format file inside it (10.36 MB) has no source
here either.

Until that is resolved, `npm run check:assets` fails on a clean clone, and —
more dangerously — `wrangler deploy` would publish only the committed files and
strip the live site of its fonts and engine data.
`.github/workflows/edge.yml` refuses to run at all rather than let that happen.

Deciding how to close it (commit the tree, Git LFS, or a release artifact
restored at build time) is the outstanding piece of work on this repository.

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — deploying, secrets, Firebase, and the
  failure modes that have actually happened
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit and why
- [FIREBASE_README.md](FIREBASE_README.md) — which Firebase services are used,
  the data model, and what the security rules do
- [edge/README.md](edge/README.md) — the engineering record of the port, stage
  by stage, including what each suite verifies
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)

## Licence

[MIT](LICENSE).
