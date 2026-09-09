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

import { el, toggle, toast, writeClipboard, confirmAction } from '/ui.js';

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

// ---------------------------------------------------------------------------
// The history page
// ---------------------------------------------------------------------------
//
// templates/history.html rendered the signed-in list on the server and left
// only the guest list to scripts.js. Both are built here, by the same
// function, because the two lists offer the same actions and the only real
// difference is where the .tex comes from.
//
// Every class below is a whole literal string. Tailwind's scanner reads this
// file (see `content` in tailwind.config.cjs) and a class assembled by
// concatenation at runtime is invisible to it -- it would ship with no styling
// at all, and nothing would fail until someone looked at the page.

/** One <li>, the shape templates/history.html gave it. */
function renderItem(row, actions) {
  const item = document.createElement('li');
  item.className = 'p-4 sm:p-5';
  item.dataset.historyId = row.id;

  const head = document.createElement('div');
  head.className = 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1';

  const name = document.createElement('h2');
  name.className = 'min-w-0 flex-1 truncate font-poppins text-[0.9375rem] font-medium text-ink-900';
  name.textContent = row.fileName || 'document';
  name.title = row.fileName || 'document';
  head.appendChild(name);

  if (row.timestamp) {
    const when = document.createElement('time');
    when.className = 'flex-shrink-0 text-xs tabular-nums text-ink-400';
    when.dateTime = row.timestamp;
    when.textContent = formatWhen(row.timestamp);
    head.appendChild(when);
  }
  item.appendChild(head);

  if (row.truncated) {
    const note = document.createElement('div');
    note.className = 'note-caution mt-3';
    const title = document.createElement('p');
    title.className = 'note-title';
    title.textContent = 'Saved copy is incomplete';
    const body = document.createElement('p');
    body.textContent = 'This document was too long to store in full, so the '
      + 'saved copy is truncated and cannot be rendered.';
    note.append(title, body);
    item.appendChild(note);
  }

  const bar = document.createElement('div');
  bar.className = 'mt-3 flex flex-wrap gap-2';
  for (const button of actions) bar.appendChild(button);
  item.appendChild(bar);

  const panel = document.createElement('div');
  panel.className = 'mt-3 hidden overflow-hidden rounded-md border border-paper-300';
  // A stable hook. Everything else on this row is a design class that may be
  // restyled; the preview panel is addressed by tests and has to keep a name.
  panel.dataset.preview = row.id;
  item.appendChild(panel);
  return { item, panel };
}

function actionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => onClick(button));
  return button;
}

/**
 * Draw the page.
 *
 * Signed in -> the persistent list, read back through the Worker.
 * Guest     -> nothing server-side; the browser holds its own list in
 *              sessionStorage and renders it here.
 *
 * `preview` is how a row compiles its document. It is passed in rather than
 * imported so this module never pulls in the LaTeX engine: the history page
 * would otherwise load a 12 MB compiler to show a list of file names.
 */
export async function renderPage(shell, { preview } = {}) {
  const list = el('history-list');
  if (!list) return;

  const signedIn = !!shell.isAuthenticated;
  toggle('history-intro-auth', signedIn);
  toggle('history-intro-guest', !signedIn);
  list.replaceChildren();

  let rows;
  if (signedIn) {
    const saved = await fetchSaved();
    rows = (saved.history || []).map((row) => ({ ...row, saved: true }));
    if (saved.limit && el('history-limit')) {
      el('history-limit').textContent = String(saved.limit);
    }
  } else {
    rows = read().map((entry, index) => ({
      id: `guest-${index}`, index, fileName: entry.fileName, timestamp: entry.at,
      result: entry.result, truncated: false, saved: false,
    }));
  }

  toggle(list, rows.length > 0);
  toggle('history-empty-auth', signedIn && rows.length === 0);
  toggle('history-empty-guest', !signedIn && rows.length === 0);
  toggle('guest-history-clear', !signedIn && rows.length > 0);

  for (const row of rows) {
    // A saved row's LaTeX is not in the list -- pages.py fetched only the
    // fields it rendered, because a stored document runs to 60 KB and twenty
    // of them is a megabyte crossing the network to display none of it.
    const getTex = async () => {
      if (!row.saved) return { tex: row.result, truncated: false };
      const found = await fetchSavedTex(row.id);
      return found || { tex: '', truncated: false };
    };

    const actions = [];

    actions.push(actionButton('Download .tex', 'btn-secondary btn-sm', async () => {
      const { tex } = await getTex();
      const base = (row.fileName || 'converted').replace(/\.[^.]*$/, '') || 'document';
      const url = URL.createObjectURL(new Blob([tex || ''], { type: 'application/x-tex' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${base}.tex`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }));

    actions.push(actionButton('Copy LaTeX', 'btn-secondary btn-sm', async (button) => {
      const { tex, truncated } = await getTex();
      writeClipboard(tex || '', button);
      if (truncated) toast('Copied - note this saved copy was truncated.');
    }));

    const previewButton = actionButton('Preview PDF', 'btn-quiet btn-sm', () => {});
    if (row.truncated) previewButton.disabled = true;
    actions.push(previewButton);

    // Deleting your own conversion. The Flask app had no such control and its
    // Privacy Policy said so; this is the erasure right with a button on it.
    // The Worker re-checks that the row is yours whatever is sent from here.
    actions.push(actionButton(
      'Delete',
      'btn-quiet btn-sm text-burgundy-600 hover:bg-burgundy-100 hover:text-burgundy-700',
      (button) => confirmAction(
        'Delete this conversion?',
        `"${row.fileName || 'document'}" will be removed for good. This cannot be undone.`,
        'Delete for good',
        async () => {
          button.disabled = true;
          if (row.saved && !(await deleteSaved(row.id))) {
            button.disabled = false;
            toast('That conversion could not be deleted. Please try again.');
            return;
          }
          if (!row.saved) removeGuest(row.index);
          await renderPage(shell, { preview });
        })));

    const { item, panel } = renderItem(row, actions);

    previewButton.addEventListener('click', async () => {
      if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        panel.replaceChildren();
        previewButton.textContent = 'Preview PDF';
        return;
      }
      panel.classList.remove('hidden');
      previewButton.textContent = 'Hide preview';
      panel.replaceChildren();
      const { tex, truncated } = await getTex();
      if (truncated) {
        // output.py refuses to compile a stored document that was cut short,
        // and says so rather than showing a broken preview.
        const note = document.createElement('div');
        note.className = 'note-alarm';
        note.textContent = 'This saved document was too long to store in full, '
          + 'so it cannot be compiled. Convert the original again to get a '
          + 'complete .tex.';
        panel.appendChild(note);
        return;
      }
      if (preview) await preview(tex, panel);
    });

    list.appendChild(item);
  }

  const clearButton = el('guest-history-clear');
  if (clearButton && !clearButton.dataset.bound) {
    clearButton.dataset.bound = 'yes';
    clearButton.addEventListener('click', () => confirmAction(
      'Clear this session’s history?',
      'The conversions listed here will be removed from this tab. The '
      + 'documents themselves are not stored anywhere else.',
      'Clear history',
      async () => {
        clear();
        await renderPage(shell, { preview });
        toast('Session history cleared.');
      }));
  }
}
