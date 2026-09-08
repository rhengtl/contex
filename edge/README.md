# ConTeX on Cloudflare — migration in progress

This directory is the Cloudflare rebuild of ConTeX. **The Python application in
the repository root remains the source of truth** and stays working until every
stage here has been validated against it. Nothing in `contex/` has been changed
or deleted.

Architecture and the evidence behind it: the specification, revision 1.3.

---

## Stage 1 — complete and verified

The Pages shell plus the secured streaming Worker: upload → Worker → Gemini →
`.tex` download, with the terms gate, rate limiting, session cookie and security
headers carried over.

### What maps to what

| Python (source of truth) | Edge | Notes |
|---|---|---|
| `web/convert.py` conversion half | `worker/index.js` `/api/convert/page` | Error strings copied verbatim |
| `convert.py` `ai_status_route()` | `worker/gemini.js` `aiStatus()` | Still never probes the API |
| `recognise/ai.py` `_DIRECT_SYSTEM` | `worker/prompt.js` | Copied character for character |
| `recognise/ai.py` `fenced_latex()` | `gemini.js` / `app.js` | Same last-document-block preference |
| `services/llm/gemini.py` `MODEL_CHAIN` | `worker/prompt.js` | Same four models, same order |
| `services/llm/gemini.py` `_config()` | `gemini.js` `generationConfig()` | temperature 0, 32000 tokens, thinking LOW |
| `services/llm/availability.py` | `gemini.js` outage helpers | File → KV; still **per model**, not per service |
| `web/session.py` cookie + terms | `worker/session.js` | itsdangerous → Web Crypto HMAC |
| `web/security.py` headers/CSP | `public/_headers` + `worker/security.js` | See the two notes below |
| `web/security.py` rate limiting | `worker/ratelimit.js` | Per-process deque → Durable Object |
| `pipeline/inputs.py` `ACCEPTED` | `public/app.js` `ACCEPTED` | Same list, same picker derivation |

### Three deliberate differences

**The model chain loop moved to the browser.** A streamed body cannot be
replayed, so the Worker cannot retry a different model within one invocation
without buffering — which S1 measured as breaching the CPU budget above ~8 MB.
The client re-posts with the next chain index instead. Order and outage
semantics are unchanged; only the location of the loop moved.

**The CSP lost its nonce, and is stronger for it.** The Flask templates carried
inline `<script>` blocks, so the policy needed a per-request nonce to avoid
`'unsafe-inline'`. This frontend has no inline script at all, so `'self'` alone
is stricter — there is nothing for a nonce to authorise. `'wasm-unsafe-eval'`
and `worker-src` are added for the LaTeX engine and the formula model; they
permit WebAssembly, not `eval()`.

**Rate limiting became global.** `security.py` is explicit that it counts inside
one process, so N gunicorn workers gave a caller N times the allowance. The
Durable Object makes the limit the limit.

### Verified

`node scratchpad/stage1-verify.mjs` — 18/18 against a running Worker:

- Terms gate blocks conversion with the original wording; `That file was empty.`
  likewise.
- Session cookie is signed, `HttpOnly`, `Secure`, `SameSite=Lax`.
- CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` present on
  static assets; no COOP/COEP, so the Firebase Auth popup still works.
- **Same benchmark image as the Python pipeline produced identical output** —
  same `\documentclass`, same package set, identical body between
  `\begin{document}` and `\end{document}`.

One real defect was found and fixed by that comparison: the first port omitted
`thinkingConfig`, and the model then emitted an extra `\usepackage{inputenc}`
the Python pipeline did not. Three control runs confirmed the Python side was
consistent, so this was a divergence rather than model noise. Matching
`gemini.py _config()` closed it.

### Not yet migrated

PDF preview and LaTeX validation (Stage 2), Firebase auth and history
(Stage 3), the local fallback and the full UI (Stage 4). Until those land, this
directory is not a replacement for the Python app.

---

## Running it

```bash
cd edge
npm install
# .dev.vars (gitignored):
#   GEMINI_API_KEY=...
#   SESSION_HMAC_KEY=...      # any long random value
npx wrangler dev --port 8788
```

Before a first deploy: create the KV namespace and put the real id in
`wrangler.toml`, then `wrangler secret put GEMINI_API_KEY` and
`wrangler secret put SESSION_HMAC_KEY`.
