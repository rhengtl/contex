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
| URL | https://contex.rhengtl.tech (primary) |
| Fallback URL | https://contex.rhengtl.workers.dev |
| Config | [`edge/wrangler.toml`](edge/wrangler.toml) |
| Firebase project | `contex-28bfd` |

The workers.dev hostname is the Worker's *name* plus the account subdomain, so
renaming the Worker renames the fallback.

Both addresses serve the same Worker and the same assets, and both are fully
working: neither redirects to the other. Every page carries
`<link rel="canonical">` and `og:url` pointing at contex.rhengtl.tech, so a
link shared or indexed from the fallback is still filed under the primary.
Sessions are per host (the cookie has no `Domain`), so signing in on one
address does not sign you in on the other.

## The custom domain

`rhengtl.tech` came from the GitHub Student Developer Pack (get.tech), claimed
2026-10-12 for one year. `edge/wrangler.toml` attaches it as a Workers
**Custom Domain** — Cloudflare creates the DNS record and the certificate — and
sets `workers_dev = true` explicitly, because Wrangler turns workers.dev
*off* by default as soon as any route exists. `edge/tools/site.mjs` reads the
hostname from that same entry for the canonical links, so wrangler.toml is the
only place it is written.

One-time setup, in this order — **the first deploy after the custom-domain
entry fails until step 2 is complete**, because a Custom Domain can only be
created on an active zone:

1. **Add the zone.** Cloudflare dashboard → Add a domain → `rhengtl.tech` →
   Free plan. Cloudflare imports the existing DNS records and shows two
   nameservers. Do **not** create a record for `contex` — the Custom Domain
   makes its own, and an existing CNAME there blocks it.
2. **Point the domain at Cloudflare.** get.tech control panel → the domain →
   Name Servers → replace the four `*.orderbox-dns.com` entries with the two
   Cloudflare gave. Wait for the zone to show **Active** (usually minutes,
   occasionally hours). `nslookup -type=NS rhengtl.tech` shows the switch.
3. **Authorise the hostname in Firebase** (see [Firebase](#firebase)): add
   `contex.rhengtl.tech` to Authorized domains and keep
   `contex.rhengtl.workers.dev` there too.
4. **Check the deploy token can reach the zone.** The token's *Zone
   Resources* must include `rhengtl.tech` (or all zones) with *Workers Routes:
   Edit*. A token scoped before the zone existed may not cover it. If the
   deploy then fails while creating the domain, add *DNS: Edit* for the zone.
5. **Deploy** — push to `master`, or `npx wrangler deploy` from `edge/`. The
   workflow's last step requires `/` and `/api/session` to answer 200 on
   **both** hosts.

**When the domain lapses** (2027-10-12 unless renewed), the primary stops
resolving and the fallback keeps working. Either renew it, or remove the
`[[routes]]` entry and point `site.mjs` at the workers.dev origin, then
`npm run build:pages` — otherwise the canonical links keep sending crawlers to
a dead name.

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
to this one account and *Zone Resources* including `rhengtl.tech` (the
custom domain is created by the deploy). Add the value as an Actions secret named
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

**Add every deployed hostname to Authorized domains** (Firebase Console →
Authentication → Settings) — today both `contex.rhengtl.tech` and
`contex.rhengtl.workers.dev`. Without it, Google sign-in fails with
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

**Gemini refuses requests by where they come from — so the Worker is pinned.**
Google answers a request from an unsupported region with `400
FAILED_PRECONDITION: User location is not supported for the API use.`, and by
default a Worker runs wherever the visitor was served. For visitors in the
Philippines that is often Hong Kong, which Gemini does not serve: on 2026-10-12
every page upload from there was refused and those users never reached the AI
at all. `[placement] region = "gcp:us-central1"` in `edge/wrangler.toml` runs
the Worker beside Google in the US instead, so its requests always leave from a
supported country. It costs a visitor far from the US one extra round trip on
API calls only — static assets are still served from the nearest data centre.

If this ever recurs, `wrangler tail` or the dashboard's Workers Logs show
`page upload refused (400)` with that message. The browser no longer walks the
model chain on a failed upload (no model saw the page), and the fallback notice
says *"The page could not be sent to the AI conversion service"* rather than
blaming the models.

**The first preview on a device downloads ~10.6 MB.** The engine's format
file is 10.36 MB and is served uncompressed — `.fmt` is an extension the edge
does not recognise, so it gets no content type and no compression (the
reasoning and two rejected workarounds are in `edge/public/_headers`). The
`immutable` cache headers make it a once-per-device cost.

That download used to happen *inside* the compile, one synchronous request at
a time, so a phone under ~0.8 Mbps got "Compilation timed out after 120s" on a
document TeX builds in half a second — and every Reload restarted the download.
`edge/public/latex/compile.js` now downloads the files every document needs
before compiling (with progress, a 30 s stall limit and a 10-minute cap, and it
keeps what arrived for a retry), starts that download when a conversion begins,
and hands the files to the engine through the `preload` command patched into
it by `edge/tools/patch-engine.mjs`. The 120 s compile deadline now measures
TeX alone. Measured on an emulated phone at 0.7 Mbps: the preview renders,
TeX takes ~0.3 s, and the rest is the one-time download. `npm run test:compile`
holds it there.

Every compile logs one line to the browser console —
`[compile] <outcome> phase=… total=…ms engine=…ms tex=…ms bytes=…` — with no
document text in it, so a report from a slow device says where the time went.

## Rolling back

`wrangler deployments list` shows the versions; `wrangler rollback [id]`
returns to one. Assets are versioned with the Worker, so a rollback takes the
matching asset tree with it.
