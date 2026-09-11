# Contributing to ConTeX

Thanks for taking an interest. This is a personally maintained project, so the
process is light — but the bar for what gets merged is the same as for anything
else in the repository.

## Before you start

For anything larger than a bug fix, **open an issue first**. It saves you
building something that turns out to conflict with how the pipeline is meant to
work. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design and, more usefully,
the measurements behind it — several arrangements that look obviously better
were tried and were measurably worse.

## Development setup

Follow [Running it](README.md#running-it) in the README. In short:

```bash
git clone https://github.com/rhengtl/contex.git
cd contex/edge
npm ci
npm run dev            # wrangler dev on :8788
```

Local secrets go in `edge/.dev.vars`, which is gitignored. See
[DEPLOYMENT.md](DEPLOYMENT.md#secrets--set-them-after-the-first-deploy) for the
three the Worker reads.

You do **not** need an API key to develop or to run the test suite. Without
`GEMINI_API_KEY` the app exercises the local fallback, which is a legitimate
code path and worth testing against.

You do **not** need a Firebase project unless you are changing authentication
or history.

## Running the checks

```bash
cd edge && npm test        # the full suite; no network, no API key
npm ci && npm run test:rules   # Firestore rules, from the root; needs Java
```

`npm test` needs the runtime asset trees; the ones that are not committed take
one build step — see [The runtime asset trees](README.md#the-runtime-asset-trees).
The rules suite is separate because it needs the Java-backed emulator and only
has something to say when `firestore.rules` changes; run it yourself if you
touch that file and say in the PR that you did.

Checks that need Tesseract, Poppler or a LaTeX engine announce themselves as
`(skipped: ...)` when the binary is missing, so the suite stays green on a
machine without them. Install them if you are changing the conversion pipeline
or the LaTeX sandbox, and say in the pull request what you had: a run with
skips in it is weaker evidence than a full one, and CI cannot make up the
difference. `.github/workflows/edge.yml` rebuilds the asset trees, installs
Microsoft Edge for the browser suites, and runs `npm test` — nothing else is
installed there.

## What the code should look like

Match the surrounding code. Concretely, for this repository that means:

- **Comments explain why, not what.** The existing comments are mostly a record
  of decisions and trade-offs — why a timeout is that number, why a fallback
  behaves the way it does. Keep that. Do not add comments that restate the line
  below them.
- **No changelog comments.** Nothing that says "previously", "used to",
  "removed X here", or "TODO: clean up". The repository is not a historical
  record; git is.
- **Configuration reaches the code through the Worker's `env`.** Read it from
  the binding a handler is given, not from module scope. `wrangler.toml`
  declares the public `[vars]`; the three secrets are set with `wrangler secret
  put` and are never committed. Nothing under `edge/public/` ever sees one.
- **Keep the layering.** `edge/worker/` handles requests and owns everything
  secret, the conversion prompt included; `edge/public/` is the browser half,
  with `latex/` for compiling and `recognise/` for the offline path. A client
  module reaches an outside service through the Worker, never directly.
- **One definition per thing.** If two modules need the same helper, it lives in
  one of them and the other imports it.
- **Failure is never silent.** If the AI path is unavailable, the user is told
  and chooses. Do not add a code path that quietly degrades.

## Tests

New behaviour needs a check in `edge/tests/`. The suites are plain assertions
with descriptive names — no framework, no fixtures beyond the committed ones.
Read a few nearby checks and follow the shape; pick the suite that matches the
layer you changed (`security` for the Worker, `fallback` for the offline
pipeline, `input` for the input controls, `integration` for the whole page).

Tests must not require network access, an API key, or a Firebase project. The
outbound services are stubbed; extend the stubs rather than reaching past them.

## Commits and pull requests

- Branch off `master`.
- Write commit messages in the imperative mood, describing the change rather
  than the process: `Fix the page count on encrypted PDFs`, not `fixed bug`.
- Keep a pull request to one concern. A refactor and a behaviour change in the
  same PR are hard to review and harder to revert.
- In the PR description, say what changed, why, and how you verified it. If you
  changed conversion behaviour, say what you measured it against.
- Make sure `npm test` passes in `edge/` before you push.

## Things that will be declined

- Adding a frontend framework. The pages are built from plain HTML sources and
  a handful of hand-written ES modules, deliberately.
- Adding a dependency for something the standard library or an existing
  dependency already does.
- Reintroducing a separate converter as a user-visible choice. There is one
  conversion feature; which engine reads a page is an implementation detail.
- Rebuilding the offline recogniser weights as a routine version bump. The
  model in `edge/public/models/` is pinned and reproducible through
  `edge/tools/build-mfr.py`; changing it is a migration, not an upgrade.

## Security

Do not report a vulnerability in a pull request or a public issue. See
[SECURITY.md](SECURITY.md).

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
