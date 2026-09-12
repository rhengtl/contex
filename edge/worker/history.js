/**
 * The ocr_history and users collections -- the edge port of
 * contex/data/history.py and contex/data/users.py.
 *
 * Only signed-in users appear here. A guest's history is kept in their
 * browser's sessionStorage and never reaches Firestore -- see the guest
 * history section of public/history.js -- which is what makes "your
 * conversions are not stored" true for guests rather than merely intended.
 *
 * Every read is scoped by uid inside this module rather than trusted from the
 * caller: a document id is guessable enough that fetching by id alone would
 * let any signed-in user read any other user's conversion. That check is here
 * and not in a route for the same reason it was in Python -- a route that
 * forgets it is a route that leaks.
 */

import { configured, getDocument, mergeDocument, deleteDocument, runQuery,
         autoId } from './firebase.js';

// Longest result text stored in a history record (web/session.py).
export const HISTORY_RESULT_LIMIT = 60000;
export const TRUNCATION_MARK = '\n... [truncated]';

// How many saved conversions the history page lists (web/pages.py) -- and,
// since the prune in save(), how many are KEPT. The two are one number on
// purpose: a row the page cannot show is a row its owner cannot see or delete,
// and the Privacy Policy now says exactly this many are retained.
export const HISTORY_PAGE_LIMIT = 20;

// How many surplus rows one save will remove. Ordinarily there is one -- the
// row that just fell off the end -- so this is headroom for a backlog written
// before the prune existed, cleared a slice at a time.
const PRUNE_BATCH = 50;

//: The fields the history list actually renders. Everything else -- the stored
//: LaTeX above all -- is left in Firestore until a route asks for that
//: document. A stored document runs to 60 KB, so fetching twenty of them meant
//: up to a megabyte crossing the network to display none of it.
const LIST_FIELDS = ['fileName', 'timestamp', 'truncated', 'ocrType'];

/**
 * Persist one conversion for signed-in users only.
 *
 * Guests are intentionally skipped: their history is kept client-side in
 * sessionStorage so it disappears with the tab and never touches Firestore.
 * Returns the document id, or null.
 */
export async function save(env, uid, fileName, ocrType, result) {
  // No uid means a guest: their history is never written to Firestore.
  if (!configured(env) || !uid) return null;

  // A whole .tex document can be long; keep history rows a sane size. Done
  // here rather than trusted from the client, exactly as record_history did.
  let text = result || '';
  const truncated = text.length > HISTORY_RESULT_LIMIT;
  if (truncated) text = text.slice(0, HISTORY_RESULT_LIMIT) + TRUNCATION_MARK;

  const id = autoId();
  const ok = await mergeDocument(env, `ocr_history/${id}`, {
    uid,
    fileName: fileName || '',
    ocrType: ocrType || 'convert',
    result: text,
    truncated,
  }, ['timestamp']);
  // A history write must never break the conversion the user came for.
  if (!ok) return null;

  // Keep the newest HISTORY_PAGE_LIMIT and let the rest go. Best effort, and
  // after the save rather than before it: a prune that fails leaves one extra
  // row, which the next save tries again; a save that fails leaves nothing.
  try {
    await prune(env, uid);
  } catch (err) {
    console.error('history prune failed:', err && err.message || err);
  }
  return id;
}

/**
 * Delete this user's rows beyond the newest HISTORY_PAGE_LIMIT.
 *
 * WHY THIS EXISTS. Nothing else bounds what one account can store. The row
 * limit is 60 KB and the brake allows thirty saves in five minutes, so an
 * account that never stopped would put half a gigabyte a day into a project
 * whose free tier holds one -- and when that fills, history stops saving for
 * everyone, silently, because save() is built never to fail a conversion.
 * Trimming to what the page shows makes stored equal visible, and makes the
 * worst case one account holding 1.2 MB.
 *
 * Names only: `select __name__` fetches nothing but the document paths, so
 * the 60 KB documents themselves never cross the wire to be deleted.
 */
async function prune(env, uid) {
  const owned = {
    fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL',
                   value: { stringValue: uid } },
  };
  let surplus;
  try {
    surplus = await runQuery(env, {
      from: [{ collectionId: 'ocr_history' }],
      where: owned,
      select: { fields: [{ fieldPath: '__name__' }] },
      orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
      offset: HISTORY_PAGE_LIMIT,
      limit: PRUNE_BATCH,
    });
  } catch (err) {
    if (!/index/i.test(err.detail || err.message || '')) throw err;
    // The composite index is not deployed. Same fallback as recent(): this
    // user's rows only, ordered here. Timestamps have to come along for the
    // sort, so this costs more than the indexed path -- which is one more
    // reason the index should be deployed.
    const rows = await runQuery(env, {
      from: [{ collectionId: 'ocr_history' }],
      where: owned,
      select: { fields: [{ fieldPath: 'timestamp' }] },
      limit: HISTORY_PAGE_LIMIT + PRUNE_BATCH + 200,
    }) || [];
    rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    surplus = rows.slice(HISTORY_PAGE_LIMIT, HISTORY_PAGE_LIMIT + PRUNE_BATCH);
  }
  for (const row of surplus || []) {
    await deleteDocument(env, `ocr_history/${row.id}`);
  }
}

/**
 * Read one history record, but only if it belongs to this user.
 *
 * The uid check is done here rather than trusted from the request: a document
 * id is guessable enough that fetching by id alone would let any signed-in
 * user read any other user's conversion.
 */
export async function item(env, uid, docId) {
  if (!configured(env) || !uid || !docId) return null;
  // A document id is one path segment. Anything with a slash in it is either
  // a mistake or an attempt to walk into another collection.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) return null;
  const data = await getDocument(env, `ocr_history/${docId}`);
  if (!data) return null;
  if (data.uid !== uid) return null;
  return data;
}

/**
 * Delete one saved conversion, but only if it belongs to this user.
 *
 * Ownership is established by READING THE ROW FIRST, through the same item()
 * that every other read goes through -- not by trusting the id, and not by
 * leaving it to firestore.rules, which the service account bypasses. A row
 * belonging to somebody else is answered exactly as a row that does not exist,
 * so this cannot be used to find out which ids are real.
 *
 * Returns true when the row was this user's and is now gone.
 */
export async function remove(env, uid, docId) {
  const owned = await item(env, uid, docId);
  if (!owned) return false;
  return deleteDocument(env, `ocr_history/${docId}`);
}

/**
 * This user's saved conversions, newest first.
 *
 * Preferred path: ordered server-side, which needs the uid ASC + timestamp
 * DESC composite index declared in firestore.indexes.json. When that index has
 * not been deployed, fall back to fetching only THIS user's rows and ordering
 * them here, so history still works -- still scoped by uid, so it stays
 * private. history.py does exactly this and says why.
 */
export async function recent(env, uid, limit = 10) {
  // Never fall back to "all history" when there is no uid to scope by.
  if (!configured(env) || !uid) return [];

  const owned = {
    fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL',
                   value: { stringValue: uid } },
  };
  const select = { fields: LIST_FIELDS.map((fieldPath) => ({ fieldPath })) };

  try {
    return await runQuery(env, {
      from: [{ collectionId: 'ocr_history' }],
      where: owned,
      select,
      orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
      limit,
    }) || [];
  } catch (err) {
    if (!/index/i.test(err.detail || err.message || '')) {
      console.error('Error getting OCR history:', err.message);
      return [];
    }
    console.log('Notice: ocr_history composite index not ready - sorting in ' +
                'the Worker. Deploy it with: firebase deploy --only firestore:indexes');
    try {
      const rows = await runQuery(env, {
        from: [{ collectionId: 'ocr_history' }],
        where: owned, select, limit: 200,
      }) || [];
      rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      return rows.slice(0, limit);
    } catch (err2) {
      console.error('Error getting OCR history (fallback):', err2.message);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// users/{uid}: a profile, and what version of the terms it accepted
// ---------------------------------------------------------------------------
//
// One document per account, its id IS the uid, and every write here is a merge
// -- so a field this app has not thought of yet cannot be destroyed by a write
// from an older version of it.

/**
 * Create or refresh a user's profile and stamp lastLogin.
 *
 * Email/password users get a profile when they sign up, but federated (Google)
 * users sign in without ever passing through that. This keeps the users/
 * collection consistent for every sign-in method. Never blocks a valid login
 * on a Firestore hiccup.
 */
export async function upsertProfile(env, uid, email, displayName) {
  if (!configured(env) || !uid) return false;

  // createdAt is written only when there is nothing there to preserve.
  //
  // users.py used to include it in every merge, with a comment claiming
  // merge=True would leave an existing value alone. It does not: a merge
  // writes every field it is given, so an account's creation date was really
  // its last login date. Fixed in both implementations; one read is what it
  // costs to be right, and this runs once per sign-in.
  //
  // A row that never got a createdAt at all is healed on the next login. One
  // written before the fix has a date that is wrong rather than missing, and
  // nothing here can recover the true one.
  const existing = await getDocument(env, `users/${uid}`);
  const stamps = existing && existing.createdAt
    ? ['lastLogin'] : ['lastLogin', 'createdAt'];

  return mergeDocument(env, `users/${uid}`, {
    uid, email: email || '', displayName: displayName || '',
  }, stamps);
}

/**
 * Record that this user accepted the terms, so they are not asked again.
 *
 * Stored on the user's own profile document rather than in the session, which
 * is what makes the acceptance survive signing out and back in.
 */
export async function setTermsAccepted(env, uid, version) {
  if (!configured(env) || !uid) return false;
  return mergeDocument(env, `users/${uid}`, { termsAcceptedVersion: version },
                       ['termsAcceptedAt']);
}

/** The terms version this user last accepted, or null. */
export async function getTermsAccepted(env, uid) {
  if (!configured(env) || !uid) return null;
  const profile = await getDocument(env, `users/${uid}`);
  return profile ? (profile.termsAcceptedVersion || null) : null;
}
