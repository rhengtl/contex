/**
 * ConTeX edge Worker -- the API surface.
 *
 * Everything here is metered against the 100,000 requests/day free allowance,
 * so it holds only what genuinely needs a secret, a shared counter or a
 * decision a client must not be trusted to make. Static assets never reach
 * this code: `run_worker_first` is off, so Pages serves them directly, free
 * and unmetered (spec section 16).
 *
 * Route parity with the Flask app:
 *   POST /api/convert/page       <- the conversion half of web/convert.py
 *   GET  /api/ai-status          <- convert.py ai_status_route()
 *   GET  /api/session            <- session.py shell_context() + terms_accepted()
 *   POST /api/session/terms      <- pages.py accept_terms()
 *   POST /api/auth/login         <- auth.py login()
 *   POST /api/auth/signup        <- auth.py signup()
 *   POST /api/auth/forgot        <- auth.py forgot_password()
 *   POST /api/auth/logout        <- auth.py logout()
 *   GET  /api/history            <- pages.py history_page()
 *   POST /api/history            <- the record_history() call inside convert.py
 *   GET  /api/history/:id        <- output.py history_tex()
 *   GET  /api/history/:id/download <- output.py history_download()
 *
 * WHY THE AUTH ROUTES ARE JSON AND NOT REDIRECTS. Flask rendered a template
 * and redirected; the frontend here is a static page that never round-trips.
 * The answers are the same answers -- same wording, same status codes, same
 * refusal to say whether an address is registered -- delivered as JSON to a
 * page that renders them itself.
 *
 * The error strings below are copied from the Python routes rather than
 * rewritten. They are user-visible behaviour, and parity includes the words.
 */

import { withSecurityHeaders, makeNonce } from './security.js';
import {
  loadSession, sign, setCookie, clearCookie, emptySession, startSession,
  currentUserUid, termsAccepted, termsAcceptedInSession, shellContext,
  termsVersion, MAX_UPLOAD_MB,
} from './session.js';
import { rateLimited } from './ratelimit.js';
import { convertPage, aiStatus } from './gemini.js';
import { verifyUser, createUser, sendPasswordReset, verifyIdToken } from './accounts.js';
import * as history from './history.js';

export { RateLimiter } from './ratelimit.js';

// The body is the page's raw bytes now, not base64 of them, so the 4/3
// inflation this used to allow for is gone -- see the note in gemini.js. It is
// the same limit app.py sets with MAX_CONTENT_LENGTH.
const MAX_BODY_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

function json(body, status = 200, extraHeaders) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (extraHeaders) for (const [k, v] of extraHeaders) headers.append(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Issue the session cookie alongside a JSON answer. */
async function withSession(env, session, body, status = 200) {
  const headers = new Headers();
  setCookie(headers, await sign(session, env.SESSION_HMAC_KEY),
            { remember: session.remember });
  return json(body, status, headers);
}

// The most JSON any route here has a reason to receive. The largest honest
// body is a history save: 60 KB of LaTeX before truncation, and a document
// that runs long is still well under this. Anything bigger is parsed into
// memory for nothing -- request.json() buffers the lot -- so it is refused by
// its declared length before a byte is read.
const MAX_JSON_BYTES = 1024 * 1024;

// The longest file name a history row keeps. Long enough for any real name;
// short enough that a name cannot be the payload.
const MAX_FILENAME_CHARS = 200;

class TooLarge extends Error {}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_JSON_BYTES) throw new TooLarge();
  try { return (await request.json()) || {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function login(request, env, session) {
  // Same allowance as security.py's 'auth' group. Checked before anything
  // touches the network, so a password-guessing loop costs the guesser and
  // not the identity service.
  const brake = await rateLimited(env, request, session, 'auth');
  if (brake.limited) {
    return json({ error: 'Too many sign-in attempts. Please wait a few ' +
                         'minutes and try again.', retryAfter: brake.retryAfter }, 429);
  }

  const form = await readJson(request);

  // A Firebase ID token, from the Google sign-in the browser SDK ran.
  if (form.idToken) {
    const user = await verifyIdToken(env, form.idToken);
    if (!user) return json({ error: 'Authentication failed' }, 401);

    // Federated users never pass through sign-up, so make sure they still have
    // a users/ profile document -- every later read of users/{uid} assumes one.
    await history.upsertProfile(env, user.uid, user.email, user.displayName);

    // auth.py passes remember=True for the federated path.
    const next = startSession(user.uid, user.email, user.displayName, true);
    return withSession(env, next, {
      ok: true, ...shellContext(next, false, env),
    });
  }

  const email = form.email;
  const password = form.password;
  if (!email || !password) {
    return json({ error: 'Please provide email and password' }, 400);
  }

  const result = await verifyUser(env, email, password);
  if (!result.success) {
    return json({ error: result.error || 'Invalid credentials' }, 401);
  }

  const { user } = result;
  await history.upsertProfile(env, user.uid, user.email, user.displayName);
  const next = startSession(user.uid, user.email, user.displayName,
                            !!form.remember);
  return withSession(env, next, { ok: true, ...shellContext(next, false, env) });
}

async function signup(request, env, session) {
  const brake = await rateLimited(env, request, session, 'auth');
  if (brake.limited) {
    return json({ error: 'Too many sign-in attempts. Please wait a few ' +
                         'minutes and try again.', retryAfter: brake.retryAfter }, 429);
  }

  const form = await readJson(request);
  const { fullname, email, password, confirm_password: confirm, terms } = form;

  // auth.py's validation, in the same order, with the same wording. Server-side
  // rather than only in the page: a check the client can skip is not a check.
  if (!fullname || !email || !password || !confirm) {
    return json({ error: 'All fields are required' }, 400);
  }
  if (password !== confirm) return json({ error: 'Passwords do not match' }, 400);
  // Eight, matching the page's minlength. auth.py said six, which is
  // Firebase's own floor; the form has asked for eight since the port, and a
  // server that accepts less than the page asks for is a server whose check
  // is the weaker of the two.
  if (String(password).length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400);
  }
  if (!terms) {
    return json({ error: 'You must agree to the terms and conditions' }, 400);
  }

  const result = await createUser(env, email, password, fullname);
  if (!result.success) {
    return json({ error: result.error || 'Failed to create account' }, 400);
  }

  // The profile write is part of creating the account rather than a separate
  // step, so an account can never exist without one.
  await history.upsertProfile(env, result.uid, String(email).trim(), fullname);

  // Deliberately NOT signed in, exactly as auth.py answers.
  return json({ ok: true,
                success: 'Account created successfully! Please login.' });
}

async function forgotPassword(request, env, session) {
  // Same allowance as signing in. Without it this form is a free way to send
  // mail to any address, over and over.
  const brake = await rateLimited(env, request, session, 'auth');
  if (brake.limited) {
    return json({ error: 'Too many requests. Please wait a few minutes and ' +
                         'try again.', retryAfter: brake.retryAfter }, 429);
  }
  const { email } = await readJson(request);
  if (!email) return json({ error: 'Please provide your email address' }, 400);

  const result = await sendPasswordReset(env, email);
  if (result.success) {
    // Deliberately the same answer whether or not the address is registered,
    // so this form cannot be used to find out who is.
    return json({ ok: true,
                  success: 'If an account exists with that email, you will ' +
                           'receive a password reset link.' });
  }
  return json({ error: result.error || 'An error occurred' }, 400);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function historyRoutes(url, request, env, session) {
  const uid = currentUserUid(session);
  // Exactly '/api/history' is the collection; anything after the slash names a
  // document, and an empty name does not name one. Flask's '/history/<doc_id>'
  // would not have matched a bare trailing slash either.
  const isCollection = url.pathname === '/api/history';
  const rest = isCollection ? '' : url.pathname.slice('/api/history/'.length);

  // GET /api/history -- the list.
  if (isCollection && request.method === 'GET') {
    // Signed in -> read the persistent list back from Firestore.
    // Guest     -> nothing server-side; the browser holds its own list in
    //              sessionStorage and renders it itself.
    const rows = uid ? await history.recent(env, uid, history.HISTORY_PAGE_LIMIT) : [];
    return json({
      ok: true,
      isAuthenticated: !!uid,
      limit: history.HISTORY_PAGE_LIMIT,
      // Recorded when the row was written. Rows saved before that field
      // existed simply do not claim to be truncated.
      history: rows.map((r) => ({
        id: r.id,
        fileName: r.fileName || '',
        ocrType: r.ocrType || 'convert',
        timestamp: r.timestamp || null,
        truncated: !!r.truncated,
      })),
    });
  }

  // POST /api/history -- record one conversion.
  if (isCollection && request.method === 'POST') {
    // Guests are skipped here exactly as record_history() skips them: their
    // history is kept client-side and never touches Firestore.
    if (!uid) return json({ ok: true, id: null, stored: false });

    const brake = await rateLimited(env, request, session, 'history');
    if (brake.limited) {
      return json({ error: 'That is a lot of conversions in a short time. ' +
                           'Please wait a few minutes and try again.',
                    retryAfter: brake.retryAfter }, 429);
    }
    const body = await readJson(request);
    if (typeof body.tex !== 'string' || !body.tex) {
      return json({ error: 'Nothing to save.' }, 400);
    }
    // Truncation is applied in history.save(), server-side, so the stored
    // length is ours to decide and not the client's to claim. The name is
    // capped here for the same reason.
    const fileName = String(body.fileName || '').slice(0, MAX_FILENAME_CHARS);
    const id = await history.save(env, uid, fileName, 'convert', body.tex);
    return json({ ok: true, id, stored: !!id });
  }

  const parts = rest.split('/');
  const docId = parts[0];

  // GET /api/history/:id -- the LaTeX of one saved conversion, for Copy.
  if (docId && parts.length === 1 && request.method === 'GET') {
    const found = await history.item(env, uid, docId);
    if (!found) return json({ ok: false, error: 'Not found.' }, 404);
    const tex = found.result || '';
    return json({ ok: true, tex,
                  fileName: found.fileName || 'document',
                  truncated: tex.includes(history.TRUNCATION_MARK) });
  }

  // DELETE /api/history/:id -- remove one saved conversion.
  //
  // The Flask app had no self-service delete at all, and its Privacy Policy
  // said so. This adds one, which is a deliberate addition rather than a port:
  // a right the policy already promised (erasure) now has a control instead of
  // an email address. Ownership is enforced in history.remove() by reading the
  // row first -- the service account bypasses firestore.rules, so the rules are
  // defence in depth here and not the check itself.
  if (docId && parts.length === 1 && request.method === 'DELETE') {
    if (!uid) {
      // A guest's history is in their own browser; there is nothing here for
      // them to delete, and saying so would confirm the id exists.
      return json({ ok: false, error: 'Not found.' }, 404);
    }
    const brake = await rateLimited(env, request, session, 'history');
    if (brake.limited) {
      return json({ error: 'Too many requests. Please wait a few minutes and ' +
                           'try again.', retryAfter: brake.retryAfter }, 429);
    }
    const removed = await history.remove(env, uid, docId);
    // A row that is not yours is answered exactly as one that does not exist.
    if (!removed) return json({ ok: false, error: 'Not found.' }, 404);
    return json({ ok: true, id: docId, deleted: true });
  }

  // GET /api/history/:id/download -- the .tex as a file.
  if (docId && parts[1] === 'download' && request.method === 'GET') {
    const found = await history.item(env, uid, docId);
    if (!found) {
      return new Response('That history item was not found.', {
        status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const base = (found.fileName || 'converted').replace(/\.[^.]*$/, '') || 'document';
    return new Response(found.result || '', {
      headers: {
        'content-type': 'application/x-tex',
        'content-disposition':
          `attachment; filename="${base.replace(/[^\w.-]/g, '_')}.tex"`,
      },
    });
  }

  return json({ error: 'Not found.' }, 404);
}

// ---------------------------------------------------------------------------

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const session = await loadSession(request, env);
  const path = url.pathname;

  // -- availability ------------------------------------------------------
  if (path === '/api/ai-status') {
    return json(await aiStatus(env));
  }

  // -- the shell's own context ------------------------------------------
  // What Flask injected into every template through a context processor. A
  // static page cannot be told at render time, so it asks once on load.
  if (path === '/api/session' && request.method === 'GET') {
    const { accepted, cache } = await termsAccepted(env, session);
    const body = shellContext(session, accepted, env);
    if (cache) {
      // Cache it in the session so the next request does not hit Firestore.
      return withSession(env, { ...session, terms: termsVersion(env) }, body);
    }
    return json(body);
  }

  // -- terms gate --------------------------------------------------------
  if (path === '/api/session/terms' && request.method === 'POST') {
    const body = await readJson(request);
    const version = body.version;
    // pages.py accept_terms(): an acceptance of a version we are no longer
    // serving is refused rather than silently upgraded.
    const current = termsVersion(env);
    if (version !== undefined && version !== null && version !== current) {
      return json({ ok: false,
                    error: 'Those terms are out of date. Please reload the page.' },
                  409);
    }
    const next = { ...session, terms: current };
    const uid = currentUserUid(session);
    // A signed-in user's acceptance goes on their profile, so it survives
    // signing out; a guest's lives only in the session.
    if (uid) await history.setTermsAccepted(env, uid, current);
    return withSession(env, next, { ok: true, accepted: true, version: current });
  }

  // -- authentication ----------------------------------------------------
  if (path === '/api/auth/login' && request.method === 'POST') {
    return login(request, env, session);
  }
  if (path === '/api/auth/signup' && request.method === 'POST') {
    return signup(request, env, session);
  }
  if (path === '/api/auth/forgot' && request.method === 'POST') {
    return forgotPassword(request, env, session);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    // Sign out and drop the whole session. auth.py also answers GET here
    // because the header linked to it; this frontend posts, and SameSite=Lax
    // already stops another site from triggering it with the visitor's cookie.
    const headers = new Headers();
    clearCookie(headers);
    return json({ ok: true, ...shellContext(emptySession(), false, env) }, 200, headers);
  }

  // -- history -----------------------------------------------------------
  if (path === '/api/history' || path.startsWith('/api/history/')) {
    return historyRoutes(url, request, env, session);
  }

  // -- conversion --------------------------------------------------------
  if (path === '/api/convert/page') {
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

    // The session's own answer only. A signed-in user whose acceptance lives
    // in Firestore has it cached into the cookie by /api/session, which the
    // page loads first -- so this stays a pure CPU check on the hot path.
    if (!termsAcceptedInSession(session, env)) {
      const { accepted, cache } = await termsAccepted(env, session);
      if (!accepted) {
        return json({
          error: 'Please accept the Terms of Service and Privacy Policy ' +
                 'before converting a document.',
          needsTerms: true,
        }, 403);
      }
      if (cache) session.terms = termsVersion(env);
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

    // A chain index, and it has to survive being anything at all. The first
    // form of this was Math.max(0, Number(...)), and Number('abc') is NaN --
    // which Math.max passes straight through, which `attempt >= usable.length`
    // then answers false to, because every comparison with NaN is false. The
    // request went out to `models/undefined:generateContent`, after paying for
    // an upload. Coerce to a whole number, or start at the top of the chain.
    const rawAttempt = Number(url.searchParams.get('attempt'));
    const attempt = Number.isFinite(rawAttempt)
      ? Math.max(0, Math.floor(rawAttempt)) : 0;
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
      if (err instanceof TooLarge) {
        return withSecurityHeaders(
          json({ error: 'That request is too large.' }, 413), { nonce, env });
      }
      // Mirrors convert.py's catch-all: log the detail, tell the user
      // something they can act on. The conversion wording only on the
      // conversion route: a Firestore hiccup during sign-in used to tell the
      // user their FILE was wrong, which sent them looking in the wrong place.
      console.error('request failed:', err && err.stack || err);
      const converting = new URL(request.url).pathname.startsWith('/api/convert');
      response = json({
        error: converting
          ? 'The conversion failed. Please try a different file.'
          : 'Something went wrong on our side. Please try again.',
      }, 500);
    }
    return withSecurityHeaders(response, { nonce, env });
  },
};
