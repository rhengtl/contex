/**
 * History storage bounds, through the real Worker handler.
 *
 *     node tests/history.mjs
 *
 * WHAT THIS EXISTS TO PROVE. /api/history is the one route that lets a client
 * put bytes into the project's storage, and storage is the one free-tier
 * resource that does not reset each day. Three bounds hold it:
 *
 *   - a user keeps their newest HISTORY_PAGE_LIMIT rows and no more, which
 *     save() enforces by pruning after each write;
 *   - a file name is at most 200 characters;
 *   - a JSON body over 1 MB is refused by its declared length, on every
 *     JSON route, before it is read.
 *
 * HOW. worker/firebase.js speaks the Firestore REST API and mints its own
 * OAuth token from a service account, so both are answered by an in-memory
 * stand-in installed on globalThis.fetch: the token endpoint returns a token,
 * and a tiny document store answers :commit, :runQuery, GET and DELETE the way
 * Firestore does for the shapes this application uses. The service account
 * carries a real RSA key generated on the spot, so the JWT is really signed.
 *
 * The store can be told to behave as if the composite index were not deployed
 * (a 400 naming an index for any ordered query), which is the fallback path
 * recent() and prune() share and the one that is easiest to leave broken.
 */

import worker from '../worker/index.js';
import { sign, termsVersion } from '../worker/session.js';
import { HISTORY_PAGE_LIMIT } from '../worker/history.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ' :: ' + detail}`);
};

// ---------------------------------------------------------------------------
// A service account whose key really signs
// ---------------------------------------------------------------------------

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return JSON.stringify({
    type: 'service_account', project_id: 'contex-test',
    client_email: 'suite@contex-test.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  });
}

const ENV = {
  SESSION_HMAC_KEY: 'history-suite-hmac-key',
  GEMINI_API_KEY: 'unused',
  FIREBASE_PROJECT_ID: 'contex-test',
  FIREBASE_SERVICE_ACCOUNT: await serviceAccount(),
};
const CTX = { waitUntil(p) { if (p && p.catch) p.catch(() => {}); } };

// ---------------------------------------------------------------------------
// The Firestore stand-in
// ---------------------------------------------------------------------------

const DOCS_PREFIX = 'projects/contex-test/databases/(default)/documents/';

let store;          // Map<path, fields>
let clock;          // monotonic, so two saves in one millisecond still order
let indexMissing;   // pretend the composite index is not deployed
let calls;          // what the Worker asked for

function resetStore({ withoutIndex = false } = {}) {
  store = new Map();
  clock = Date.parse('2026-09-12T00:00:00Z');
  indexMissing = withoutIndex;
  calls = { commits: 0, queries: 0, deletes: 0, gets: 0 };
}

const plain = (v) => {
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  return null;
};

function runQuery(q) {
  calls.queries += 1;
  if (indexMissing && q.orderBy && q.orderBy.length) {
    return new Response(JSON.stringify({ error: {
      code: 400, status: 'FAILED_PRECONDITION',
      message: 'The query requires an index. You can create it here: https://console.firebase.google.com/...',
    } }), { status: 400 });
  }
  const collection = q.from[0].collectionId;
  let rows = [...store.entries()]
    .filter(([path]) => path.startsWith(`${collection}/`) && path.split('/').length === 2)
    .map(([path, fields]) => ({ path, fields }));
  const filter = q.where && q.where.fieldFilter;
  if (filter) {
    rows = rows.filter((r) => r.fields[filter.field.fieldPath]
      && plain(r.fields[filter.field.fieldPath]) === plain(filter.value));
  }
  if (q.orderBy && q.orderBy.length) {
    const { field, direction } = q.orderBy[0];
    // Firestore drops documents that lack the ordered field.
    rows = rows.filter((r) => r.fields[field.fieldPath]);
    rows.sort((a, b) => {
      const x = plain(a.fields[field.fieldPath]); const y = plain(b.fields[field.fieldPath]);
      return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'DESCENDING' ? -1 : 1);
    });
  }
  if (q.offset) rows = rows.slice(q.offset);
  if (q.limit) rows = rows.slice(0, q.limit);
  const wanted = q.select && q.select.fields.map((f) => f.fieldPath);
  return Response.json(rows.map((r) => {
    let fields = r.fields;
    if (wanted) {
      fields = {};
      for (const name of wanted) if (name !== '__name__' && r.fields[name]) fields[name] = r.fields[name];
    }
    return { document: { name: DOCS_PREFIX + r.path, fields } };
  }));
}

function commit(body) {
  calls.commits += 1;
  for (const write of body.writes) {
    const path = write.update.name.slice(DOCS_PREFIX.length);
    const fields = { ...(store.get(path) || {}) };
    for (const name of write.updateMask.fieldPaths) fields[name] = write.update.fields[name];
    for (const t of write.updateTransforms || []) {
      if (t.setToServerValue === 'REQUEST_TIME') {
        clock += 1000;
        fields[t.fieldPath] = { timestampValue: new Date(clock).toISOString() };
      }
    }
    store.set(path, fields);
  }
  return Response.json({ writeResults: body.writes.map(() => ({})) });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const { host, pathname } = new URL(url);
  if (host === 'oauth2.googleapis.com') {
    return Response.json({ access_token: 'suite-token', expires_in: 3600 });
  }
  if (host !== 'firestore.googleapis.com') throw new Error(`unexpected host ${host}`);
  if (pathname.endsWith(':runQuery')) return runQuery(JSON.parse(init.body).structuredQuery);
  if (pathname.endsWith(':commit')) return commit(JSON.parse(init.body));
  const path = pathname.slice(pathname.indexOf('/documents/') + '/documents/'.length);
  if (init.method === 'DELETE') { calls.deletes += 1; store.delete(path); return Response.json({}); }
  calls.gets += 1;
  const fields = store.get(path);
  if (!fields) return new Response('{}', { status: 404 });
  return Response.json({ name: DOCS_PREFIX + path, fields });
};

// ---------------------------------------------------------------------------
// Driving the handler
// ---------------------------------------------------------------------------

async function cookieFor(uid) {
  const payload = { uid, email: `${uid}@example.com`, name: uid, terms: termsVersion(ENV),
                    remember: false, iat: Math.floor(Date.now() / 1000) };
  return `contex_session=${await sign(payload, ENV.SESSION_HMAC_KEY)}`;
}

async function call(path, { method = 'GET', body, cookie, contentLength } = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers = { cookie: cookie || '' };
  if (raw !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(contentLength ?? Buffer.byteLength(raw));
  }
  const res = await worker.fetch(
    new Request(`https://contex.test${path}`, { method, headers, body: raw }), ENV, CTX);
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

const ownedRows = (uid) => [...store.entries()]
  .filter(([p, f]) => p.startsWith('ocr_history/') && plain(f.uid) === uid)
  .map(([p, f]) => ({ path: p, fileName: plain(f.fileName), at: plain(f.timestamp) }));

async function saveMany(cookie, count, prefix = 'page') {
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const r = await call('/api/history', { method: 'POST', cookie,
      body: { fileName: `${prefix}-${i}.png`, tex: `\\documentclass{article}\\begin{document}${i}\\end{document}` } });
    ids.push(r.json && r.json.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 1. The row cap, with the index deployed
// ---------------------------------------------------------------------------
console.log(`=== a user keeps their newest ${HISTORY_PAGE_LIMIT} rows ===`);
{
  resetStore();
  const alice = await cookieFor('alice');
  const ids = await saveMany(alice, HISTORY_PAGE_LIMIT);
  check(`${HISTORY_PAGE_LIMIT} saves leave ${HISTORY_PAGE_LIMIT} rows`,
        ownedRows('alice').length === HISTORY_PAGE_LIMIT && ids.every(Boolean));
  check('nothing was deleted while under the cap', calls.deletes === 0, String(calls.deletes));

  const [more] = await saveMany(alice, 1, 'extra');
  const rows = ownedRows('alice');
  check('the 21st save still succeeds', !!more);
  check(`and leaves exactly ${HISTORY_PAGE_LIMIT} rows`, rows.length === HISTORY_PAGE_LIMIT, String(rows.length));
  check('the oldest row is the one that went',
        !rows.some((r) => r.fileName === 'page-1.png') && rows.some((r) => r.fileName === 'page-2.png')
          && rows.some((r) => r.fileName === 'extra-1.png'),
        rows.map((r) => r.fileName).join(','));
  check('one delete, not a sweep', calls.deletes === 1, String(calls.deletes));

  const list = await call('/api/history', { cookie: alice });
  check(`GET /api/history lists ${HISTORY_PAGE_LIMIT}, newest first`,
        list.json.history.length === HISTORY_PAGE_LIMIT
          && list.json.history[0].fileName === 'extra-1.png'
          && list.json.history[HISTORY_PAGE_LIMIT - 1].fileName === 'page-2.png');
}

// ---------------------------------------------------------------------------
// 2. Another user's rows are never touched by a prune
// ---------------------------------------------------------------------------
console.log('\n=== the prune is scoped to its owner ===');
{
  resetStore();
  const alice = await cookieFor('alice');
  const bob = await cookieFor('bob');
  await saveMany(bob, 3, 'bob');
  await saveMany(alice, HISTORY_PAGE_LIMIT + 5);
  check("bob's three rows survive alice overflowing", ownedRows('bob').length === 3);
  check(`alice is trimmed to ${HISTORY_PAGE_LIMIT}`, ownedRows('alice').length === HISTORY_PAGE_LIMIT,
        String(ownedRows('alice').length));
  const bobList = await call('/api/history', { cookie: bob });
  check("bob's list is bob's", bobList.json.history.length === 3
        && bobList.json.history.every((r) => r.fileName.startsWith('bob-')));
}

// ---------------------------------------------------------------------------
// 3. A backlog from before the prune existed is worked down
// ---------------------------------------------------------------------------
console.log('\n=== a pre-existing backlog is cleared a slice at a time ===');
{
  resetStore();
  // Seed 90 old rows directly, as if written before the cap.
  for (let i = 1; i <= 90; i++) {
    clock += 1000;
    store.set(`ocr_history/old${i}`, {
      uid: { stringValue: 'carol' }, fileName: { stringValue: `old-${i}.png` },
      ocrType: { stringValue: 'convert' }, result: { stringValue: 'x' },
      truncated: { booleanValue: false },
      timestamp: { timestampValue: new Date(clock).toISOString() },
    });
  }
  const carol = await cookieFor('carol');
  await saveMany(carol, 1, 'new');
  const after1 = ownedRows('carol').length;
  check('one save removes at most one batch (50)', after1 === 91 - 50, String(after1));
  await saveMany(carol, 1, 'new2');
  check(`the next save finishes the job: ${HISTORY_PAGE_LIMIT} left`,
        ownedRows('carol').length === HISTORY_PAGE_LIMIT, String(ownedRows('carol').length));
  check('the newest rows are the ones kept',
        ownedRows('carol').some((r) => r.fileName === 'new-1.png')
          && ownedRows('carol').some((r) => r.fileName === 'new2-1.png')
          && !ownedRows('carol').some((r) => r.fileName === 'old-1.png'));
}

// ---------------------------------------------------------------------------
// 4. The same, with the composite index missing
// ---------------------------------------------------------------------------
console.log('\n=== without the composite index the fallback still trims ===');
{
  resetStore({ withoutIndex: true });
  const dave = await cookieFor('dave');
  await saveMany(dave, HISTORY_PAGE_LIMIT + 3);
  const rows = ownedRows('dave');
  check(`trimmed to ${HISTORY_PAGE_LIMIT} through the unordered path`,
        rows.length === HISTORY_PAGE_LIMIT, String(rows.length));
  check('and it is the oldest three that went',
        !rows.some((r) => /^page-[123]\.png$/.test(r.fileName)) && rows.some((r) => r.fileName === 'page-4.png'),
        rows.map((r) => r.fileName).join(','));
  const list = await call('/api/history', { cookie: dave });
  check('the list still reads back newest first',
        list.json.history.length === HISTORY_PAGE_LIMIT && list.json.history[0].fileName === `page-${HISTORY_PAGE_LIMIT + 3}.png`);
}

// ---------------------------------------------------------------------------
// 5. Field and body bounds
// ---------------------------------------------------------------------------
console.log('\n=== a name and a body have a size ===');
{
  resetStore();
  const erin = await cookieFor('erin');
  const long = 'n'.repeat(500) + '.png';
  const r = await call('/api/history', { method: 'POST', cookie: erin, body: { fileName: long, tex: 'x' } });
  const stored = ownedRows('erin')[0];
  check('a 504-character file name is stored as 200', r.status === 200 && stored && stored.fileName.length === 200,
        stored && String(stored.fileName.length));

  const big = await call('/api/history', { method: 'POST', cookie: erin,
    body: { fileName: 'x', tex: 'y' }, contentLength: 2 * 1024 * 1024 });
  check('a 2 MB history body is refused with 413', big.status === 413 && /too large/i.test(big.json.error),
        `${big.status} ${JSON.stringify(big.json)}`);
  check('and nothing was written', ownedRows('erin').length === 1);

  const bigLogin = await call('/api/auth/login', { method: 'POST',
    body: { email: 'a@b.c', password: 'p' }, contentLength: 2 * 1024 * 1024 });
  check('the same guard covers /api/auth/login', bigLogin.status === 413, String(bigLogin.status));

  const bigTerms = await call('/api/session/terms', { method: 'POST', cookie: erin,
    body: { version: termsVersion(ENV) }, contentLength: 2 * 1024 * 1024 });
  check('and /api/session/terms', bigTerms.status === 413, String(bigTerms.status));

  const ok = await call('/api/history', { method: 'POST', cookie: erin,
    body: { fileName: 'fine.png', tex: 'z'.repeat(70000) } });
  check('a 70 KB body (an honest long document) is still accepted', ok.status === 200 && ok.json.stored);
}

// ---------------------------------------------------------------------------
// 6. Guests store nothing, as before
// ---------------------------------------------------------------------------
console.log('\n=== a guest still stores nothing ===');
{
  resetStore();
  const r = await call('/api/history', { method: 'POST', body: { fileName: 'g.png', tex: 'x' } });
  check('a guest save is acknowledged and not stored', r.status === 200 && r.json.stored === false && store.size === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
