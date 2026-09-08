/**
 * The ConTeX client.
 *
 * Carries the parts of static/scripts.js and the Flask routes that Stages 1-3
 * cover: the shell context, the terms gate, sign-in, the upload, the page-by-
 * page conversion and merge, the preview, and both kinds of history.
 *
 * Four responsibilities moved here from the server, and each is deliberate:
 *
 *   base64 encoding   so the Worker can stream the body without reading it
 *                     (spec R1/R2). Chunked, because a 19 MB image blows the
 *                     call stack if spread into one apply().
 *   the model chain   a stream cannot be replayed, so the retry loop that
 *                     lived in services/llm/ lives here now. The order and the
 *                     outage semantics are unchanged.
 *   page splitting    run.py _ai_units, so a multi-page PDF is still converted
 *                     a page at a time and a partial conversion still survives.
 *   the merge         latex/documents.py, because the pages it joins are here.
 *
 * What did NOT move: who this visitor is, and whether they may convert. Those
 * are read from the signed session cookie in the Worker and are never the
 * client's to assert. session.py's rule is unchanged.
 */

import { staticValidate } from '/latex/validate.js';
import { compile } from '/latex/compile.js';
import { mergeDocuments } from '/latex/documents.js';
import { renderPdf, downloadPdf } from '/preview.js';
import { aiUnits, checkInput, extensionOf, ACCEPTED } from '/pages.js';
import * as auth from '/auth.js';
import * as history from '/history.js';

const el = (id) => document.getElementById(id);
const state = {
  tex: null, name: null, pdf: null,
  shell: { isAuthenticated: false, hasAcceptedTerms: false, maxUploadMb: 32,
           termsVersion: null, firebaseConfig: null },
  guest: [],
};

function showError(message) {
  const box = el('error');
  box.textContent = message;
  box.hidden = false;
}
function clearError() { el('error').hidden = true; }
function setStatus(message) { el('status').textContent = message || ''; }

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** ai.py fenced_latex(), ported. Prefers the last block that is a document. */
export function fencedLatex(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:latex|tex)?\s*\n([\s\S]*?)```/g)]
    .map((m) => m[1]);
  if (fenced.length) {
    for (let i = fenced.length - 1; i >= 0; i--) {
      if (fenced[i].includes('\\documentclass') ||
          fenced[i].includes('\\begin{document}')) return fenced[i].trim();
    }
    return fenced[fenced.length - 1].trim();
  }
  const m = text.match(/(\\documentclass[\s\S]*?\\end\{document\})/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// The model chain
// ---------------------------------------------------------------------------

/**
 * One conversion's journey through the model chain -- ai.py Rotation.
 *
 * A round is one conversion, however many pages it has. It opens on the
 * preferred model and stays there; when that model reports itself out of quota
 * the round advances and stays advanced for the remaining pages, rather than
 * re-probing an exhausted model once per page. A new conversion builds a new
 * round and opens on the preferred model again.
 */
class Rotation {
  constructor() { this.attempt = 0; this.exhausted = false; this.fatal = ''; }
  advance(to) {
    if (to === null || to === undefined) { this.exhausted = true; return; }
    this.attempt = Math.max(this.attempt, to);
  }
}

/**
 * One page through the Worker.
 *
 * `rotation` is the real round when a quota error is to be believed, and a
 * throwaway one during the speculative concurrent pass -- where a 429 caused
 * by our own burst must not retire a model the service would serve happily one
 * request at a time.
 */
async function convertOne(unit, rotation, { speculative = false } = {}) {
  const base64 = toBase64(unit.bytes.buffer ? unit.bytes.buffer : unit.bytes);
  let attempt = rotation.attempt;
  let thinking = true;

  for (let guard = 0; guard < 10; guard++) {
    const query = `attempt=${attempt}${thinking ? '' : '&thinking=off'}`;
    const res = await fetch(`/api/convert/page?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-image-mime': unit.mime },
      body: base64,
    });
    if (res.ok) {
      const payload = await res.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '').join('') || '';
      const tex = fencedLatex(text);
      if (tex) return { ok: true, tex, model: res.headers.get('x-contex-model') };
      return { ok: false, fatal: true,
               message: 'The conversion failed. Please try a different file.' };
    }

    const err = await res.json().catch(() => ({}));
    if (!err.retryable) {
      return { ok: false, fatal: true,
               message: err.error || 'The conversion failed. Please try a different file.' };
    }
    if (speculative) {
      // Records nothing and moves nothing. A page that fails here is merely
      // not done yet; the sequential pass will decide what it means.
      return { ok: false, message: err.error || '' };
    }
    if (err.nextAttempt === null || err.nextAttempt === undefined) {
      rotation.exhausted = true;
      rotation.fatal = err.error || 'Every AI model has reached its quota.';
      return { ok: false, message: rotation.fatal };
    }
    if (err.retryWithoutThinking) {
      // This model does not accept a thinking level. Drop it once and retry
      // the same model -- gemini.py ask() does exactly this.
      thinking = false;
    } else {
      attempt = err.nextAttempt;
      thinking = true;
      rotation.advance(attempt);
      setStatus(`${err.model || 'That model'} is unavailable — trying the next one…`);
    }
  }
  return { ok: false, message: 'The AI conversion service is temporarily unavailable.' };
}

/** run.py _ai_workers: three by default, never more than there are pages. */
function aiWorkers(count) {
  return count < 2 ? 1 : Math.max(1, Math.min(3, count));
}

/**
 * Convert every unit of a document, in page order -- run.py _convert_units.
 *
 * Pages are independent, so they go out concurrently first. That pass is
 * speculative: a free tier counts requests per minute, and treating a burst's
 * 429 as "this model is finished" would rotate onto a weaker model -- speed
 * bought with accuracy, which is the one trade this pipeline may not make.
 * Whatever is left is retried one at a time through the real round, where a
 * quota error means what it has always meant.
 *
 * Returns {documents, failedAt, reason}: documents in page order up to the
 * first failure, then the page number that failed and why.
 */
async function convertUnits(units, rotation) {
  const done = new Map();
  const workers = aiWorkers(units.length);

  if (workers > 1) {
    const queue = [...units];
    await Promise.all(Array.from({ length: workers }, async () => {
      while (queue.length) {
        const unit = queue.shift();
        // A pinned round: one model, and failures private to it.
        const pinned = new Rotation();
        pinned.attempt = rotation.attempt;
        const page = await convertOne(unit, pinned, { speculative: true })
          .catch(() => ({ ok: false }));
        if (page.ok) done.set(unit.number, page);
        setStatus(`Converting… ${done.size} of ${units.length} pages`);
      }
    }));
  }

  const documents = [];
  for (const unit of units) {
    let page = done.get(unit.number);
    if (!page || !page.ok) {
      if (rotation.exhausted) {
        return { documents, failedAt: unit.number,
                 reason: rotation.fatal || 'Every AI model has reached its quota.' };
      }
      setStatus(`Converting page ${unit.number} of ${units.length}…`);
      // Sequential, through the real round: this is where a quota error is
      // believed and allowed to move the conversion onto another model.
      page = await convertOne(unit, rotation);
    }
    if (!page.ok) {
      return { documents, failedAt: unit.number,
               reason: page.message || 'The AI conversion was unavailable.' };
    }
    documents.push(page.tex);
  }
  return { documents, failedAt: null, reason: '' };
}

// ---------------------------------------------------------------------------
// Converting
// ---------------------------------------------------------------------------

async function run() {
  clearError();
  el('notice').hidden = true;
  const file = el('file').files[0];
  if (!file) { showError('No file selected.'); return; }
  if (file.size === 0) { showError('That file was empty.'); return; }

  const ext = extensionOf(file.name);
  if (ext && !ACCEPTED.has(ext)) {
    showError(`Unsupported file type: '${ext}'`);
    return;
  }
  const limit = state.shell.maxUploadMb;
  if (file.size > limit * 1024 * 1024) {
    showError(`That file is larger than the ${limit} MB limit.`);
    return;
  }

  el('go').disabled = true;
  setStatus('Converting…');
  try {
    // The terms gate. The Worker refuses the conversion without it too -- this
    // is so the user is not told "no" after the upload has already gone.
    if (!state.shell.hasAcceptedTerms) {
      if (!el('accept').checked) {
        throw new Error('Please accept the Terms of Service and Privacy ' +
                        'Policy before converting a document.');
      }
      const accepted = await auth.acceptTerms(state.shell.termsVersion);
      if (!accepted.ok) throw new Error(accepted.error || 'Could not record your acceptance.');
      state.shell.hasAcceptedTerms = true;
      el('terms').hidden = true;
    }

    checkInput(file.name);
    const buf = new Uint8Array(await file.arrayBuffer());
    const units = await aiUnits(buf, file.name, file.type);
    if (units.length > 1) setStatus(`Converting ${units.length} pages…`);

    const rotation = new Rotation();
    const { documents, failedAt, reason } = await convertUnits(units, rotation);

    if (!documents.length) {
      throw new Error(reason || 'The conversion failed. Please try a different file.');
    }

    // Several complete documents, one per page, spliced into one. Four copies
    // of \usepackage{amsmath} compiles with warnings at best, and four
    // \maketitle calls is three spurious title pages.
    const tex = mergeDocuments(documents);
    state.tex = tex;
    state.name = file.name;
    el('tex').textContent = tex;
    el('result').hidden = false;

    if (failedAt !== null) {
      // Never silently truncate. run.py says which page the document ends at
      // and that what is here is unaffected; the local fallback that would
      // convert the rest is Stage 4.
      notice(`Only the first ${documents.length} of ${units.length} pages ` +
             `could be converted.`,
             'The AI stopped part way through, so the document ends at page ' +
             `${documents.length}. What is here is unaffected.`, reason);
    }

    // Save before the preview: a conversion that compiled badly is still the
    // user's transcription, and losing it to a preview failure would be worse
    // than showing no preview.
    const saved = await history.record({
      isAuthenticated: state.shell.isAuthenticated,
      fileName: file.name, tex,
    });
    if (saved.items) state.guest = saved.items;

    // Structural check before the engine, exactly as the pipeline does. Issues
    // are reported but never block the .tex.
    const issues = staticValidate(tex);
    setStatus('Building the preview…');
    await showPreview(tex, issues);
  } catch (err) {
    setStatus('');
    showError(err.message);
  } finally {
    el('go').disabled = false;
  }
}

function notice(headline, detail, reason) {
  const box = el('notice');
  box.replaceChildren();
  const h = document.createElement('strong');
  h.textContent = headline;
  const p = document.createElement('p');
  p.textContent = detail + (reason ? ` (${reason})` : '');
  box.append(h, p);
  box.hidden = false;
}

/**
 * Compile and render, or explain why not.
 *
 * Mirrors the contract of output.py's preview route: a failed preview never
 * costs the .tex, and the reason is named -- the missing package, the unsafe
 * construct, or the engine error -- rather than reported as a generic failure.
 */
async function showPreview(tex, issues, target = el('preview'),
                           box = el('preview-error')) {
  box.hidden = true;
  el('download-pdf').hidden = true;
  target.replaceChildren();

  const result = await compile(tex);

  if (result.ok) {
    state.pdf = result.pdf;
    el('download-pdf').hidden = false;
    const { pages } = await renderPdf(result.pdf, target);
    setStatus(`Done. ${pages} page${pages === 1 ? '' : 's'}.`);
    return;
  }

  const parts = [];
  if (result.reason) parts.push(result.reason);
  if (result.missingPackages.length) {
    parts.push('Missing LaTeX packages: ' + result.missingPackages.join(', ') +
               '. The .tex file is unchanged and can still be downloaded and ' +
               'compiled wherever those packages are available.');
  } else if (result.attempted && !result.reason) {
    parts.push('The preview could not be built from this document. ' +
               'The .tex file is unchanged and can still be downloaded.');
  }
  if (issues && issues.length) parts.push('Validation found: ' + issues.join(' '));
  box.textContent = parts.join(' ');
  box.hidden = false;
  setStatus('Converted. No preview — see the note above.');
}

function downloadTex(tex, name) {
  if (!tex) return;
  const base = (name || 'converted').replace(/\.[^.]*$/, '') || 'document';
  const url = URL.createObjectURL(new Blob([tex], { type: 'application/x-tex' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.tex`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The history view.
 *
 * Signed in -> the persistent list, read back through the Worker.
 * Guest     -> nothing server-side; the browser holds its own list in
 *              sessionStorage and renders it here.
 *
 * Its own view rather than a section of the workspace, for the reason
 * pages.py gives: reaching a past conversion used to mean scrolling past the
 * entire converter.
 */
async function renderHistory() {
  const list = el('history-list');
  const empty = el('history-empty');
  const clearBtn = el('history-clear');
  list.replaceChildren();

  let rows;
  if (state.shell.isAuthenticated) {
    const saved = await history.fetchSaved();
    rows = saved.history.map((r) => ({ ...r, saved: true }));
    clearBtn.hidden = true;   // there is no self-service delete; see the README
  } else {
    rows = state.guest.map((item, index) => ({
      id: `guest-${index}`, fileName: item.fileName, timestamp: item.at,
      result: item.result, truncated: false, saved: false,
    }));
    clearBtn.hidden = !rows.length;
  }

  empty.hidden = rows.length > 0;
  list.hidden = rows.length === 0;

  for (const row of rows) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'row';
    const name = document.createElement('h3');
    name.textContent = row.fileName || 'document';
    const when = document.createElement('time');
    when.dateTime = row.timestamp || '';
    when.textContent = history.formatWhen(row.timestamp);
    head.append(name, when);
    li.append(head);

    const actions = document.createElement('div');
    actions.className = 'actions';

    // A saved row's LaTeX is not in the list -- pages.py fetches only the
    // fields it renders, because a stored document runs to 60 KB and twenty of
    // them is a megabyte crossing the network to display none of it.
    const getTex = async () => {
      if (!row.saved) return { tex: row.result, truncated: false };
      const found = await history.fetchSavedTex(row.id);
      return found || { tex: '', truncated: false };
    };

    actions.append(button('Download .tex', async () => {
      const { tex } = await getTex();
      downloadTex(tex, row.fileName);
    }));
    actions.append(button('Copy LaTeX', async () => {
      const { tex } = await getTex();
      await navigator.clipboard.writeText(tex || '');
    }));

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    const panelError = document.createElement('p');
    panelError.className = 'notice';
    panelError.hidden = true;

    actions.append(button('Preview PDF', async (event) => {
      const b = event.currentTarget;
      if (!panel.hidden) {
        panel.hidden = true; panel.replaceChildren();
        panelError.hidden = true;
        b.textContent = 'Preview PDF';
        return;
      }
      panel.hidden = false;
      b.textContent = 'Hide preview';
      const { tex, truncated } = await getTex();
      if (truncated) {
        // output.py refuses to compile a stored document that was cut short,
        // and says so rather than showing a broken preview.
        panelError.textContent =
          'This saved document was too long to store in full, so it cannot ' +
          'be compiled. Convert the original again to get a complete .tex.';
        panelError.hidden = false;
        return;
      }
      await showPreview(tex, staticValidate(tex), panel, panelError);
    }));

    li.append(actions, panelError, panel);

    if (row.truncated) {
      const mark = document.createElement('p');
      mark.className = 'notice';
      mark.textContent = 'This document was too long to store in full.';
      li.append(mark);
    }
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

function show(view) {
  for (const id of ['convert-view', 'history-view', 'auth-view']) {
    el(id).hidden = id !== view;
  }
  if (view === 'history-view') renderHistory();
}

function applyShell(shell) {
  state.shell = { ...state.shell, ...shell };
  el('signed-in').hidden = !shell.isAuthenticated;
  el('signed-out').hidden = !!shell.isAuthenticated;
  el('who').textContent = shell.displayName || shell.email || '';
  el('terms').hidden = !!shell.hasAcceptedTerms;
  el('google-signin').hidden = !shell.firebaseConfig;
}

function authError(message) {
  const box = el('auth-error');
  box.textContent = message;
  box.hidden = !message;
}
function authSuccess(message) {
  const box = el('auth-success');
  box.textContent = message;
  box.hidden = !message;
}

async function afterSignIn(result) {
  if (!result.ok) { authError(result.error || 'Authentication failed'); return; }
  applyShell(result);
  // A signed-in user must never see leftovers from an earlier guest session in
  // the same tab.
  history.clear();
  state.guest = [];
  authError(''); authSuccess('');
  show('convert-view');
}

el('go').addEventListener('click', run);
el('download').addEventListener('click', () => downloadTex(state.tex, state.name));
el('copy').addEventListener('click', () => navigator.clipboard.writeText(state.tex || ''));
el('download-pdf').addEventListener('click', () => {
  if (state.pdf) downloadPdf(state.pdf, state.name);
});

el('nav-convert').addEventListener('click', () => show('convert-view'));
el('nav-history').addEventListener('click', () => show('history-view'));
el('nav-signin').addEventListener('click', () => { authError(''); authSuccess(''); show('auth-view'); });

el('history-clear').addEventListener('click', () => {
  state.guest = [];
  history.clear();
  renderHistory();
});

el('login').addEventListener('click', async () => {
  authError(''); authSuccess('');
  afterSignIn(await auth.login(el('login-email').value,
                               el('login-password').value,
                               el('login-remember').checked));
});

el('google-signin').addEventListener('click', async (event) => {
  const b = event.currentTarget;
  b.disabled = true;
  authError('');
  try {
    afterSignIn(await auth.loginWithGoogle(state.shell.firebaseConfig));
  } catch (err) {
    authError('Google sign-in did not complete: ' +
              (err && err.message ? err.message : 'unknown error'));
  } finally {
    b.disabled = false;
  }
});

el('signup').addEventListener('click', async () => {
  authError(''); authSuccess('');
  const result = await auth.signup({
    fullname: el('signup-name').value,
    email: el('signup-email').value,
    password: el('signup-password').value,
    confirm_password: el('signup-confirm').value,
    terms: el('signup-terms').checked,
  });
  if (result.ok) authSuccess(result.success);
  else authError(result.error || 'Failed to create account');
});

el('forgot').addEventListener('click', async () => {
  authError(''); authSuccess('');
  const result = await auth.forgotPassword(el('forgot-email').value);
  if (result.ok) authSuccess(result.success);
  else authError(result.error || 'An error occurred');
});

el('logout').addEventListener('click', async () => {
  const result = await auth.logout();
  applyShell(result);
  // Signing out drops the session; the guest list starts empty rather than
  // inheriting anything from the account that was just here.
  history.clear();
  state.guest = [];
  show('convert-view');
});

// -- start ------------------------------------------------------------------
(async () => {
  const shell = await auth.session();
  applyShell(shell);
  // The guest-history contract for this page load: a refresh wipes the list, a
  // signed-in user never sees one, and moving between views does not.
  state.guest = history.open(shell);

  // Ask before converting, so a warning cannot outlive the outage that caused it.
  fetch('/api/ai-status').then((r) => r.json()).then((s) => {
    if (!s.available) setStatus(s.message);
  }).catch(() => {});
})();
