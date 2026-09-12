# Deploying ConTeX

The application is a Cloudflare Worker with static assets, published with
`wrangler` from [`edge/`](edge/). Everything below has been done at least once
against the live project; the failure modes are recorded because each one
actually happened.

---

## What production is

| | |
|---|---|
| Worker | `contex` |
| URL | https://contex.rhengtl.workers.dev |
| Config | [`edge/wrangler.toml`](edge/wrangler.toml) |
| Firebase project | `contex-28bfd` |

The workers.dev hostname is the Worker's *name* plus the account subdomain, so
renaming the Worker renames the site.

## Before the first deploy

**A workers.dev subdomain must exist on the account.** Open the Cloudflare
dashboard → Workers & Pages once; visiting that page creates it. Without it
`wrangler deploy` uploads every asset, resolves every binding, and then fails
at the last step with `code: 10063`.

**The runtime asset trees must be present.** The TeX tree and the language
data are committed; the rest is one build step:

```bash
cd edge
npm ci
cp public/models/tessdata/eng.traineddata /tmp/eng.traineddata
npm run build:models -- model-src/mfr-int8 /tmp/eng.traineddata
```

See [The runtime asset trees](README.md#the-runtime-asset-trees) for what each
tree is and why the language data is handed over explicitly.

`npm run check:assets` is the gate: it reports anything the application fetches
at runtime that is not on disk. **Do not deploy if it reports something
missing** — a deploy publishes whatever is in `public/`, so an incomplete tree
is published as an incomplete site.

## Deploying

```bash
cd edge
npm run check:assets     # must report everything present
npm test                 # must pass
npx wrangler deploy
```

### From GitHub Actions

`.github/workflows/edge.yml` runs the suite on every pull request and push to
`master`. On `master` it then publishes the Worker — **only if** the repository
has a `CLOUDFLARE_API_TOKEN` Actions secret. Without one the deploy job prints
a notice and finishes green, so a project that deploys by hand is never red
for that reason.

To enable it: Cloudflare dashboard → My Profile → API Tokens → Create Token →
the **Edit Cloudflare Workers** template, with *Account Resources* restricted
to this one account. Add the value as an Actions secret named
`CLOUDFLARE_API_TOKEN` (Settings → Secrets and variables → Actions). The job
runs in an environment called `production`, which GitHub creates on first use;
add a required reviewer there if you want a deploy to wait for approval.

The workflow never sets the three Worker secrets below. They are set once, by
hand, and survive every deploy.

## Secrets — set them AFTER the first deploy

Three secrets are read by the Worker and are never committed:

| Secret | What it is |
|---|---|
| `GEMINI_API_KEY` | the conversion key |
| `SESSION_HMAC_KEY` | signs the session cookie |
| `FIREBASE_SERVICE_ACCOUNT` | the Admin SDK service-account JSON, verbatim |

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SESSION_HMAC_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

**Order matters, and getting it wrong silently breaks the site.** Running
`wrangler secret put` against a Worker that has no code yet creates a
*placeholder* script to hold the secrets. The first real `wrangler deploy` then
replaces that placeholder and takes the secrets with it — `wrangler secret
list` goes from three entries to `[]`. The symptom is `/api/ai-status`
answering `{"available":false,"reason":"not_configured"}`, because
`env.GEMINI_API_KEY` reads as undefined.

Deploy first, then set the secrets. Renaming the Worker creates a new script
and needs all three set again. A normal redeploy of an existing Worker keeps
them; the deploy output never lists secrets, so its binding table is not
evidence either way. Check with `wrangler secret list`.

Local development reads the same three from `edge/.dev.vars`, which is
gitignored.

## Bindings

`wrangler.toml` declares a KV namespace (`OUTAGES`, per-model outage records)
and a Durable Object (`RATE_LIMITER`). Create the namespace once and paste its
id into the config:

```bash
npx wrangler kv namespace create OUTAGES
```

The three `[vars]` — `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`,
`FIREBASE_API_KEY` — are public by design. A Firebase Web API key identifies
the project and is not a credential; the Worker's uid scoping and the deny-all
security rules are what protect the data.

## Firebase

Auth and Firestore are used; Hosting and Cloud Run are not.

**Add the deployed hostname to Authorized domains** (Firebase Console →
Authentication → Settings). Without it, Google sign-in fails with
`auth/unauthorized-domain`. Email/password sign-in, signup and password reset
all run server-side through the Worker and are unaffected — so this failure
looks like "only the Google button is broken".

**Firestore rules deny everything from the client.** `firestore.rules` is
`allow read, write: if false` for the whole database. The Worker reaches
Firestore with the service account, which bypasses the rules, so every read is
scoped by uid in `worker/history.js` instead; the rules make sure the public Web
API key can never be a second way in. Deploy them whenever the file changes, and
run the emulator suite first:

```bash
firebase deploy --only firestore:rules,firestore:indexes
npm run test:rules       # from the repository root; needs Java for the emulator
```

## Content Security Policy

Static assets are served by the platform without invoking the Worker — that is
what keeps them free — so the Worker cannot add headers to them.
[`edge/public/_headers`](edge/public/_headers) does. The Worker applies the
same set to its own responses, so the two together cover everything.

The policy names one exact Firebase auth domain. Regenerate it if the project
changes:

```bash
npm run build:headers contex-28bfd.firebaseapp.com
```

`_headers` rules match the **request** path, not the rewritten one. The engine
fetches the TeX tree as `/pdftex/<format>/<name>`, which `_redirects` rewrites
to `/texmf/<name>` — so a rule written for `/texmf/*` never applies to a single
engine request. Both are listed for that reason.

## Known operational limits

**Gemini's free tier is geographically restricted.** A Worker has no fixed
location: each request leaves from whichever Cloudflare PoP served it, and when
that PoP sits in an unsupported region Google refuses the upload with
`FAILED_PRECONDITION: User location is not supported for the API use`. This is
intermittent by nature — the same document can succeed and fail minutes apart.
`worker/gemini.js` maps every upload failure to a 502 with "try a different
file", which for this cause is misleading advice; the upstream status is
logged, so `wrangler tail` will show the real reason.

The application degrades correctly when it happens: the user is offered the
in-browser conversion rather than a broken page.

**The first compile is expensive.** The engine's format file is 10.36 MB and is
served uncompressed — `.fmt` is an extension the edge does not recognise, so it
gets no content type and no compression. Measured on a phone at 1.6 Mbps that
is ~55 s for the first conversion; the `immutable` cache headers make it a
once-only cost. The reasoning and the two rejected workarounds are recorded in
`edge/public/_headers`.

## Rolling back

`wrangler deployments list` shows the versions; `wrangler rollback [id]`
returns to one. Assets are versioned with the Worker, so a rollback takes the
matching asset tree with it.
