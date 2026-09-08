/**
 * Reaching Firestore from the Worker -- the edge half of
 * contex/services/firebase.py.
 *
 * WHY A SERVICE ACCOUNT AND NOT THE USER'S OWN TOKEN. Because that is what the
 * Python app does, and the property it buys is the one session.py is built on:
 * every uid comes from the signed session cookie, never from the request, so a
 * client cannot name another user's id and be believed. The Admin SDK
 * authenticates with a service account and bypasses the security rules; this
 * does the same thing over REST, and scopes every read by uid in code exactly
 * as data/history.py does. firestore.rules stays as the defence-in-depth layer
 * it already describes itself as.
 *
 * The Admin SDK is not available here -- it is Node, it is large, and it wants
 * a filesystem -- so the two things it actually did are done by hand:
 *
 *   1. sign a JWT with the service account key (RS256, Web Crypto) and trade
 *      it for a Google OAuth2 access token,
 *   2. speak the Firestore REST API.
 *
 * `configured()` is false when no service account is set. Every caller checks
 * it, because a Firebase outage must DEGRADE the app -- guests keep
 * converting, signed-in users lose history -- rather than break it. That is
 * firebase.py's `db is None` contract, kept.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

// One access token per isolate, reused until it is nearly expired. A cold
// isolate mints a new one, which is a single extra subrequest.
let cachedToken = null;   // { token, expiresAt }

function parseServiceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    return sa;
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    return null;
  }
}

export function configured(env) {
  return parseServiceAccount(env) !== null;
}

export function projectId(env) {
  const sa = parseServiceAccount(env);
  return sa ? sa.project_id : (env.FIREBASE_PROJECT_ID || '');
}

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM PKCS#8 -> a Web Crypto RSASSA-PKCS1-v1_5 signing key. */
async function importKey(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * A Google OAuth2 access token for Firestore, minted from the service account.
 * Returns null rather than throwing: no token means no history, not no app.
 */
export async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const sa = parseServiceAccount(env);
  if (!sa) return null;

  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })));
  const body = `${header}.${claim}`;

  try {
    const key = await importKey(sa.private_key);
    const mac = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(body));
    const assertion = `${body}.${b64url(mac)}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      console.error(`Firestore access token refused: ${res.status}`);
      return null;
    }
    const payload = await res.json();
    cachedToken = {
      token: payload.access_token,
      expiresAt: now + (payload.expires_in || 3600),
    };
    return cachedToken.token;
  } catch (err) {
    console.error('Could not mint a Firestore access token:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firestore REST
// ---------------------------------------------------------------------------

function base(env) {
  return `https://firestore.googleapis.com/v1/projects/${projectId(env)}` +
         '/databases/(default)/documents';
}

/** A JS value as a Firestore `Value`. Only the types this app stores. */
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

/** A Firestore `Value` back as a JS value. */
export function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}

export function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

async function call(env, path, init) {
  const token = await accessToken(env);
  if (!token) return null;
  const res = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init && init.headers),
    },
  });
  return res;
}

/** One document, or null when it is absent or unreachable. */
export async function getDocument(env, path) {
  try {
    const res = await call(env, `/${path}`);
    if (!res) return null;
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`Firestore read failed (${res.status}) for ${path}`);
      return null;
    }
    const doc = await res.json();
    return { id: path.split('/').pop(), ...fromFields(doc.fields) };
  } catch (err) {
    console.error(`Error reading ${path}:`, err);
    return null;
  }
}

/**
 * A merge write, with SERVER_TIMESTAMP fields applied by Firestore itself.
 *
 * `fields` is the ordinary data; `serverTimestamps` is a list of field names
 * to stamp with the server's clock. Together they are the REST spelling of
 * `.set({...}, merge=True)` with `firestore.SERVER_TIMESTAMP` values -- an
 * updateMask is what makes it a merge, and a transform is what makes the
 * timestamp the server's rather than the caller's.
 */
export async function mergeDocument(env, path, fields, serverTimestamps = []) {
  const data = {};
  for (const [k, v] of Object.entries(fields)) data[k] = toValue(v);
  const write = {
    update: { name: `projects/${projectId(env)}/databases/(default)/documents/${path}`,
              fields: data },
    updateMask: { fieldPaths: Object.keys(fields) },
  };
  if (serverTimestamps.length) {
    write.updateTransforms = serverTimestamps.map((fieldPath) =>
      ({ fieldPath, setToServerValue: 'REQUEST_TIME' }));
  }
  try {
    const res = await call(env, ':commit', {
      method: 'POST', body: JSON.stringify({ writes: [write] }),
    });
    if (!res) return false;
    if (!res.ok) {
      console.error(`Firestore write failed (${res.status}) for ${path}: ` +
                    (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error writing ${path}:`, err);
    return false;
  }
}

/**
 * Delete one document.
 *
 * The caller has already proved ownership -- this reaches Firestore with the
 * service account, which bypasses the security rules exactly as the Admin SDK
 * did, so the uid check in history.js is the only thing standing between one
 * user and another's row. It is not a formality.
 */
export async function deleteDocument(env, path) {
  try {
    const res = await call(env, `/${path}`, { method: 'DELETE' });
    if (!res) return false;
    // Firestore answers 200 for a delete whether or not the document was
    // there, so this is "it is gone", not "it was there".
    if (!res.ok) {
      console.error(`Firestore delete failed (${res.status}) for ${path}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error deleting ${path}:`, err);
    return false;
  }
}

/**
 * Firestore's own auto-id: 20 characters from the same alphabet the client
 * SDKs use. `collection.add()` generates one client-side too -- an auto-id has
 * never been a server secret, and the ownership check is the uid field, not
 * the id.
 */
const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** A structured query. Returns an array of documents, or null on failure. */
export async function runQuery(env, structuredQuery) {
  try {
    const res = await call(env, ':runQuery', {
      method: 'POST', body: JSON.stringify({ structuredQuery }),
    });
    if (!res) return null;
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      const err = new Error(`Firestore query failed (${res.status}): ${detail}`);
      err.detail = detail;
      err.status = res.status;
      throw err;
    }
    const rows = await res.json();
    return rows
      .filter((r) => r.document)
      .map((r) => ({ id: r.document.name.split('/').pop(),
                     ...fromFields(r.document.fields) }));
  } catch (err) {
    if (err.detail) throw err;   // the caller decides what an index error means
    console.error('Error running a Firestore query:', err);
    return null;
  }
}
