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

Follow [Local development](README.md#local-development) in the README. In short:

```bash
git clone https://github.com/rhengtl/contex.git
cd contex
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt   # .venv\Scripts\ on Windows
cp .env.example .env                                  # then fill it in
```

You do **not** need an API key to develop or to run the test suite. Without
`GEMINI_API_KEY` the app exercises the local fallback, which is a legitimate
code path and worth testing against.

You do **not** need a Firebase project unless you are changing authentication
or history.

## Running the checks

```bash
python tests/test_contex.py     # 179 offline checks; no network, no API key
npm install && npm run test:rules   # Firestore rules, needs the emulator + Java
```

The Python suite runs in CI on every push and pull request. The rules suite does
not — run it yourself if you touch `firestore.rules`, and say in the PR that you
did.

Checks that need Tesseract, Poppler or a LaTeX engine announce themselves as
`(skipped: ...)` when the binary is missing, so the suite is still green on a
machine without them — 23 of the 179 go quiet that way. CI installs all three,
so a pull request is always measured against the full run. If you are changing
the conversion pipeline or the LaTeX sandbox, install them locally too; a green
local run with 23 skips is not the same evidence as a green CI run.

## What the code should look like

Match the surrounding code. Concretely, for this repository that means:

- **Comments explain why, not what.** The existing comments are mostly a record
  of decisions and trade-offs — why a timeout is that number, why a fallback
  behaves the way it does. Keep that. Do not add comments that restate the line
  below them.
- **No changelog comments.** Nothing that says "previously", "used to",
  "removed X here", or "TODO: clean up". The repository is not a historical
  record; git is.
- **Environment variables go through `contex/config.py`.** Use `config.text`,
  `config.flag`, `config.enabled` or `config.integer` rather than reaching for
  `os.getenv`, unless there is a specific reason not to.
- **Keep the layering.** `web/` handles requests, `pipeline/` converts,
  `services/` talks outward, `data/` persists. A route should not call an LLM
  provider directly.
- **One definition per thing.** If two modules need the same helper, it lives in
  one of them and the other imports it.
- **Failure is never silent.** If the AI path is unavailable, the user is told
  and chooses. Do not add a code path that quietly degrades.

## Tests

New behaviour needs a check in `tests/test_contex.py`. The suite is a single
file of plain assertions with descriptive names — no pytest, no fixtures. Read a
few nearby tests and follow the shape.

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
- Make sure `python tests/test_contex.py` passes before you push.

## Things that will be declined

- Adding a frontend framework. The UI is server-rendered Jinja and one
  hand-written script, deliberately.
- Adding a dependency for something the standard library or an existing
  dependency already does.
- Reintroducing a separate converter as a user-visible choice. There is one
  conversion feature; which engine reads a page is an implementation detail.
- Bumping the pinned local-OCR stack (torch, transformers, optimum, datasets)
  as a routine version bump. That is a migration — see *Dependencies* in
  [DEPLOYMENT.md](DEPLOYMENT.md).

## Security

Do not report a vulnerability in a pull request or a public issue. See
[SECURITY.md](SECURITY.md).

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
