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

import { configured, getDocument, mergeDocument, runQuery, autoId } from './firebase.js';

// Longest result text stored in a history record (web/session.py).
export const HISTORY_RESULT_LIMIT = 60000;
export const TRUNCATION_MARK = '\n... [truncated]';

// How many saved conversions the history page lists (web/pages.py).
export const HISTORY_PAGE_LIMIT = 20;

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
  return ok ? id : null;
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
  return mergeDocument(env, `users/${uid}`, {
    uid, email: email || '', displayName: displayName || '',
  }, ['lastLogin', 'createdAt']);
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
