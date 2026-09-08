/**
 * Who this visitor is and what they have agreed to -- the Worker half of
 * contex/web/session.py.
 *
 * Flask signed the session cookie with itsdangerous; this signs it with
 * HMAC-SHA256 through Web Crypto. The security property is unchanged and is
 * the one that matters: the uid is read only from the signed cookie and never
 * from the request, so a client cannot name another user's id and be believed.
 *
 * Not encrypted, only signed -- exactly as before. Nothing secret goes in it.
 */

const COOKIE = 'contex_session';
const MAX_AGE = 60 * 60 * 24 * 30;

// Bump when the terms or privacy policy change materially. Mirrors
// session.py TERMS_VERSION; it is deliberately not a date alone -- the version
// is what was agreed to.
export const TERMS_VERSION = '1.0-2026-08-24';

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

export function setCookie(headers, token) {
  headers.append('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`);
}

export async function loadSession(request, env) {
  const payload = await verify(readCookie(request), env.SESSION_HMAC_KEY);
  return payload || { uid: null, terms: null, iat: Math.floor(Date.now() / 1000) };
}

/**
 * True when this visitor has accepted the current terms.
 *
 * Guests keep the answer in their session, so they are asked again next time.
 * A signed-in user's acceptance lives on their profile in Firestore and is
 * cached here -- that half arrives with the auth stage; until then a signed-in
 * user is treated the same as a guest, which is the safe direction.
 */
export function termsAccepted(session) {
  return session.terms === TERMS_VERSION;
}

export function currentUserUid(session) {
  return session && typeof session.uid === 'string' ? session.uid : null;
}
