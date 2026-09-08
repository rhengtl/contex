/**
 * Who this visitor is, what they have agreed to, and what they may fetch --
 * the Worker half of contex/web/session.py.
 *
 * Three questions every route asks and no route should answer for itself:
 *
 *   who is this?        currentUserUid(), read from the signed session cookie
 *                       and never from the request, so a client cannot name
 *                       another user's id and be believed
 *   may they convert?   termsAccepted(), which uses two stores because the two
 *                       kinds of visitor are genuinely different
 *   is this theirs?     the uid scoping in history.js, which is the rule that
 *                       stops one visitor reading another's document
 *
 * Flask signed the session cookie with itsdangerous; this signs it with
 * HMAC-SHA256 through Web Crypto. The security property is unchanged and is
 * the one that matters. Not encrypted, only signed -- exactly as before.
 * Nothing secret goes in it: a uid, an email, a display name and a terms
 * version, which is what Flask's cookie carried too.
 */

import { getTermsAccepted } from './history.js';

const COOKIE = 'contex_session';

// app.py PERMANENT_SESSION_LIFETIME = 30 days.
const MAX_AGE = 60 * 60 * 24 * 30;

// Bump when the terms or privacy policy change materially. Everyone --
// including users who already accepted an older version -- is then asked
// again. Mirrors session.py TERMS_VERSION; it is deliberately not a date
// alone: the version is what was agreed to.
//
// session.py reads this from configuration, so termsVersion(env) does too:
// setting TERMS_VERSION in [vars] and leaving this constant alone would
// otherwise look like it worked and quietly change nothing.
export const TERMS_VERSION = '2.0-2026-09-08';

export function termsVersion(env) {
  return (env && env.TERMS_VERSION) || TERMS_VERSION;
}

// web/session.py shell_context(): what the application shell needs on every
// page. app.py MAX_CONTENT_LENGTH is derived from the same number.
export const MAX_UPLOAD_MB = 32;

const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function key(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']);
}

export async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(mac)}`;
}

/** Returns the payload, or null if absent, malformed, forged or expired. */
export async function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC', await key(secret), unb64url(mac), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.iat !== 'number' ||
      Date.now() / 1000 - payload.iat > MAX_AGE) return null;
  return payload;
}

export function readCookie(request) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === COOKIE) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Write the session cookie.
 *
 * `remember` is Flask's session.permanent: with it the cookie carries a 30-day
 * Max-Age, without it the browser drops it when it closes. Same two lifetimes
 * as before, chosen by the same checkbox.
 */
export function setCookie(headers, token, { remember = false } = {}) {
  const age = remember ? `; Max-Age=${MAX_AGE}` : '';
  headers.append('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`);
}

/** session.clear(): drop the whole session, and the cookie with it. */
export function clearCookie(headers) {
  headers.append('Set-Cookie',
    `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function emptySession() {
  return { uid: null, email: null, name: null, terms: null, remember: false,
           iat: Math.floor(Date.now() / 1000) };
}

export async function loadSession(request, env) {
  const payload = await verify(readCookie(request), env.SESSION_HMAC_KEY);
  return payload || emptySession();
}

/**
 * Begin a signed-in session, discarding whatever the visitor had before.
 *
 * Everything from the previous session goes -- including the accepted-terms
 * cache. On a shared computer the person signing in is not necessarily the
 * person who was just using it, and inheriting their session is how one
 * visitor ends up holding another's state. session.py clears for the same
 * reason; there it was the generated-result tokens that mattered most.
 */
export function startSession(uid, email, displayName, remember = false) {
  return {
    uid,
    email: email || null,
    name: displayName || null,
    terms: null,
    remember: !!remember,
    iat: Math.floor(Date.now() / 1000),
  };
}

/**
 * The signed-in user's Firebase UID, or null for a guest.
 *
 * Always from the signed cookie, never from the request, so a client cannot
 * target another user's history by forging a uid field.
 */
export function currentUserUid(session) {
  return session && typeof session.uid === 'string' && session.uid ? session.uid : null;
}

/** The session's own answer, with no Firestore round trip. */
export function termsAcceptedInSession(session, env) {
  return session.terms === termsVersion(env);
}

/**
 * True when this visitor has accepted the current terms.
 *
 * Two stores, because the two kinds of visitor are different. A guest has
 * nowhere durable to keep the answer, so it lives in their session and they
 * are asked again next time. A signed-in user's acceptance is on their
 * profile, so it survives signing out -- being asked to re-accept on every
 * login would be noise, not consent.
 *
 * Returns {accepted, cache}: `cache` is true when the answer came from
 * Firestore and the route should write it back into the cookie, which is what
 * session.py does with `session['terms_version'] = TERMS_VERSION` so the next
 * request does not hit Firestore.
 */
export async function termsAccepted(env, session) {
  if (termsAcceptedInSession(session, env)) return { accepted: true, cache: false };
  const uid = currentUserUid(session);
  if (uid && await getTermsAccepted(env, uid) === termsVersion(env)) {
    return { accepted: true, cache: true };
  }
  return { accepted: false, cache: false };
}

/**
 * What the application shell needs on every request -- web/session.py
 * shell_context(), plus the two things a server-rendered template used to
 * carry in its markup and a static page has to ask for.
 */
export function shellContext(session, accepted, env = {}) {
  return {
    isAuthenticated: !!currentUserUid(session),
    displayName: session.name || null,
    email: session.email || null,
    maxUploadMb: MAX_UPLOAD_MB,
    termsVersion: termsVersion(env),
    hasAcceptedTerms: !!accepted,
    firebaseConfig: browserFirebase(env),
  };
}

/**
 * The three Firebase settings the browser SDK needs, or null -- config.py
 * browser_firebase().
 *
 * Public by design: they identify the project, they are not credentials, and
 * the security rules are what actually protect the data. Nothing else from the
 * service account ever reaches a page. Flask injected these into the template;
 * a static page has to ask for them, which is the only thing that changed.
 */
export function browserFirebase(env) {
  const settings = {
    apiKey: env.FIREBASE_API_KEY || '',
    authDomain: env.FIREBASE_AUTH_DOMAIN || '',
    projectId: env.FIREBASE_PROJECT_ID || '',
  };
  return Object.values(settings).every(Boolean) ? settings : null;
}
