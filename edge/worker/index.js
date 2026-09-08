/**
 * ConTeX edge Worker -- the API surface.
 *
 * Everything here is metered against the 100,000 requests/day free allowance,
 * so it holds only what genuinely needs a secret or a shared counter. Static
 * assets never reach this code: `run_worker_first` is off, so Pages serves
 * them directly, free and unmetered (spec section 16).
 *
 * Route parity with the Flask app:
 *   POST /api/convert/page   <- the conversion half of web/convert.py
 *   GET  /api/ai-status      <- convert.py ai_status_route()
 *   POST /api/session/terms  <- the terms gate in web/session.py
 *
 * The error strings below are copied from convert.py rather than rewritten.
 * They are user-visible behaviour, and parity includes the words.
 */

import { withSecurityHeaders, makeNonce } from './security.js';
import { loadSession, sign, setCookie, termsAccepted, TERMS_VERSION } from './session.js';
import { rateLimited } from './ratelimit.js';
import { convertPage, aiStatus } from './gemini.js';

export { RateLimiter } from './ratelimit.js';

const MAX_UPLOAD_MB = 32;              // app.py MAX_CONTENT_LENGTH
const MAX_BODY_BYTES = Math.ceil(MAX_UPLOAD_MB * 1024 * 1024 * 4 / 3) + 1024;

function json(body, status = 200, extraHeaders) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (extraHeaders) for (const [k, v] of extraHeaders) headers.append(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const session = await loadSession(request, env);

  // -- availability ------------------------------------------------------
  if (url.pathname === '/api/ai-status') {
    return json(await aiStatus(env));
  }

  // -- terms gate --------------------------------------------------------
  // A guest keeps the answer in their session and is asked again next time.
  if (url.pathname === '/api/session/terms' && request.method === 'POST') {
    const next = { ...session, terms: TERMS_VERSION, iat: Math.floor(Date.now() / 1000) };
    const headers = new Headers();
    setCookie(headers, await sign(next, env.SESSION_HMAC_KEY));
    return json({ accepted: true, version: TERMS_VERSION }, 200, headers);
  }

  // -- conversion --------------------------------------------------------
  if (url.pathname === '/api/convert/page') {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
    }

    const brake = await rateLimited(env, request, session, 'convert');
    if (brake.limited) {
      return json({
        error: 'That is a lot of conversions in a short time. ' +
               'Please wait a few minutes and try again.',
        retryAfter: brake.retryAfter,
      }, 429);
    }

    if (!termsAccepted(session)) {
      return json({
        error: 'Please accept the Terms of Service and Privacy Policy ' +
               'before converting a document.',
        needsTerms: true,
      }, 403);
    }

    if (!request.body) {
      return json({ error: 'No file selected.' }, 400);
    }
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared === 0) {
      return json({ error: 'That file was empty.' }, 400);
    }
    if (declared > MAX_BODY_BYTES) {
      return json({
        error: `That file is larger than the ${MAX_UPLOAD_MB} MB limit.`,
      }, 413);
    }

    const attempt = Math.max(0, Number(url.searchParams.get('attempt') || 0));
    const mime = request.headers.get('x-image-mime') || 'image/png';
    const thinking = url.searchParams.get('thinking') !== 'off';
    const result = await convertPage(request, env, ctx, { attempt, mime, thinking });

    if (!result.ok) {
      return json({
        error: result.error,
        retryable: result.retryable,
        nextAttempt: result.retryable ? (result.retryWithoutThinking ? attempt : attempt + 1) : null,
        retryWithoutThinking: !!result.retryWithoutThinking,
        model: result.model || null,
        retryAfter: result.retryAfter || 0,
      }, result.status);
    }

    // Success: pipe the model's reply straight through, unparsed. The browser
    // extracts the fenced block, validates it and compiles it (spec section 4,
    // steps 10-13).
    const headers = new Headers({
      'content-type': 'application/json',
      'x-contex-model': result.model,
    });
    return new Response(result.upstream.body, { status: 200, headers });
  }

  // -- static assets -----------------------------------------------------
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const nonce = makeNonce();
    let response;
    try {
      response = await handle(request, env, ctx);
    } catch (err) {
      // Mirrors convert.py's catch-all: log the detail, tell the user
      // something they can act on.
      console.error('conversion failed:', err && err.stack || err);
      response = json({
        error: 'The conversion failed. Please try a different file.',
      }, 500);
    }
    return withSecurityHeaders(response, { nonce, env });
  },
};
