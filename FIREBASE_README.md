# Firebase in ConTeX

Two Firebase services are used, and no others:

- **Authentication** — accounts, sign-in, password reset, and Google sign-in.
- **Firestore** — the saved history of signed-in users, and their profile.

Hosting, Realtime Database, Storage and Cloud Run are not used. `firebase.json`
therefore configures only Firestore, the Realtime Database rules (locked shut,
because the database exists on the project and must stay unreachable), and the
local emulator.

Setup and troubleshooting for a deployment live in
[DEPLOYMENT.md](DEPLOYMENT.md#firebase). This document is the data model.

---

## How authentication works

Email and password never reach the browser's Firebase SDK. The forms post to
the Worker, which verifies the credentials against Identity Toolkit with the
project's Web API key and then issues its own signed session cookie. Google
sign-in is the one exception: it uses the browser SDK, completes at the
project's `authDomain`, and hands the resulting ID token to the Worker, which
verifies it and issues the same cookie.

That is why only Google sign-in cares about the Authorized domains list, and
why everything else keeps working when a new hostname has not been added yet.

## Data

```javascript
users/{uid}
  uid, email, displayName, createdAt, lastLogin,
  termsAcceptedVersion, termsAcceptedAt

ocr_history/{docId}
  uid, fileName, ocrType, result, truncated, timestamp
```

`result` is capped at 60,000 characters (`HISTORY_RESULT_LIMIT` in
`edge/worker/history.js`); a longer document is stored truncated and flagged,
and the app refuses to compile a preview from it rather than showing a broken
one.

Guests are never written to Firestore. Their history lives in `sessionStorage`
and goes when the tab does.

## Security rules

`firestore.rules` is deny-by-default. A signed-in user can reach their own
profile and their own history rows and nothing else; ownership cannot be
forged, reassigned, or backdated, and no client can write a field the app does
not use.

The Worker bypasses these rules entirely — it authenticates with a service
account — so today they are defence in depth against a leaked Web API key
rather than the thing that protects the data. Every read the Worker makes is
scoped by uid in `edge/worker/history.js`; that is the real control. The rules
are still written strictly, because the day a client write is added, the safe
shape should already exist.

Run them against the real rules engine, from the repository root:

```bash
npm ci
npm run test:rules
```

The Firebase emulator is a Java program, so a JDK is needed. No real project is
touched.

## Indexes

The history list needs one composite index:

```
ocr_history:  uid ASC, timestamp DESC
```

It is declared in `firestore.indexes.json`. Deploy it with:

```bash
firebase deploy --only firestore:indexes
```

Without it the Worker notices, says so on the console, and falls back to
fetching that user's rows and sorting them itself — still scoped by uid, so
still private, just slower. See the comment above `recent()` in
`edge/worker/history.js`.
