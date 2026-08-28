# Firebase in ConTeX

Firebase does three things here and nothing else:

- **Authentication** — accounts, passwords, Google sign-in.
- **Firestore** — the persistent history of signed-in users, and their profile.
- **Hosting** — the public URL, in front of a Cloud Run service. See
  [DEPLOYMENT.md](DEPLOYMENT.md); Hosting cannot run this app on its own.

Everything the app *does* — converting a document, generating the `.tex`,
compiling a preview — works with no Firebase at all. Signing in only adds
history that survives closing the tab.

---

## Local setup

### 1. Dependencies

```bash
pip install -r requirements.txt
```

### 2. A service account key (local development only)

1. [Firebase Console](https://console.firebase.google.com/) → your project
2. Project Settings → Service Accounts → **Generate new private key**
3. Save the JSON somewhere outside version control (`*.json` is gitignored)

**Do not do this for production.** On Cloud Run the app uses the service
account the platform already gives it — leave `FIREBASE_SERVICE_ACCOUNT_PATH`
unset there and no private key ever enters the image.

### 3. `.env`

Copy `.env.example` and fill in:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=your-project-firebase-adminsdk-xxxxx.json

# Public by design - these identify the project, they are not credentials.
# The Web API key is also what the server uses to verify passwords and to ask
# Firebase to send reset emails, so it is required, not optional.
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
```

`FIREBASE_DATABASE_URL` is only for the Realtime Database, which this app does
not use. Leave it out.

### 4. In the Firebase Console

- **Authentication** → enable **Email/Password**.
- **Authentication** → enable **Google** if you want the federated button to
  work (it is already implemented on both `/login` and `/signup`).
- **Authentication → Settings** → turn on **email enumeration protection**.
  The sign-in path depends on it to keep "no such user" and "wrong password"
  indistinguishable.
- **Firestore** → create the database in **production mode**, then deploy the
  rules in this repository rather than relying on the console defaults.

---

## How authentication actually works

This is worth stating precisely, because the obvious implementation is wrong.

**The Firebase Admin SDK cannot check a password.** That is deliberate on
Google's part. An implementation that looks a user up by email and treats
finding them as success is not authentication at all — it lets anyone sign in
as anyone by typing their address.

`verify_user()` therefore posts to the Identity Toolkit
`accounts:signInWithPassword` endpoint over HTTPS. Firebase compares the hash;
the password is never stored, logged or compared locally. If `FIREBASE_API_KEY`
is missing the function **refuses to sign anyone in** rather than falling back
to an existence check.

The same reasoning governs `send_password_reset()`: the Admin SDK can only
*generate* a reset link, and this project has no way to deliver one. So it asks
Firebase to send its own email (`accounts:sendOobCode`), and the link never
touches the server or its logs.

Both are covered by tests, and both were verified end to end against a live
project.

---

## Sessions

The signed-in user's uid lives in the Flask session cookie, which is signed
with `FLASK_SECRET_KEY`. Every ownership check reads the uid from there and
never from a request field, so a client cannot ask for another user's history
by supplying a different uid.

That places the whole weight of authentication on `FLASK_SECRET_KEY`. It has no
default: in production a missing key stops the process from starting.

Signing in clears whatever the session held before, so a guest's generated
documents do not follow the next person into their account on a shared
computer.

---

## Routes

**Authentication**
- `GET/POST /login` — email + password, or a Google ID token
- `GET/POST /signup`
- `GET/POST /forgot-password`
- `GET/POST /logout`

**Conversion**
- `GET /` — the workspace
- `GET /history` — past conversions
- `POST /accept-terms`
- `POST /convert` — an image, PDF or .docx in, a `.tex` out
- `GET /api/ai-status`
- `GET /legal/<document>`
- `GET /healthz`

**Output**
- `GET /download-converted-tex`
- `GET /preview/pages`, `/preview/page.png`, `/preview/document`, `/preview.pdf`

**History** (signed in)
- `GET /history/<doc_id>/download`, `/tex`, `/preview.pdf`

---

## Data

```javascript
users/{uid}
  uid, email, displayName, createdAt, lastLogin,
  termsAcceptedVersion, termsAcceptedAt

ocr_history/{docId}
  uid, fileName, ocrType, result, truncated, timestamp
```

`result` is capped at 60,000 characters; a longer document is stored truncated
and flagged, and the app refuses to compile a preview from it rather than
showing a broken one.

Guests are never written to Firestore. Their history lives in `sessionStorage`
and goes when the tab does.

---

## Security rules

`firestore.rules` is deny-by-default. A signed-in user can reach their own
profile and their own history rows and nothing else; ownership cannot be
forged, reassigned, or backdated, and no client can write a field the app does
not use.

The server bypasses these rules entirely — it authenticates with a service
account — so today they are defence in depth against a leaked Web API key
rather than the thing that protects the data. They are still written strictly,
because the day a client write is added, the safe shape should already exist.

Run them against the real rules engine:

```bash
npm install
npm run test:rules
```

28 checks, in the Firebase emulator. No real project is touched.

---

## Indexes

The history list needs one composite index:

```
ocr_history:  uid ASC, timestamp DESC
```

It is declared in `firestore.indexes.json`. Deploy with:

```bash
firebase deploy --only firestore:indexes
```

Without it, `data/history.py recent()` notices, says so on the console, and falls
back to fetching that user's rows and sorting them in Python — still scoped by
uid, so still private, just slower.

---

## Troubleshooting

**"Firebase Admin SDK initialized (application default credentials)" locally**
`FIREBASE_SERVICE_ACCOUNT_PATH` is unset. Fine on Cloud Run, wrong on a laptop.

**"Authentication is not configured"**
`FIREBASE_API_KEY` is missing. Password verification and reset emails both
need it.

**`CONFIGURATION_NOT_FOUND`**
Email/Password sign-in is not enabled in the console.

**`auth/unauthorized-domain` on the Google button**
The domain is not in Authentication → Settings → Authorized domains.
`localhost` and the two default Hosting domains are there by default; a custom
domain is not.
