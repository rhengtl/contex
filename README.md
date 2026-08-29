# ConTeX

[![tests](https://github.com/rhengtl/contex/actions/workflows/tests.yml/badge.svg)](https://github.com/rhengtl/contex/actions/workflows/tests.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn any page — handwritten, printed, photographed or typed — into LaTeX.

ConTeX reads the prose and the mathematics on a page **together**, and returns a
complete `.tex` file plus a rendered PDF preview. There is one conversion
feature and no converter to choose: which engine reads a page is an
implementation detail the user never sees.

---

## What problem it solves

Transcribing a page of mathematics into LaTeX by hand is slow and error-prone,
and general-purpose OCR gets the prose right while destroying the equations.
ConTeX handles a mixed page — a paragraph, a displayed formula, a table — as one
document, and gives back something that compiles.

## Features

- **One upload, one workflow.** Image, PDF, Word document, camera capture or
  handwriting drawn on a canvas all enter the same pipeline.
- **Mixed prose and mathematics** recognised together rather than in separate
  passes.
- **A graceful local fallback.** If the AI provider is unavailable or
  unconfigured, the app says so and offers a Tesseract + pix2text path that runs
  entirely on the server. Falling back is never silent.
- **PDF preview** compiled by a real TeX engine, rendered page by page in the
  browser.
- **History.** Guests get a session-local list; signed-in users get history
  persisted in Firestore.
- **Multi-page PDFs**, capped at a configurable page limit (10 by default).

## How it works

```
accept terms ─▶ upload ─▶ check AI availability ─▶ convert ─▶ .tex
                                 │                             │
                        available│  unavailable                ├─▶ download
                                 │      │                      ├─▶ copy
                                 │      └─▶ warn the user,     └─▶ PDF preview
                                 │          they choose
                                 ▼
                     ┌───────────┴────────────┐
                     │                        │
             AI reads the page        Tesseract + pix2text
             and writes LaTeX         merged by position
                 (normal)                 (fallback)
```

Word documents take neither path: a `.docx` already knows its own headings,
cells and words, so it is read structurally and only its LaTeX form is decided.

The generated LaTeX is validated and, where possible, compiled and repaired
before it reaches you. [ARCHITECTURE.md](ARCHITECTURE.md) covers the pipeline,
the model choice and the measurements behind both.

## Supported inputs

| Input | Extensions | Notes |
|---|---|---|
| Images | `.png` `.jpg` `.jpeg` `.bmp` `.tiff` `.tif` `.webp` `.gif` | Deskewed and upscaled before OCR |
| PDF | `.pdf` | Multi-page, capped by `UNIFIED_MAX_PDF_PAGES` (10) |
| Word | `.docx` | Read structurally, never OCR'd |
| Camera | — | Captured in-browser, posted as an image |
| Canvas | — | Handwriting drawn in-browser, posted as an image |

Uploads are capped at `MAX_UPLOAD_MB` (32 MB by default). Anything else is
refused with a clear message.

## Output

- **`.tex` download** — a complete document, not a fragment.
- **Copy to clipboard.**
- **PDF preview** — compiled server-side, viewable page by page, downloadable.

## Authentication and history

| | Guest | Signed in |
|---|---|---|
| Convert, download, preview | Yes | Yes |
| History | In the browser, cleared when the tab closes | Persisted in Firestore |
| Requires Firebase | No | Yes |

Every conversion feature works with no account and no Firebase configured at
all. Signing in adds history that survives closing the tab, nothing else.
Accounts use Firebase Authentication (email/password and Google sign-in); the
server holds a signed session cookie and never a password.

## Technology stack

**Backend** — Python 3.12, Flask, gunicorn, organised as a layered package
(`web/` → `pipeline/` → `services/` + `data/`).

**Recognition** — Google Gemini (default) or Anthropic Claude for the AI path;
Tesseract and `breezedeus/pix2text-mfr` (TrOCR via ONNX Runtime) for the local
fallback.

**Documents** — pikepdf, pdf2image/Poppler, python-docx, and a LaTeX engine
(MiKTeX or TeX Live) for compilation.

**Frontend** — server-rendered Jinja templates and one hand-written
`static/scripts.js`. No frontend framework, no build step at runtime; Tailwind
compiles `static/css/app.css` ahead of time and the result is committed.

**Firebase** — Authentication, Firestore, and Hosting in front of Cloud Run.

## Project structure

```
contex/                  the application package
├── app.py               Flask app assembly, config, blueprint registration
├── config.py            every environment variable read, in one place
├── web/                 routes: pages, auth, convert, output, security, session
├── pipeline/            conversion: inputs, preprocess, recognise/, latex/
├── services/            outbound: firebase, accounts, llm/ (gemini, anthropic)
└── data/                persistence: users, history, results
templates/               Jinja templates
static/                  committed CSS, JS and images
public/                  Firebase Hosting root — robots.txt only, by design
tests/                   the Python suite and the Firestore rules suite
tools/                   build_css.py, make_assets.py
bench/                   conversion-quality benchmarks (development only)
wsgi.py                  the entry point for gunicorn and for `python wsgi.py`
```

## Local development

Every command runs from the project root — the directory holding `wsgi.py`.

**1. Clone and create an environment**

```bash
git clone https://github.com/rhengtl/contex.git
cd contex
python -m venv .venv
```

**2. Install dependencies**

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt   # Windows
```
```bash
.venv/bin/python -m pip install -r requirements.txt           # macOS / Linux
```

Three system binaries are optional. The app degrades honestly without each:

| Binary | Needed for | Without it |
|---|---|---|
| LaTeX engine (MiKTeX / TeX Live) | PDF preview, compile check | `.tex` still downloads; the preview explains itself |
| Poppler (`pdftoppm` on PATH) | rasterising PDFs for the fallback | PDFs still convert on the AI path |
| Tesseract | the fallback's text half | the AI path is unaffected |

**3. Configure the environment**

```bash
cp .env.example .env
```

Then fill in `.env` — see [Environment variables](#environment-variables). The
file is gitignored and must stay that way.

**4. Run**

```powershell
.venv\Scripts\python.exe wsgi.py
```

Open <http://127.0.0.1:5000/>.

**5. Run the checks**

```powershell
.venv\Scripts\python.exe tests/test_contex.py   # 179 offline checks, no API key needed
npm install && npm run test:rules               # Firestore rules, against the emulator
```

## Firebase setup

Firebase is optional for conversion and required for accounts and persistent
history. [FIREBASE_README.md](FIREBASE_README.md) is the full guide; in short:

1. Create a project in the [Firebase Console](https://console.firebase.google.com/).
2. **Authentication** → enable Email/Password and Google sign-in.
3. **Firestore** → create the database.
4. **Service account** → Project Settings → Service Accounts → *Generate new
   private key*. Save it outside version control and point
   `FIREBASE_SERVICE_ACCOUNT_PATH` at it. **Local development only** — on Cloud
   Run the platform supplies the credential and no key enters the image.
5. Deploy the rules and the composite index (`uid` ASC + `timestamp` DESC),
   which the history query requires:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Hosting configuration is already in `firebase.json`: `public/` is the Hosting
root and holds only `robots.txt`, and every request is rewritten to the Cloud
Run service.

## Deployment

**Firebase Hosting cannot run this application on its own.** Hosting serves
static files; ConTeX is a Flask server that shells out to a TeX engine,
Tesseract and Poppler and loads an ONNX model. The supported arrangement — and
what `firebase.json` already configures — is Hosting rewriting every request to
a **Cloud Run** service built from the `Dockerfile`:

```
browser ─▶ Firebase Hosting (CDN, TLS, your domain)
                │  rewrite "**"
                ▼
           Cloud Run service "contex"
                ├─▶ Firebase Auth (Identity Toolkit REST)
                ├─▶ Firestore (Admin SDK)
                └─▶ Gemini API (server-side key)
```

[DEPLOYMENT.md](DEPLOYMENT.md) has the exact commands, the Secret Manager setup,
and — importantly — what **cannot** be completed until the production URL
exists. Authorised domains for Google sign-in, the OAuth redirect
configuration and the CSP check against the real sign-in flow all depend on the
deployed domain and are not done in advance.

## Environment variables

Copy `.env.example` and fill it in. No value below belongs in version control.

| Variable | Required | What it is |
|---|---|---|
| `FLASK_SECRET_KEY` | Yes | Signs the session cookie. Generate a long random value; changing it logs everyone out. |
| `GEMINI_API_KEY` | For the AI path | From <https://aistudio.google.com/apikey>. Without it the app warns and offers the local fallback. |
| `FIREBASE_API_KEY` | For accounts | Firebase Console → Project Settings → Web app. Public by design, but still not committed. |
| `FIREBASE_AUTH_DOMAIN` | For accounts | Usually `<project-id>.firebaseapp.com`. |
| `FIREBASE_PROJECT_ID` | For accounts | Your Firebase project ID. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Local only | Path to the Admin SDK JSON. Leave **unset** on Cloud Run. |
| `PORT` | No | Defaults to 5000 locally; Cloud Run supplies 8080. |
| `UPLOAD_FOLDER` | No | Defaults to `uploads`. |

`.env.example` documents these and the optional tuning variables — model
selection, page limits, timeouts and feature switches — with comments.

## Security

- **Never commit `.env`.** It carries the Gemini key, the Flask session secret
  and the Firebase web keys. It is gitignored; keep it that way.
- **Never commit a service-account JSON.** It grants full administrative access
  to the Firebase project. `.gitignore` and `.dockerignore` both exclude it, and
  a test asserts that nothing secret can reach the deployed image.
- **Firestore security rules are part of the security model**, not decoration.
  `firestore.rules` denies client access to history and profile documents
  outright — only the server, holding a service account, writes them. Deploy
  rules whenever they change and run `npm run test:rules` first.
- **Production auth configuration depends on the deployed domain.** Authorised
  domains and OAuth redirects cannot be finalised until Hosting gives you a
  URL. See [DEPLOYMENT.md](DEPLOYMENT.md#after-the-first-deploy).
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Known requirements and limitations

- **The fallback needs system binaries.** Tesseract, Poppler and a TeX engine
  are not Python packages. The container installs them; a local machine may not
  have them, and the app will tell you which is missing.
- **Results are held in memory for one hour** and are per-process. Running more
  than one Cloud Run instance means a preview request can land on an instance
  that never saw the conversion. See DEPLOYMENT.md, *The multi-instance
  caveat*.
- **Rate limiting is per process**, so it weakens as instances scale out.
- **Email verification is not required** at sign-up.
- **The local-OCR dependency stack is pinned old** (torch, transformers,
  optimum, datasets). DEPLOYMENT.md, *Dependencies*, has the exposure analysis;
  moving it is a migration, not a version bump.

## Documentation

| File | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The conversion pipeline, model choice, measurements, privacy |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Cloud Run + Hosting deployment, post-deploy steps, limitations |
| [FIREBASE_README.md](FIREBASE_README.md) | Firebase auth, Firestore, rules, indexes, troubleshooting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup and expectations for pull requests |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |

## License

[MIT](LICENSE) © RhenGTL
