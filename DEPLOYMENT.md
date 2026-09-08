# Deploying ConTeX

Everything in this file was prepared and, where it could be, verified before
any deployment existed. Where something genuinely cannot be checked until the
app has a public URL, it is in [After the first deploy](#after-the-first-deploy)
and is **not** described as done.

---

## The one thing to understand first

**This application needs a real machine, not a static host.** It is a Flask
server that shells out to a TeX engine, Tesseract and Poppler, and holds an
ONNX model in memory. Firebase Hosting serves static files and cannot run any
of that.

So it runs as a container on an **Oracle Cloud Ampere VM**, on the Always Free
tier, with Caddy in front of it holding the TLS certificate:

```
  browser  ->  Caddy          :443, Let's Encrypt, renews itself
                  |  reverse_proxy
                  v
              contex          the container this repository builds
                  |
                  +--> Firebase Auth      (identitytoolkit REST)
                  +--> Firestore          (Admin SDK, key file)
                  +--> Gemini API         (server-side key)
```

**Firebase is still here, but only for Auth and Firestore.** Both are free on
the Spark plan and neither needs a credit card. Firebase *Hosting* is not used -
the `hosting` block in `firebase.json` is inert configuration for a path this
deployment does not take, kept because the Dockerfile still builds for Cloud Run
if you ever want it.

Two consequences of running off Google Cloud are worth knowing before you hit
them rather than after.

**There is no ambient identity, so the Admin SDK needs a key file.** On Cloud
Run the process inherited the service account attached to the service and no
private key existed anywhere. On any other machine there is nothing to inherit,
so `FIREBASE_SERVICE_ACCOUNT_PATH` must point at a real Admin SDK key - and that
file grants full administrative access to the Firebase project. Step 5 below
puts it on the box in the one way that is defensible: root-owned, unreadable by
anything but the container's own uid, mounted read-only, and never in git.

**The session cookie is called `__session`.** Caddy does not care, but a caching
CDN would: it cannot key a cache on cookies it does not control, so it strips
them. Firebase Hosting keeps exactly one, named `__session`. Nothing here
depends on the name, so `contex/app.py` uses it and the app stays movable.

---

## Prerequisites

| What | Needed for |
|---|---|
| An Oracle Cloud account | The VM. A card is required for identity verification and is **not charged** for Always Free resources. |
| A DuckDNS account | A free hostname. Let's Encrypt will not issue a certificate for a bare IP address. |
| `firebase` CLI, locally | Applying `firestore.rules` and the index. **15.11.0, present.** |
| Node + a JDK, locally | The Firestore rules suite. **v24.14.0 / OpenJDK 21, present.** |
| Docker, locally | Optional - building the image by hand. **29.4.3, present.** |

You do **not** need `gcloud`, and nothing here uses it.

---

## Standing the server up

Once, by hand. After this, releases are automatic.

### 1. Create the VM

Oracle Cloud Console → **Compute** → **Instances** → **Create instance**.

| Field | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 |
| Shape | `VM.Standard.A1.Flex` — **2 OCPU, 12 GB memory** |
| Boot volume | 50 GB |
| SSH keys | Upload your public key, or let the console generate one and save it |

2 OCPU and 12 GB is the whole of the current Always Free Ampere allowance. The
app needs about 4 GB, so the headroom is deliberate and it is also what keeps
the instance out of the reclamation rule - see [Idle and
reclamation](#idle-and-reclamation).

If you get **Out of capacity**, try another availability domain in the same
region, or retry later. It is the well-known frustration of this tier.

Then **reserve the public IP** so it survives a stop/start: Instance →
**Attached VNICs** → the VNIC → **IPv4 Addresses** → edit the public IP →
**Reserved**. An ephemeral address changes, and your DNS record would then point
at somebody else's machine.

### 2. Open ports 80 and 443, in both places

This is the step everyone does half of.

**In Oracle's virtual network:** Instance → **Virtual cloud network** →
**Security Lists** → the default list → **Add Ingress Rules**, twice:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**On the machine itself.** Oracle's Ubuntu images ship with an iptables
ruleset that rejects everything except SSH, which is independent of the security
list above:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Docker's published ports often traverse `FORWARD` rather than `INPUT` and work
without this, but the rules are harmless when redundant and their absence is
otherwise a silent timeout you will spend an hour on. `netfilter-persistent
save` is what makes them survive a reboot.

Port 80 is not decoration. Let's Encrypt answers its HTTP-01 challenge there,
so closing it means certificates stop renewing about sixty days later.

### 3. Give it a hostname

At <https://www.duckdns.org>, sign in, create a subdomain, and set its IP to
the reserved address from step 1. You get something like
`contex.duckdns.org` at no cost.

Wait for it to resolve before going further - Caddy's certificate request will
fail if the name does not yet point at the machine:

```bash
dig +short contex.duckdns.org      # must print your VM's public IP
```

### 4. Install Docker

On the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit                                # then SSH back in, for the group to apply
```

`get.docker.com` installs the arm64 build and the Compose plugin.

### 5. Put the configuration and the secrets on the box

```bash
sudo mkdir -p /opt/contex
sudo chown "$USER" /opt/contex
git clone https://github.com/rhengtl/contex.git /tmp/contex-src
cp /tmp/contex-src/docker-compose.yml /tmp/contex-src/Caddyfile /opt/contex/
cp /tmp/contex-src/deploy/contex-update.* /tmp/
```

The hostname, for Compose to substitute into the Caddyfile:

```bash
printf 'CONTEX_DOMAIN=contex.duckdns.org\n' > /opt/contex/.env
```

The application's environment. **Type this with a here-document as shown** - a
value passed on a command line lands in your shell history:

```bash
cat > /opt/contex/app.env <<'EOF'
FLASK_SECRET_KEY=
GEMINI_API_KEY=
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=contex-28bfd.firebaseapp.com
FIREBASE_PROJECT_ID=contex-28bfd
FIREBASE_SERVICE_ACCOUNT_PATH=/run/secrets/firebase-adminsdk.json
UPLOAD_FOLDER=/tmp/contex
TRUST_PROXY=true
EOF
chmod 600 /opt/contex/app.env
nano /opt/contex/app.env          # fill in the three empty values
```

Where those three come from:

- `FLASK_SECRET_KEY` — generate a **new** one:
  `python3 -c "import secrets; print(secrets.token_hex(32))"`. The one in your
  local `.env` has lived on a development machine; treat it as compromised for
  production. Whoever knows it can forge a session for any account.
- `GEMINI_API_KEY` — from your local `.env`, or <https://aistudio.google.com/apikey>.
- `FIREBASE_API_KEY` — from your local `.env`. Public by design; it is served to
  every browser that loads the sign-in page.

Then the Admin SDK key. Copy it from your machine - it is the file
`contex-28bfd-firebase-adminsdk-*.json` in your project root, which is gitignored
and must stay that way:

```bash
# from your laptop, in D:/Projects/contex
scp contex-28bfd-firebase-adminsdk-*.json ubuntu@<VM-IP>:/tmp/adminsdk.json
```

```bash
# on the VM
sudo mv /tmp/adminsdk.json /opt/contex/firebase-adminsdk.json
# uid 10001 is the unprivileged `contex` user the Dockerfile creates. Owning it
# to that uid and 400 is what lets the container read it and nothing else on
# the host - including your own login - read it at all.
sudo chown 10001:10001 /opt/contex/firebase-adminsdk.json
sudo chmod 400 /opt/contex/firebase-adminsdk.json
```

### 6. Bring it up

```bash
cd /opt/contex
docker compose up -d
docker compose logs -f            # Ctrl-C when you have seen it settle
```

The first pull is several gigabytes and the first boot loads the ONNX model, so
give it a few minutes. Caddy requests the certificate as soon as the hostname
resolves; `docker compose logs caddy` shows it.

```bash
curl -s https://contex.duckdns.org/healthz
```

`{"ok": true, "revision": "..."}` means you are live.

### 7. Turn on automatic updates

```bash
sudo cp /tmp/contex-update.service /tmp/contex-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now contex-update.timer
systemctl list-timers contex-update.timer
```

Every two minutes this pulls the published image and restarts the app **only if
the digest moved**, so on the overwhelming majority of runs it does nothing and
touches nothing.

### 8. Authorise the domain in Firebase

Firebase Console → **Authentication** → **Settings** → **Authorized domains** →
**Add domain** → `contex.duckdns.org`.

Without this, Firebase Auth refuses to complete a sign-in from the site and
Google sign-in fails with an unauthorised-domain error. The default entries
(`localhost`, `contex-28bfd.firebaseapp.com`, `contex-28bfd.web.app`) do not
cover it.

### 9. Apply the Firestore rules and index

From your machine, in `D:\Projects\contex`:

```bash
npm run test:rules                                          # 28 checks, local emulator
firebase deploy --only firestore:rules,firestore:indexes --project contex-28bfd
```

Deliberately not automated. Publishing rules needs a Google credential, and
arranging one for CI would mean either a service account key in GitHub or a
Workload Identity setup - a lot of moving parts for a file that changes a few
times a year. The release workflow still *tests* the rules on every push, so a
change that breaks them is caught; applying it is one command you run yourself.

The Realtime Database lockdown is the same, and is genuinely once:

```bash
firebase deploy --only database --project contex-28bfd
```

### 10. Verify

```bash
curl -sI https://contex.duckdns.org/ | head -20
```

Look for `HTTP/2 200`, `content-security-policy`, `strict-transport-security`,
`x-content-type-options: nosniff`. Then open the site and sign in.

---

## Automatic deployment from GitHub

```
push to master (touching anything that ships)
      |
      +-- job: test     179 offline checks, all three binaries installed
      +-- job: rules    the Firestore rules, against the real evaluator
      |
      v  both must pass
   job: publish         build linux/arm64, push to ghcr.io
      |
      v  within two minutes
   the VM               contex-update.timer pulls and restarts
      |
      v
   job: verify          poll /healthz until it reports this commit
```

`.github/workflows/deploy.yml` is the whole of it. Nothing is published unless
both suites pass, so a broken commit leaves the running app alone.

**Deployment is pull-based**, which is why there are two jobs after the build.
A workflow that pushed would need an SSH key in GitHub's secret store and port
22 open to GitHub's address ranges, which makes a compromise of CI a compromise
of the server. Instead the machine fetches, and nothing in GitHub can reach it.

The cost of that is that publishing an image proves nothing about the live site,
which is what the `verify` job is for: the Dockerfile stamps the commit into the
image, `/healthz` reports it, and the job polls until the site says the right
thing or ten minutes pass.

### One repository variable

Settings → **Secrets and variables** → **Actions** → **Variables** →
**New repository variable**:

| Name | Value |
|---|---|
| `CONTEX_PUBLIC_URL` | `https://contex.duckdns.org` |

A variable rather than a secret: it is the public address of a public website,
and masking it in the logs would only make a failed release harder to read.
Leave it unset and the `verify` job says so and passes - useful before the
server exists, useless after, so set it.

### Registry

Images go to `ghcr.io/rhengtl/contex`, which is free and unmetered for public
repositories. Two tags are published: `:latest`, which the server follows, and
the commit SHA, which is what makes a rollback possible.

### Rolling back

```bash
# on the VM
cd /opt/contex
sudo systemctl stop contex-update.timer          # or it will pull :latest back
docker compose down
CONTEX_IMAGE=ghcr.io/rhengtl/contex:<good-sha> docker compose up -d
```

Fix master, let the pipeline publish a good `:latest`, then
`sudo systemctl start contex-update.timer`.

---

## Idle and reclamation

**There is no cold start.** The container runs continuously with
`restart: always`, gunicorn loads the ONNX model once at boot, and it stays
resident. A visitor lands on the home page immediately, whether they are the
first that day or the thousandth. This is the whole reason this arrangement
answers the requirement that a serverless host does not.

The one thing that could take the machine away is Oracle's idle-reclamation
policy, and it is worth reading precisely. An Always Free instance is reclaimed
only when **all three** of the following hold across a 7-day window:

- 95th-percentile CPU utilisation below 20%
- network utilisation below 20%
- memory utilisation below 20% (A1 shapes only)

The third one is what protects this app without any help. torch, the ONNX
weights and the TeX toolchain are resident from boot - comfortably more than
20% of 12 GB - so the instance does not meet the definition even when nobody is
using it.

**Deliberately not done: a busy-loop to keep CPU up.** It is the common
workaround, it is what the policy exists to catch, and it burns a shared free
resource to no end. If reclamation ever does become a problem, the honest fix is
upgrading the tenancy to Pay As You Go, which exempts you from the policy and
still bills nothing for Always Free resources.

---

## Running costs

Zero, and worth writing down so it stays that way.

| | |
|---|---|
| Oracle Ampere VM, 2 OCPU / 12 GB | Always Free, no expiry |
| 200 GB block storage, 10 TB/month egress | Always Free |
| GitHub Actions, including arm64 runners | Free and unlimited on public repositories |
| GitHub Container Registry | Free and unmetered for public packages |
| DuckDNS, Let's Encrypt | Free |
| Firebase Auth (50K MAU) and Firestore | Free on the Spark plan, no card |
| Gemini API | Free tier, billed separately if you exceed it |

Nothing here needs the Blaze plan, and no Google Cloud billing account is
involved.


---

## What is already configured and verified

Verified means measured, not assumed.

| Item | State |
|---|---|
| Firestore composite index `uid ASC + timestamp DESC` | **Deployed and live.** Read back from the project with `firebase firestore:indexes`. A real signed-in query ran without falling back to sorting in Python. |
| Firestore security rules | **Tested against the real rules engine** in the emulator: 28 checks, all passing. Verified to bite — 23 of them fail against permissive rules. Not yet deployed; step 9 of [Standing the server up](#standing-the-server-up) applies them. |
| Email/Password sign-in | Enabled in the project. Verified end to end against live Firebase. |
| Google sign-in | Enabled, client ID and secret set. Implemented on both `/login` and `/signup`. |
| Email enumeration protection | **On** in the project. |
| Authorized domains | `localhost`, `contex-28bfd.firebaseapp.com`, `contex-28bfd.web.app` are authorized. **Your DuckDNS hostname is not** - it is none of those, so it has to be added by hand. Step 8 of [Standing the server up](#standing-the-server-up). |
| Cross-user isolation | Verified with two real throwaway accounts: neither could read, download, preview or edit the other's history. Both accounts and all their documents were deleted afterwards; the project is back to zero users. |
| Secrets in git | `.env` and `*.json` are ignored; no service account key or API key is tracked. |
| Secrets in the image | `.dockerignore` excludes `.env`, `*.json`, `.venv`, `bench/`, `brand/` and `uploads/`. |
| Container build (x86) | **Builds, 3.69 GB.** Verified to contain no `.env`, no service account key, no virtualenv, no benchmark corpus - and to contain `pdflatex`, `tesseract`, `pdftoppm`, `pdfinfo` and `gs`. |
| Container build (arm64) | **Dependencies verified, image not yet built.** Every one of the 112 packages in `requirements.txt` resolves to a `manylinux_*_aarch64` wheel - torch, onnx, onnxruntime and optimum included - and no `nvidia-*` wheel is pulled in, because CUDA builds do not exist for this architecture. The first real build happens in CI. |
| The app inside the container | A real AI conversion (Gemini, 10-13s) and a real local-fallback conversion (4.8s) both ran end to end: upload -> LaTeX -> `pdflatex` -> PDF -> page image -> `.tex` download. |
| Fail-closed on a missing secret | Verified in the container: with no `FLASK_SECRET_KEY` the worker refuses to boot and gunicorn shuts down. |
| Security headers | Verified on live responses from the container: CSP, `nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS. |
| Content-Security-Policy | **No `'unsafe-inline'` in `script-src` or `style-src`.** All 40 inline `on*=` handlers were removed in favour of `data-action` plus one delegated listener; the three remaining inline `<script>` blocks carry a per-request nonce. Verified with a browser across 5 viewports and through a real conversion: zero policy violations, every control still works. |
| Error pages | A 404 and an induced 500 render in the application shell and carry no traceback, path, exception type or key. |
| Browser and responsive | 227 checks across 5 viewports (1920, 1366, 768, 360 portrait, 740 landscape) x 5 pages: no sideways scroll, no overflow, no console errors, no failed requests, every control >= 24px, every dialog opens and closes on Escape. |
| LaTeX sandboxing | The file-read path was **demonstrated** before the fix: a canary string from an unrelated file on disk appeared in the rendered PDF. 13 attack shapes are now refused; 7 real document shapes still compile. |

---

## After the first deploy

These need the live URL. **None of them has been tested.**

### 1. The domain you are actually serving from

- **Firebase Console → Authentication → Settings → Authorized domains** — add
  your DuckDNS hostname. Until you do, `signInWithPopup` fails with
  `auth/unauthorized-domain`. This is step 8 of standing the server up, repeated
  here because it is the single most likely thing to be forgotten.
- **The OAuth redirect URI needs no change.** Google sign-in here goes through
  Firebase's own handler on `contex-28bfd.firebaseapp.com`, which Firebase
  created and keeps correct. Your own domain never appears in it.
- **Check the OAuth consent screen is published.** Google Cloud Console →
  *APIs & Services* → *OAuth consent screen*. While it says **Testing**, only
  addresses on the test-user list can sign in and everyone else gets
  `Error 403: access_denied`. The app asks for `email` and `profile` only, so
  publishing needs no review and takes effect immediately.
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

The policy is strict, default-deny, and has no `'unsafe-inline'`, so there is
no slack in it. Everything reachable without signing in has been exercised
under it here with zero violations - but the Google popup has not, because it
needs a real authorized domain. Open the console on the deployed `/login`,
click the Google button, and watch for `Refused to ...`.

If it does trip, the fix is almost certainly a missing origin in `script-src`
or `frame-src`, both of which are built from `FIREBASE_AUTH_DOMAIN`.

### 4. Quota, and what abuse would actually cost

Nothing here can produce a bill: the VM is Always Free and fixed-size, and
Firebase Auth and Firestore are on the Spark plan, which stops rather than
charges. What abuse costs is the **Gemini free tier** - `/convert` is open to
anonymous callers by design and each call is a model request. When that quota is
spent the app says so and falls back to local conversion, which is the behaviour
it was built for.

The ceiling on everything else is the machine: 2 OCPU and 12 GB, and the app
cannot ask for more.

### 5. If abuse appears

The built-in rate limiter counts within **one process** (see below), which on
this deployment is much less of a caveat than it sounds - there is one container
on one machine, so the count is close to global. If it is ever seriously abused,
Caddy can rate-limit at the edge, or put Cloudflare's free proxy in front.

---

## Known limitations, stated plainly

### The multi-instance caveat, which this deployment happens to dodge

A generated result — the `.tex`, its compiled PDF, the page images — is written
to local disk under a random token, and the token is recorded in the visitor's
session cookie (`data/results.py`). A request that lands on a process which
never saw the conversion cannot find it, and the user is told *"That download
link has expired or does not belong to this session."*

**On one container on one machine this cannot happen**, because there is nowhere
else for a request to land. It is written down anyway because it is a property
of `data/results.py`, not of the host: the day this sits behind a load balancer,
or on anything that scales out, it becomes real immediately and the symptom
looks like a random expiry bug rather than an architectural one.

The complete fix is to move the store to shared storage, which is a change to
`data/results.py` rather than a flag. Until something needs it, the results are
short-lived by design (one hour) and the failure is visible and honest rather
than silent or wrong.

### Rate limiting is per process

`_rate_limited()` in `web/` counts requests inside one Python process. Under
gunicorn with 2 workers a caller effectively gets twice the configured
allowance — on this deployment that is the whole of the multiplication, since
there is one container, so the limit is close to the global one it reads as. It
stops a script hammering the service. It is not a defence against a distributed
attacker; that belongs at the edge, in Caddy or a proxy in front.

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

`pipeline/latex/` refuses any generated document containing a primitive that
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

`pipeline/recognise/formulas.py` loads `breezedeus/pix2text-mfr` through `optimum 1.17.1`, which
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
python tests/test_contex.py          # the full suite, no API key needed
npm install && npm run test:rules   # Firestore rules against the emulator
docker build -t contex .      # the production image
```
