/**
 * The presentation layer: dialogs, toasts, the mobile drawer, the legal
 * reader, the clipboard, and the one delegated listener they all hang off.
 *
 * This is sections 3, 9 and 10 of static/scripts.js, carried across. It is
 * separate from app.js for the reason the original kept them at the bottom of
 * one file: every page has this furniture and only one page has a converter,
 * so the furniture cannot depend on the converter existing.
 *
 * Nothing here knows anything about conversion. app.js and the page modules
 * register their own actions with `on()`.
 */

export const el = (id) => document.getElementById(id);

export function setText(id, value) {
  const element = el(id);
  if (element) element.textContent = value || '';
}

/** Show or hide, by the class the stylesheet uses rather than the attribute. */
export function toggle(id, shown) {
  const element = typeof id === 'string' ? el(id) : id;
  if (element) element.classList.toggle('hidden', !shown);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
//
// For something that happened rather than something that is wrong. Never a
// browser dialog: the Python suite has a test that says this application does
// not use one, and that is still true here.

let toastTimer = null;

export function toast(message) {
  const element = el('toast');
  const text = el('toast-text');
  if (!element || !text) return;
  text.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.classList.add('hidden'); }, 2600);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
//
// Every dialog in the application goes through these, so they can no longer
// differ from one another. Each one previously opened itself by removing
// .hidden and assigning style.display directly, and not one of them could be
// closed with Escape, kept focus inside itself, or gave focus back to whatever
// had opened it.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const open = [];

export function openDialog(id) {
  const dialog = el(id);
  if (!dialog) return null;
  if (open.some((entry) => entry.dialog === dialog)) return dialog;

  open.push({ dialog, restoreTo: document.activeElement });

  dialog.classList.remove('hidden');
  // .dialog centres itself through .is-open; the full-bleed camera and canvas
  // surfaces are laid out by their own utilities and only need display.
  dialog.classList.add(dialog.classList.contains('dialog') ? 'is-open' : 'flex');

  // The page behind must not scroll while something is over it.
  document.documentElement.style.overflow = 'hidden';

  const first = dialog.querySelector('[data-dialog-initial]')
    || dialog.querySelector(FOCUSABLE);
  // After the class change, so the element is actually visible by the time it
  // is asked to take focus.
  if (first) requestAnimationFrame(() => first.focus());
  return dialog;
}

export function closeDialog(id) {
  const dialog = el(id);
  if (!dialog) return;
  const index = open.findIndex((entry) => entry.dialog === dialog);
  const entry = index >= 0 ? open.splice(index, 1)[0] : null;

  dialog.classList.remove('is-open', 'flex');
  dialog.classList.add('hidden');

  if (!open.length) document.documentElement.style.overflow = '';
  if (entry && entry.restoreTo && entry.restoreTo.focus) entry.restoreTo.focus();
}

export function dialogIsOpen(id) {
  const dialog = el(id);
  return !!dialog && open.some((entry) => entry.dialog === dialog);
}

/** True while any dialog is up -- the processing screen asks before it tidies. */
export function anyDialogOpen() { return open.length > 0; }

function topDialog() { return open.length ? open[open.length - 1] : null; }

/**
 * Escape and a backdrop click both mean "close", but what closing means
 * differs: dismissing the outage dialog has to record that the conversion was
 * cancelled, not just hide the box. A module that needs that registers here.
 */
const dismissals = new Map();

export function onDismiss(id, handler) { dismissals.set(id, handler); }

function dismissDialog(id) {
  const handler = dismissals.get(id);
  if (handler) handler();
  else closeDialog(id);
}

// ---------------------------------------------------------------------------
// Confirming something that cannot be undone
// ---------------------------------------------------------------------------
//
// Replaces window.confirm(), which was the one dialog in this application that
// looked and behaved like none of the others.

let confirmHandler = null;

export function confirmAction(title, body, label, onConfirm) {
  const accept = el('confirm-accept');
  const cancel = el('confirm-cancel');
  if (!accept || !cancel) {
    // No dialog on this page: do not silently swallow the action.
    onConfirm();
    return;
  }
  setText('confirm-title', title);
  setText('confirm-body', body);
  accept.textContent = label;
  confirmHandler = onConfirm;
  openDialog('confirm-modal');
}

function resolveConfirm(accepted) {
  const handler = confirmHandler;
  confirmHandler = null;
  closeDialog('confirm-modal');
  if (accepted && handler) handler();
}

onDismiss('confirm-modal', () => resolveConfirm(false));

// ---------------------------------------------------------------------------
// The mobile drawer
// ---------------------------------------------------------------------------

export function sidebarIsOpen() {
  const sidebar = el('mobile-sidebar');
  return !!sidebar && !sidebar.classList.contains('translate-x-full');
}

export function toggleSidebar() {
  const sidebar = el('mobile-sidebar');
  const overlay = el('sidebar-overlay');
  const button = el('menu-button');
  if (!sidebar || !overlay) return;

  const willOpen = !sidebarIsOpen();
  sidebar.classList.toggle('translate-x-full', !willOpen);
  overlay.classList.toggle('hidden', !willOpen);
  document.documentElement.style.overflow = willOpen ? 'hidden' : '';
  if (button) button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');

  if (willOpen) {
    const first = sidebar.querySelector(FOCUSABLE);
    if (first) requestAnimationFrame(() => first.focus());
  } else if (button) {
    // Give the keyboard back to the control that opened it, rather than
    // dropping focus to the top of the document.
    button.focus();
  }
}

// ---------------------------------------------------------------------------
// The legal documents
// ---------------------------------------------------------------------------
//
// A dialog rather than a page, for the reason pages.py gives: the requirement
// is that a user can read the terms WITHOUT LEAVING what they were doing --
// and being asked to accept a document you cannot open is not consent at all.
//
// The fragment is inserted as markup because that is what it is: a static file
// this app ships, not anything a user or a model supplied. Nothing that came
// from a conversion ever goes near innerHTML.

const LEGAL_TITLES = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
const legalCache = new Map();

/** The version in force, stamped into the documents. Set by app.js. */
let termsVersion = null;
export function setTermsVersion(value) { termsVersion = value; }

function stampVersion(body) {
  for (const slot of body.querySelectorAll('[data-terms-version]')) {
    slot.textContent = termsVersion || '—';
  }
}

export async function openLegal(which) {
  if (which !== 'terms' && which !== 'privacy') return;
  const modal = el('legal-modal');
  const body = el('legal-body');
  if (!modal || !body) return;

  setText('legal-title', LEGAL_TITLES[which]);
  openDialog('legal-modal');

  if (legalCache.has(which)) {
    body.innerHTML = legalCache.get(which);
    stampVersion(body);
    return;
  }
  body.innerHTML = '<p class="text-sm text-ink-500">Loading&hellip;</p>';

  try {
    const response = await fetch(`/legal/${which}.html`);
    if (!response.ok) throw new Error('unavailable');
    legalCache.set(which, await response.text());
    body.innerHTML = legalCache.get(which);
    stampVersion(body);
  } catch {
    body.innerHTML = '<div class="note-alarm"><p class="note-title">'
      + 'This document could not be loaded</p><p>Please check your '
      + 'connection and try again.</p></div>';
  }
}

export function closeLegal() { closeDialog('legal-modal'); }

onDismiss('legal-modal', closeLegal);

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

export function writeClipboard(text, button) {
  const done = () => {
    toast('LaTeX copied to clipboard.');
    if (button) {
      const original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1600);
    }
  };
  const failed = () => toast('Could not copy. Select the text and copy it manually.');

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, failed);
    return;
  }
  // The Clipboard API needs a secure context; this path covers plain http://.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    if (ok) done(); else failed();
  } catch {
    failed();
  }
}

// ---------------------------------------------------------------------------
// One delegated listener
// ---------------------------------------------------------------------------
//
// Not a micro-optimisation. The legal dialog fetches a document and drops the
// markup straight into the page, and that markup contains a control of its own
// -- the Privacy Policy link inside the Terms. Anything bound at load would
// miss it. Delegation catches it because the listener is on the document.
//
// A handler returning exactly false calls preventDefault(), which is how the
// "open in a new tab" link keeps its real href as the fallback.

const CLICK = Object.create(null);
const CHANGE = Object.create(null);

/** Register one or many actions: on('legal', fn) or on({ legal: fn }). */
export function on(name, handler, kind = 'click') {
  const table = kind === 'change' ? CHANGE : CLICK;
  if (typeof name === 'object') Object.assign(table, name);
  else table[name] = handler;
}

function runAction(table, event) {
  const element = event.target.closest && event.target.closest('[data-action]');
  if (!element) return;
  const handler = table[element.getAttribute('data-action')];
  if (!handler) return;
  // Exactly false, not merely falsy: a handler that returns nothing is the
  // common case and must not cancel the event.
  if (handler(element, event) === false) event.preventDefault();
}

document.addEventListener('click', (event) => runAction(CLICK, event));
document.addEventListener('change', (event) => runAction(CHANGE, event));

/* A click on the backdrop itself - not on the panel sitting on it. */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target.classList || !target.classList.contains('dialog')) return;
  const top = topDialog();
  if (top && top.dialog === target) dismissDialog(target.id);
});

document.addEventListener('keydown', (event) => {
  const top = topDialog();

  if (event.key === 'Escape') {
    if (top) {
      event.preventDefault();
      dismissDialog(top.dialog.id);
    } else if (sidebarIsOpen()) {
      event.preventDefault();
      toggleSidebar();
    }
    return;
  }

  if (event.key !== 'Tab' || !top) return;

  // Keep focus inside the dialog. Without this, tabbing walks straight out
  // into the page behind it, which is still there and still full of controls
  // the reader cannot see.
  const items = Array.prototype.filter.call(
    top.dialog.querySelectorAll(FOCUSABLE),
    (element) => element.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

on({
  'toggle-sidebar': () => toggleSidebar(),
  legal: (element) => openLegal(element.dataset.arg),
  'legal-close': () => closeLegal(),
});

const accept = el('confirm-accept');
const cancel = el('confirm-cancel');
if (accept) accept.addEventListener('click', () => resolveConfirm(true));
if (cancel) cancel.addEventListener('click', () => resolveConfirm(false));
