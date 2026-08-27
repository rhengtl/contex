# Deploying ConTeX

Everything in this file was prepared and, where it could be, verified before
any deployment existed. Where something genuinely cannot be checked until the
app has a public URL, it is in [After the first deploy](#after-the-first-deploy)
and is **not** described as done.

---

## The one thing to understand first

**Firebase Hosting cannot run this application.** Hosting serves static files.
ConTeX is a Flask server that shells out to a TeX engine, Tesseract and
Poppler, and loads an ONNX model. There is no arrangement of `firebase.json`
that makes Hosting execute Python.

The supported Firebase answer is to put the app on **Cloud Run** and have
Hosting rewrite every request to it. That is what `firebase.json` now does:

```
  browser  ->  Firebase Hosting (CDN, TLS, your domain)
                    |  rewrite "**"
                    v
               Cloud Run service "contex"   <- the Dockerfile builds this
                    |
                    +--> Firebase Auth      (identitytoolkit REST)
                    +--> Firestore          (Admin SDK, service account)
                    +--> Gemini API         (server-side key)
```

You keep the `web.app` / `firebaseapp.com` URL and the Firebase CLI, and the
app runs in a container that actually has `pdflatex` in it.

If you would rather not use Cloud Run, the same `Dockerfile` runs unchanged on
Render, Fly.io, Railway or any container host - in that case Firebase stays
what it already is (Auth + Firestore) and Hosting is simply not used.

---

## Prerequisites

| Tool | Status on this machine | Needed for |
|---|---|---|
| `firebase` CLI | **15.11.0, present** | rules, indexes, hosting |
| Docker | **29.4.3, present** | building the image |
| Node + JDK | **v24.14.0 / OpenJDK 21, present** | the Firestore rules tests |
| `gcloud` CLI | **NOT INSTALLED** | building and deploying to Cloud Run |

`gcloud` is the only gap. Install the Google Cloud SDK, then:

```bash
gcloud auth login
gcloud config set project contex-28bfd
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

---

## The deploy commands

Nothing below has been run. They are written out so the sequence is decided
now rather than improvised later.

### 1. Secrets into Secret Manager

The Gemini key and the Flask session secret must not be baked into the image
or typed into a `--set-env-vars` flag that lands in your shell history and in
the service's revision metadata.

```bash
gcloud services enable secretmanager.googleapis.com

printf '%s' "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
python -c "import secrets; print(secrets.token_hex(32))" \
  | tr -d '\n' | gcloud secrets create flask-secret-key --data-file=-
```

Generate a **new** `FLASK_SECRET_KEY` for production. The one in your local
`.env` has been on a development machine; treat it as compromised for
production purposes.

### 2. Build and deploy the service

```bash
gcloud run deploy contex \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 4Gi \
  --cpu 2 \
  --timeout 600 \
  --concurrency 8 \
  --min-instances 0 \
  --max-instances 4 \
  --session-affinity \
  --set-env-vars "FIREBASE_PROJECT_ID=contex-28bfd,FIREBASE_AUTH_DOMAIN=contex-28bfd.firebaseapp.com,UPLOAD_FOLDER=/tmp/contex,TRUST_PROXY=true" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,FLASK_SECRET_KEY=flask-secret-key:latest,FIREBASE_API_KEY=firebase-web-api-key:latest"
```

Why these numbers:

- **4 GiB / 2 CPU** — torch, the ONNX model and a rasterised ten-page PDF all
  live in memory at once, and `/tmp` is a tmpfs that counts against the same
  budget.
- **`--timeout 600`** — a ten-page PDF conversion is minutes, not seconds.
  Cloud Run's default 300s would cut real work short.
- **`--concurrency 8`** — matches `GUNICORN_THREADS`. Higher, and requests
  queue behind each other's `pdflatex`.
- **`--session-affinity`** — see [The multi-instance
  caveat](#the-multi-instance-caveat). This matters.
- **No `FIREBASE_SERVICE_ACCOUNT_PATH`** — deliberately. The app falls back to
  the service account Cloud Run already gives it, so no private key is in the
  image. Grant that identity `roles/datastore.user` and
  `roles/firebaseauth.admin`.

### 3. Rules, indexes and Hosting

```bash
firebase deploy --only firestore:rules,firestore:indexes,database,hosting
```

Note what `database` does: it applies `database.rules.json`, which **denies all
access to the Realtime Database**. Your project has an RTDB instance
(`contex-28bfd-default-rtdb`, asia-southeast1) that this application never
touches. Locking it shut is correct here — but if anything else of yours uses
it, drop `"database"` from `firebase.json` before running this.

### 4. Verify

```bash
curl -si https://contex-28bfd.web.app/healthz
curl -si https://contex-28bfd.web.app/ | head -40   # check the headers
```

---

## What is already configured and verified

Verified means measured, not assumed.

| Item | State |
|---|---|
| Firestore composite index `uid ASC + timestamp DESC` | **Deployed and live.** Read back from the project with `firebase firestore:indexes`. A real signed-in query ran without falling back to sorting in Python. |
| Firestore security rules | **Tested against the real rules engine** in the emulator: 28 checks, all passing. Verified to bite — 23 of them fail against permissive rules. Not yet deployed. |
| Email/Password sign-in | Enabled in the project. Verified end to end against live Firebase. |
| Google sign-in | Enabled, client ID and secret set. Implemented on both `/login` and `/signup`. |
| Email enumeration protection | **On** in the project. |
| Authorized domains | `localhost`, `contex-28bfd.firebaseapp.com`, `contex-28bfd.web.app` — the default Hosting domains are **already** authorized, so Google sign-in will work on the first deploy with no console change. |
| Cross-user isolation | Verified with two real throwaway accounts: neither could read, download, preview or edit the other's history. Both accounts and all their documents were deleted afterwards; the project is back to zero users. |
| Secrets in git | `.env` and `*.json` are ignored; no service account key or API key is tracked. |
| Secrets in the image | `.dockerignore` excludes `.env`, `*.json`, `.venv`, `bench/`, `brand/` and `uploads/`. |
| Container build | **Builds, 3.69 GB.** Verified to contain no `.env`, no service account key, no virtualenv, no benchmark corpus - and to contain `pdflatex`, `tesseract`, `pdftoppm`, `pdfinfo` and `gs`. |
| The app inside the container | A real AI conversion (Gemini, 10-13s) and a real local-fallback conversion (4.8s) both ran end to end: upload -> LaTeX -> `pdflatex` -> PDF -> page image -> `.tex` download. |
| Fail-closed on a missing secret | Verified in the container: with no `FLASK_SECRET_KEY` the worker refuses to boot and gunicorn shuts down. |
| Security headers | Verified on live responses from the container: CSP, `nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS. |
| Error pages | A 404 and an induced 500 render in the application shell and carry no traceback, path, exception type or key. |
| Browser and responsive | 227 checks across 5 viewports (1920, 1366, 768, 360 portrait, 740 landscape) x 5 pages: no sideways scroll, no overflow, no console errors, no failed requests, every control >= 24px, every dialog opens and closes on Escape. |
| LaTeX sandboxing | The file-read path was **demonstrated** before the fix: a canary string from an unrelated file on disk appeared in the rendered PDF. 13 attack shapes are now refused; 7 real document shapes still compile. |

---

## After the first deploy

These need the live URL. **None of them has been tested.**

### 1. A custom domain, if you add one

Everything here is unnecessary while you use `contex-28bfd.web.app`.

- **Firebase Console → Authentication → Settings → Authorized domains** — add
  the custom domain. Until you do, `signInWithPopup` fails with
  `auth/unauthorized-domain`.
- **Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Web
  client** — add `https://YOUR-DOMAIN` to *Authorized JavaScript origins* and
  `https://YOUR-DOMAIN/__/auth/handler` to *Authorized redirect URIs*.
- Update the `FIREBASE_AUTH_DOMAIN` env var if you also move the auth handler.
  The Content-Security-Policy is built from that variable, so it follows
  automatically — but check it, because a wrong value silently blocks the
  sign-in iframe.

### 2. Test on real HTTPS

- **Camera capture.** `getUserMedia` only works in a secure context. It has
  never run over real HTTPS here — only on `localhost`, which browsers exempt.
- **`Secure` session cookies.** They are switched on by production config and
  cannot be exercised over `http://localhost`.
- **HSTS.** Sent in production. Once a browser has seen it, that domain is
  HTTPS-only for a year. Confirm the deploy is healthy before letting many
  people load it.

### 3. Test the CSP against the real sign-in flow

The policy is strict and default-deny. The Google popup is the part most
likely to trip it. Open the console on the deployed `/login`, click the Google
button, and watch for `Refused to ...` messages.

### 4. Budget and quota

- **Set a budget alert on the Google Cloud project.** `/convert` is open to
  anonymous callers by design and each call costs a Gemini request plus CPU.
- Cloud Run `--max-instances 4` is the hard ceiling on how bad a bill can get.
  Keep it.

### 5. Turn on Cloud Armor if abuse appears

The built-in rate limiter counts within **one process** (see below). If the
service is ever seriously abused, a shared limit belongs in front of it.

---

## Known limitations, stated plainly

### The multi-instance caveat

A generated result — the `.tex`, its compiled PDF, the page images — is written
to local disk under a random token, and the token is recorded in the visitor's
session cookie (`tex_store.py`). With more than one Cloud Run instance, a
request that lands on instance B cannot see a result written on instance A, and
the user sees *"That download link has expired or does not belong to this
session."*

`--session-affinity` is the mitigation and it is **best-effort**, not a
guarantee: Cloud Run drops affinity when an instance is recycled or scaled
down. The complete fix is to move the store to Cloud Storage or Firestore,
which is a real change to `tex_store.py` rather than a flag.

Until then: the results are short-lived by design (one hour) and the failure is
visible and honest rather than silent or wrong.

### Rate limiting is per process

`_rate_limited()` in `app.py` counts requests inside one Python process. Under
gunicorn with 2 workers a caller effectively gets twice the allowance, and with
several Cloud Run instances it multiplies again. It stops a script hammering
one instance. It is not a defence against a distributed attacker.

### `'unsafe-inline'` in the script CSP

The Content-Security-Policy is otherwise default-deny, but `script-src`
carries `'unsafe-inline'`. This is not an oversight: about twenty templates use
inline `onclick=` handlers, which no nonce or hash can cover — only
`'unsafe-hashes'` or moving them to `addEventListener`. Removing it is front-end
work, not a header change. Until then the CSP is a meaningful defence against
external script injection and a weak one against inline injection.

### Email verification is not required

`create_user` does not send a verification email and no route checks
`email_verified`. Anyone can sign up with an address they do not own. For an
app whose only account benefit is private history, that is a defensible
choice — but it *is* a choice, and it is not currently written down anywhere
the user can see.

### Sign-up still reveals whether an address is registered

Firebase's email enumeration protection is on, and the **sign-in** form is
protected by it. The **sign-up** form is not: `create_user` goes through the
Admin SDK and returns `Email already exists`, which is exactly the fact the
protection exists to hide. Fixing it means making sign-up succeed silently and
send a "you already have an account" email instead — which needs an email path
this project does not have.

### LaTeX sandboxing is two layers, and one of them is platform-specific

`latex_tools.py` refuses any generated document containing a primitive that
reads files, writes files or runs commands, and separately puts kpathsea in
paranoid mode via the environment. The kpathsea half works on TeX Live (the
container) and is ignored by MiKTeX (Windows development). The source-level
guard is what covers both. Neither is claimed to be a complete TeX sandbox;
together they close the reachable path, which was demonstrated before the fix
by getting a canary string out of an unrelated file and into the rendered PDF.

---

## Dependencies

`requirements.txt` was audited with `pip-audit`. The web-facing stack is
current:

```
Flask 3.1.1 -> 3.1.3      Werkzeug 3.1.3 -> 3.1.6    gunicorn 21.2.0 -> 23.0.0
requests 2.32.3 -> 2.33.0 urllib3 2.4.0 -> 2.7.0     pillow 10.2.0 -> 12.3.0
lxml 5.4.0 -> 6.1.0       aiohttp 3.12.0 -> 3.14.3   python-dotenv 1.0.0 -> 1.2.2
certifi, click, protobuf, filelock, aiosignal also raised
```

`requirements.txt` also could not be installed from scratch. It pinned
`typing_extensions==4.13.2` while `google-genai` requires `>=4.14.0`, and
`idna==3.10` where the working environment had 3.19. The existing virtualenv
hid it - the packages were there, just not the versions the file claimed. The
first container build failed on it, which is exactly what a build is for. Both
pins now match the environment that passes the tests, and the whole file
resolves cleanly in a clean interpreter.

A second, lower-risk round took `onnx` to 1.22.0, `pyarrow` to 23.0.1,
`sentencepiece` to 0.2.1 and `setuptools` to 83.0.0, verified by re-running the
local OCR fallback and confirming byte-identical output.

`gunicorn` and `pillow` are the two that mattered most: gunicorn 21.2.0 has
two request-smuggling advisories and is the production server, and pillow
decodes every image an anonymous visitor uploads.

**Result: 19 packages carried advisories before, 3 do now.**

**Those three are the local-OCR stack, deliberately left behind**, and this is
the honest version of why:

| Package | Pinned | Clearing every advisory needs |
|---|---|---|
| `transformers` | 4.37.0 | 5.5.0 |
| `torch` | 2.7.0 | 2.13.0 |
| `datasets` | 3.6.0 | 5.0.1 |

`equation.py` loads `breezedeus/pix2text-mfr` through `optimum 1.17.1`, which
is from February 2024. Moving `transformers` from 4.x to 5.x is not a bump; it
is a migration of `optimum` as well, and the thing at risk is the measured
quality of the local fallback (93–95% on the benchmark corpus). The exposure is
also narrower than the advisory count suggests: nearly all of these concern
deserialising *untrusted model files*, and this app loads one pinned model from
one repository, baked into the image at build time with `HF_HUB_OFFLINE=1`.

That is a reason to schedule the migration, not a reason to call it safe. It
should be its own task, with the benchmark re-run afterwards.

`datasets` (and through it `pandas`, `pyarrow`, `aiohttp`, `dill`) cannot
simply be dropped: it is a hard, non-optional dependency of `optimum 1.17.1`.

---

## Running the checks

```bash
python test_ai_qa.py          # the full suite, no API key needed
npm install && npm run test:rules   # Firestore rules against the emulator
docker build -t contex .      # the production image
```
