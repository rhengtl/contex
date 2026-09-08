/**
 * Accounts: creating them, proving who someone is, and letting them back in.
 * The edge port of contex/services/accounts.py.
 *
 * WHY THIS IS REST AND NOT AN SDK. accounts.py already answers that: the
 * Firebase Admin SDK deliberately cannot check a password -- that is Google's
 * design, not an oversight -- so the two operations that need one go to the
 * Identity Toolkit REST API and Firebase does the comparison. The same
 * reasoning governs the reset link: this project has no way to deliver an
 * email, so it asks Firebase to send its own and the link never touches our
 * server or its logs. Both of those were already HTTP calls in Python, and
 * they are the same HTTP calls here.
 *
 * The one thing that WAS the Admin SDK is verifying a federated ID token
 * (auth.verify_id_token(..., check_revoked=True)). That is done by hand below,
 * and deliberately in both halves the SDK does them in:
 *
 *   signature + claims   RS256 against Google's published JWKS, with iss, aud,
 *                        exp and sub all checked against this project.
 *   revocation           accounts:lookup, which reports `disabled` and
 *                        `validSince` -- the two conditions check_revoked
 *                        exists for.
 *
 * Every failure answer here is deliberately uninformative: "no such user" and
 * "wrong password" are indistinguishable, or the form becomes a way to find
 * out who has an account.
 */

const SIGN_IN_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const SIGN_UP_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:signUp';
const UPDATE_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:update';
const LOOKUP_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
const RESET_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode';
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// Generic message for any credential failure. Deliberately identical for
// "no such user" and "wrong password" so the login form cannot be used to
// enumerate which email addresses are registered.
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// Identity Toolkit error codes that mean "bad credentials" rather than a fault
// on our side. INVALID_LOGIN_CREDENTIALS is what newer projects return when
// email-enumeration protection is enabled; the older split codes are kept for
// projects that still have it turned off.
const CREDENTIAL_ERRORS = new Set([
  'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS',
  'INVALID_EMAIL', 'MISSING_PASSWORD', 'MISSING_EMAIL',
]);

async function post(url, key, body) {
  return fetch(`${url}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // accounts.py passes timeout=15 to requests. Workers have no per-fetch
    // timeout, so this is the equivalent: a hung identity service must not
    // hold the request open indefinitely.
    signal: AbortSignal.timeout(15000),
  });
}

/** The Identity Toolkit error code, stripped of any trailing detail. */
async function errorCode(response) {
  try {
    const body = await response.json();
    return String(body?.error?.message || '').split(':')[0].trim();
  } catch {
    return '';
  }
}

/**
 * Verify a user's email AND password against Firebase Authentication.
 *
 * Returns {success: true, user} or {success: false, error}.
 */
export async function verifyUser(env, email, password) {
  // Fail closed on empty/blank input before touching the network.
  if (!email || !String(email).trim() || !password) {
    return { success: false, error: INVALID_CREDENTIALS_MESSAGE };
  }
  const key = env.FIREBASE_API_KEY;
  if (!key) {
    // Without the Web API key we cannot verify a password. Refuse to sign
    // anyone in rather than falling back to an existence check.
    console.error('FIREBASE_API_KEY is not set - password verification is unavailable.');
    return { success: false,
             error: 'Authentication is not configured. Please contact the administrator.' };
  }

  let response;
  try {
    response = await post(SIGN_IN_ENDPOINT, key, {
      email: String(email).trim(), password, returnSecureToken: true,
    });
  } catch (err) {
    console.error('Error contacting Firebase Auth:', err);
    return { success: false,
             error: 'Could not reach the authentication service. Please try again.' };
  }

  if (!response.ok) {
    const code = await errorCode(response);
    if (CREDENTIAL_ERRORS.has(code)) {
      return { success: false, error: INVALID_CREDENTIALS_MESSAGE };
    }
    if (code === 'USER_DISABLED') {
      return { success: false, error: 'This account has been disabled.' };
    }
    if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
      return { success: false,
               error: 'Too many failed attempts. Please try again later.' };
    }
    if (code === 'CONFIGURATION_NOT_FOUND') {
      console.error('Firebase Authentication is not enabled for this project. ' +
                    'Enable Email/Password sign-in in the Firebase Console.');
      return { success: false,
               error: 'Authentication is not configured. Please contact the administrator.' };
    }
    console.error(`Unexpected Firebase Auth error: ${code || response.status}`);
    return { success: false, error: INVALID_CREDENTIALS_MESSAGE };
  }

  // Password verified by Firebase.
  const payload = await response.json();
  const uid = payload.localId;
  if (!uid) return { success: false, error: INVALID_CREDENTIALS_MESSAGE };

  // Re-read the authoritative record, as accounts.py does with auth.get_user,
  // so a disabled account cannot sign in on a token that was issued anyway.
  const record = await lookup(env, payload.idToken);
  if (!record) {
    console.error('Error loading user record after sign-in.');
    return { success: false, error: INVALID_CREDENTIALS_MESSAGE };
  }
  if (record.disabled) {
    return { success: false, error: 'This account has been disabled.' };
  }

  return { success: true,
           user: { uid: record.localId,
                   email: record.email || String(email).trim(),
                   displayName: record.displayName || '' } };
}

/**
 * Create an account, and give it a display name to go with it.
 *
 * NOTE that "Email already exists" is returned as-is, and that IS an
 * enumeration signal: it tells a stranger whether an address has an account
 * here. accounts.py says the same thing about itself and explains why -- fixing
 * it properly needs an email this project cannot send. Carried over unchanged
 * rather than quietly diverging; see DEPLOYMENT.md.
 */
export async function createUser(env, email, password, displayName) {
  const key = env.FIREBASE_API_KEY;
  if (!key) {
    console.error('FIREBASE_API_KEY is not set - accounts cannot be created.');
    return { success: false,
             error: 'Authentication is not configured. Please contact the administrator.' };
  }
  let response;
  try {
    response = await post(SIGN_UP_ENDPOINT, key, {
      email: String(email).trim(), password, returnSecureToken: true,
    });
  } catch (err) {
    console.error('Error contacting Firebase Auth:', err);
    return { success: false,
             error: 'Could not reach the authentication service. Please try again.' };
  }
  if (!response.ok) {
    const code = await errorCode(response);
    if (code === 'EMAIL_EXISTS') return { success: false, error: 'Email already exists' };
    if (code === 'WEAK_PASSWORD') {
      return { success: false, error: 'Password must be at least 6 characters' };
    }
    if (code === 'INVALID_EMAIL') {
      return { success: false, error: 'Malformed email address' };
    }
    console.error(`Unexpected Firebase sign-up error: ${code || response.status}`);
    return { success: false, error: code || 'Failed to create account' };
  }
  const payload = await response.json();

  // auth.create_user takes display_name in the same call; the REST API has to
  // set it separately, with the token it just issued. A failure here is not
  // worth losing the account over -- the profile write carries the name too.
  if (displayName) {
    try {
      await post(UPDATE_ENDPOINT, key, {
        idToken: payload.idToken, displayName, returnSecureToken: false,
      });
    } catch (err) {
      console.warn('Could not set the display name on a new account:', err);
    }
  }

  // Deliberately NOT signed in: auth.py's signup answers "Account created
  // successfully! Please login." and the token minted above is discarded.
  return { success: true, uid: payload.localId };
}

/**
 * Ask Firebase to email this address a password reset link.
 *
 * Returns {success: true} whether or not the address is registered -- the
 * answer must not reveal which, or the form becomes a way to test whether
 * somebody has an account here. The link itself is never printed, logged or
 * returned to the caller.
 */
export async function sendPasswordReset(env, email) {
  if (!email || !String(email).trim()) return { success: true };

  const key = env.FIREBASE_API_KEY;
  if (!key) {
    console.error('FIREBASE_API_KEY is not set - password reset emails cannot be sent.');
    return { success: false,
             error: 'Password reset is not configured on this server. ' +
                    'Please contact the administrator.' };
  }

  let response;
  try {
    response = await post(RESET_ENDPOINT, key,
                          { requestType: 'PASSWORD_RESET', email: String(email).trim() });
  } catch (err) {
    console.error('Error requesting a password reset email:', err);
    return { success: false,
             error: 'Could not reach the authentication service. Please try again.' };
  }
  if (response.ok) return { success: true };

  const code = await errorCode(response);
  // An unknown address is not an error the user gets to see.
  if (code === 'EMAIL_NOT_FOUND' || code === 'INVALID_EMAIL' || code === 'MISSING_EMAIL') {
    return { success: true };
  }
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
    return { success: false, error: 'Too many requests. Please try again later.' };
  }
  // Log the code, never the address plus the outcome together.
  console.error(`Password reset request failed: ${code || response.status}`);
  return { success: false, error: 'The reset email could not be sent. Please try again.' };
}

/** The account record behind an ID token, or null. */
async function lookup(env, idToken) {
  try {
    const res = await post(LOOKUP_ENDPOINT, env.FIREBASE_API_KEY, { idToken });
    if (!res.ok) return null;
    const payload = await res.json();
    return (payload.users && payload.users[0]) || null;
  } catch (err) {
    console.error('Error looking up a user record:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verifying a federated ID token
// ---------------------------------------------------------------------------

// Google's signing keys, cached for as long as the response says. They rotate
// roughly daily, so refetching per request would be a subrequest spent on
// nothing.
let jwks = null;   // { keys: Map<kid, CryptoKey>, expiresAt }

async function signingKey(kid) {
  const now = Date.now() / 1000;
  if (!jwks || jwks.expiresAt < now || !jwks.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = await res.json();
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
    const keys = new Map();
    for (const jwk of body.keys || []) {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify']));
    }
    jwks = { keys, expiresAt: now + (maxAge ? Number(maxAge[1]) : 3600) };
  }
  return jwks.keys.get(kid) || null;
}

function unb64url(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)),
                         (c) => c.charCodeAt(0));
}

/**
 * Verify a Firebase ID token, the way auth.verify_id_token(check_revoked=True)
 * does. Returns {uid, email, displayName} or null.
 *
 * Both halves matter and both are here. The signature and claims prove the
 * token was minted by Google FOR THIS PROJECT and has not expired; the lookup
 * proves the account is still enabled and the token has not been revoked
 * since. Skipping the second half is the difference between "this was a valid
 * token" and "this is a valid session", and accounts.py asked for the latter.
 */
export async function verifyIdToken(env, idToken) {
  if (!idToken) return null;
  const project = env.FIREBASE_PROJECT_ID;
  if (!project) {
    console.error('FIREBASE_PROJECT_ID is not set - ID tokens cannot be verified.');
    return null;
  }

  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));

    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = await signingKey(header.kid);
    if (!key) return null;

    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, unb64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;

    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== project) return null;
    if (claims.iss !== `https://securetoken.google.com/${project}`) return null;
    if (!claims.sub || typeof claims.sub !== 'string') return null;
    if (!(claims.exp > now) || !(claims.iat <= now + 60)) return null;

    // check_revoked: the account must still be enabled, and the token must not
    // predate the point at which its sessions were invalidated.
    const record = await lookup(env, idToken);
    if (!record) return null;
    if (record.disabled) {
      console.error('Error verifying token: user account is disabled');
      return null;
    }
    const validSince = Number(record.validSince || 0);
    if (validSince && claims.auth_time && claims.auth_time < validSince) {
      console.error('Error verifying token: token has been revoked');
      return null;
    }

    return {
      uid: record.localId || claims.sub,
      email: record.email || claims.email || '',
      displayName: record.displayName || claims.name || '',
    };
  } catch (err) {
    console.error('Error verifying token:', err);
    return null;
  }
}
