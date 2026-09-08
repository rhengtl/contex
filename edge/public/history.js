/**
 * History, both kinds -- the port of the guest history section of
 * static/scripts.js plus the signed-in list templates/history.html rendered.
 *
 * GUESTS get a temporary history held in sessionStorage:
 *   - it survives moving between the workspace and the history view,
 *   - it is wiped when the page is refreshed,
 *   - the browser drops it entirely when the tab closes.
 * Signed-in users never use this path; their history comes from Firestore,
 * through the Worker, which scopes every read by the uid in the session cookie.
 *
 * What the Privacy Policy promises a guest is that results are cleared when
 * they refresh or close the tab. That is implemented literally, by asking the
 * browser what kind of navigation this was, rather than approximated.
 *
 * ONE THING THE ORIGINAL NEEDED AND THIS DOES NOT. scripts.js also had a
 * `keepGuestHistory` flag, set for exactly one redirect, because a conversion
 * was a POST followed by a redirect back to the workspace -- a real page load
 * that isReload() had to be prevented from mistaking for a refresh. This
 * frontend never reloads on conversion, so there is no hop to protect and no
 * flag to carry. The rule it existed to serve is unchanged: a refresh wipes
 * the list, moving between views does not.
 *
 * The other difference is that an entry no longer carries a server-side token.
 * In Flask the .tex lived on the server and the entry held a token to fetch it
 * with, which expired after an hour; here the document is already in the
 * browser, so the entry holds it outright and Preview and Download keep
 * working for as long as the entry does.
 */

const KEY = 'contex_guest_history';
const MAX_ITEMS = 20;

export function read() {
  try {
    const items = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* private mode / storage disabled - history is simply not kept */
  }
}

export function clear() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/**
 * True only for an actual reload -- F5, the reload button, location.reload.
 * An ordinary link, a typed URL and the back button all report their own
 * navigation types and are not this.
 */
export function isReload() {
  try {
    const entries = performance.getEntriesByType('navigation');
    if (entries && entries.length) return entries[0].type === 'reload';
    // The old interface, for browsers without the Level 2 timeline.
    return !!(performance.navigation && performance.navigation.type === 1);
  } catch {
    return false;
  }
}

/**
 * Apply the contract for this page load, and return the surviving entries.
 *
 * A signed-in user must never see leftovers from an earlier guest session in
 * the same tab, so their list is dropped outright.
 */
export function open({ isAuthenticated }) {
  if (isAuthenticated) { clear(); return []; }
  if (isReload()) clear();
  return read();
}

/** Add one conversion to the guest list, newest first. */
export function add(entry) {
  const items = read();
  items.unshift({
    fileName: entry.fileName || 'document',
    result: entry.result || '',
    at: new Date().toISOString(),
  });
  const kept = items.slice(0, MAX_ITEMS);
  write(kept);
  return kept;
}

/**
 * The same shape the server rendered a saved conversion with -- '%d %b %Y,
 * %H:%M' in templates/history.html -- so the two kinds of history entry do not
 * disagree about what a date looks like.
 */
export function formatWhen(value) {
  if (!value) return '';
  const when = new Date(value);
  if (isNaN(when.getTime())) return value;   // an entry from before this
  try {
    return when.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return when.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * A signed-in user's saved conversions, from Firestore through the Worker.
 * Never falls back to the guest list: the two are different stores answering
 * for different people.
 */
export async function fetchSaved() {
  const res = await fetch('/api/history', { headers: { accept: 'application/json' } });
  if (!res.ok) return { isAuthenticated: false, history: [] };
  return res.json();
}

/** The LaTeX of one saved conversion, for Copy and for the preview. */
export async function fetchSavedTex(id) {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`,
                          { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  return body.ok ? body : null;
}

/**
 * Delete one saved conversion.
 *
 * Only meaningful for a signed-in user: a guest's list is in this browser and
 * is removed from it directly. The Worker re-checks ownership regardless of
 * what is sent from here.
 */
export async function deleteSaved(id) {
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(id)}`,
                            { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Drop one entry from the guest list, by position. */
export function removeGuest(index) {
  const items = read();
  items.splice(index, 1);
  write(items);
  return items;
}

/**
 * Save one conversion.
 *
 * Signed in -> the Worker writes it to Firestore, truncating server-side.
 * Guest     -> sessionStorage only; nothing leaves the browser, which is what
 *              makes "your conversions are not stored" true rather than
 *              merely intended.
 */
export async function record({ isAuthenticated, fileName, tex }) {
  if (!isAuthenticated) return { stored: false, items: add({ fileName, result: tex }) };
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName, tex }),
    });
    // A history write must never break the conversion the user came for.
    if (!res.ok) return { stored: false, items: [] };
    const body = await res.json();
    return { stored: !!body.stored, id: body.id || null, items: [] };
  } catch (err) {
    console.warn('Could not save this conversion to history:', err);
    return { stored: false, items: [] };
  }
}
