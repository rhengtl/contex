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

`npm test` needs the runtime asset trees described below; one build step
produces the ones that are not committed.

## The runtime asset trees

Cloudflare serves everything under `edge/public/`. Three trees in it are build
output and are not committed; two are committed because nothing can produce
them.

| Tree | Size | Where it comes from |
|---|---|---|
| `edge/public/vendor/ort/`, `vendor/tesseract/` | ~17 MB | `npm run build:models`, from the packages the lockfile pins |
| `edge/public/models/mfr/` | ~32 MB | the same step, from the committed `edge/model-src/mfr-int8/` |
| `edge/public/models/tessdata/` | 4 MB | **committed** — the language data of the Tesseract this was verified with |
| `edge/public/texmf/` | 84 MB, 2,384 files | **committed** — a TeX Live subset and the SwiftLaTeX format file |

```bash
cd edge
npm ci
cp public/models/tessdata/eng.traineddata /tmp/eng.traineddata
npm run build:models -- model-src/mfr-int8 /tmp/eng.traineddata
npm run check:assets      # "Everything this application fetches at runtime is present."
```

The language data is passed in explicitly so the build copies the committed
file rather than whatever Tesseract happens to be installed. Each rebuilt tree
is byte-identical to what is deployed — that was checked file by file before
this arrangement was adopted — so a clean clone plus that one step *is* the
production tree.

The two committed trees are stored as opaque bytes (`-text` in
`.gitattributes`) and are not in Git LFS, deliberately: a checkout that skips
the LFS smudge — `actions/checkout` by default, or any machine without
`git-lfs` — leaves 133-byte pointer files that *exist*, so `check:assets`
passes and `wrangler deploy` publishes the pointers over the live site. Plain
Git cannot fail that way.

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
