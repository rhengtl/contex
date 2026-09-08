/**
 * The ConTeX client.
 *
 * Carries the parts of static/scripts.js and the Flask routes that Stages 1-3
 * cover: the shell context, the terms gate, sign-in, the upload, the page-by-
 * page conversion and merge, the preview, and both kinds of history.
 *
 * WHAT THIS FILE IS NOW. The page: elements, listeners, and the two questions
 * only a person can answer -- do you accept the terms, and will you accept a
 * conversion without the AI. Everything with a decision in it has moved out:
 *
 *   convert.js        run.py convert() and _convert_pages(): the model chain,
 *                     the page-by-page conversion, where to resume when the AI
 *                     stops part way, and the fallback authorisation gate.
 *   recognise/        the local recognisers and the layout analysis behind it.
 *   input.js          the four ways a page gets in -- picker, drag-and-drop,
 *                     camera, canvas.
 *
 * That split is not tidying. A pipeline whose failure modes can only be
 * exercised by clicking is a pipeline whose failure modes are not tested, and
 * the failure modes are the point of Stage 4: tests/fallback.mjs drives the
 * whole thing against a Gemini that is down, rate-limited, or dies on page
 * three, without a browser click anywhere.
 *
 * One thing used to be here and is gone entirely: base64 encoding. The Worker
 * pipes the raw bytes into the Gemini Files API, so there is nothing to encode
 * -- which is what closed the injection hole, and incidentally deleted the
 * chunked-encode loop a 19 MB image needed.
 *
 * What did NOT move: who this visitor is, and whether they may convert. Those
 * are read from the signed session cookie in the Worker and are never the
 * client's to assert. session.py's rule is unchanged.
 */

import { staticValidate } from '/latex/validate.js';
import { compile } from '/latex/compile.js';
import { renderPdf, downloadPdf } from '/preview.js';
import { aiUnits, checkInput, extensionOf, ACCEPTED } from '/pages.js';
import { convertDocument, FallbackNotAuthorized } from '/convert.js';
import * as auth from '/auth.js';
import * as history from '/history.js';
import * as input from '/input.js';

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

/**
 * A transient message, for something that happened rather than something that
 * is wrong. Never a browser dialog: scripts.js does not use one either, and the
 * Python suite has a test that says so.
 */
let toastTimer = null;
function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}
function clearError() { el('error').hidden = true; }
function setStatus(message) { el('status').textContent = message || ''; }

// ---------------------------------------------------------------------------
// Converting
// ---------------------------------------------------------------------------

/**
 * What leaves this module. convert.js takes its I/O through this so the whole
 * decision tree -- including the AI being down, or dying on page three -- can
 * be driven by tests/fallback.mjs without a browser click.
 */
const api = {
  aiStatus: () => fetch('/api/ai-status').then((r) => r.json()).catch(() => ({
    available: false,
    message: 'The AI conversion service could not be reached.',
  })),
  convertPage: ({ body, mime, attempt, thinking }) => fetch(
    `/api/convert/page?attempt=${attempt}${thinking ? '' : '&thinking=off'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-image-mime': mime },
      body,
    }),
};

/**
 * The user's answer to the AI-unavailable warning, for this attempt only.
 *
 * Deliberately not sticky. Someone who accepted a degraded conversion of one
 * document has not agreed to degrade the next one, and a flag that outlived
 * the conversion would turn the next upload's silent downgrade into exactly
 * the thing run.py refuses to do.
 */
let allowFallback = false;

/**
 * Offer the choice, and wait for it. Resolves true to continue locally, false
 * to cancel.
 *
 * Three ways out, as the Flask dialog had: check again (the outage may be
 * over, and a warning must not outlive it), continue without AI, or cancel and
 * wait. Nothing is converted until one of them is chosen.
 */
function askAboutFallback(status) {
  const dialog = el('ai-modal');
  el('ai-modal-reason').textContent =
    status?.message || 'The AI conversion service is temporarily unavailable.';
  const recovery = el('ai-modal-recovery');
  if (status?.retryAt) {
    const when = new Date(status.retryAt * 1000);
    recovery.textContent = `Expected back around ${when.toLocaleTimeString()}.`;
  } else {
    recovery.textContent = 'Not known.';
  }
  el('ai-modal-checked').textContent =
    `Checked at ${new Date().toLocaleTimeString()}.`;

  return new Promise((resolve) => {
    const finish = (answer) => {
      recheck.removeEventListener('click', onRecheck);
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      dialog.close();
      resolve(answer);
    };
    const recheck = el('ai-recheck');
    const go = el('ai-continue');
    const cancel = el('ai-cancel');

    const onRecheck = async () => {
      recheck.disabled = true;
      recheck.textContent = 'Checking…';
      const fresh = await api.aiStatus();
      recheck.disabled = false;
      recheck.textContent = 'Check again';
      if (fresh && fresh.available) {
        toast('AI conversion is available again.');
        finish(true);
        return;
      }
      el('ai-modal-reason').textContent =
        fresh?.message || 'Still unavailable.';
      el('ai-modal-checked').textContent =
        `Checked at ${new Date().toLocaleTimeString()}.`;
      toast('Still unavailable.');
    };
    const onGo = () => finish(true);
    const onCancel = () => finish(false);

    recheck.addEventListener('click', onRecheck);
    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    if (!dialog.open) dialog.showModal();
  });
}

async function run() {
  clearError();
  el('notice').replaceChildren();
  el('notice').hidden = true;
  const file = input.selectedFile();
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
    const { units, total, dropped } = await aiUnits(buf, file.name, file.type);

    // Say so BEFORE the conversion, not after. A PDF longer than the cap is
    // converted in part, and the Python app never mentioned it -- the Terms
    // disclose the limit, but nobody reads terms to find out why their
    // document ends at page ten.
    if (dropped > 0) {
      notice(`Only the first ${units.length} pages of this ${total}-page PDF ` +
             'will be converted.',
             `ConTeX converts at most ${units.length} pages of a PDF. Pages ` +
             `${units.length + 1} to ${total} are not sent and will not appear ` +
             'in the result. Split the file and convert the rest separately if ' +
             'you need all of it.');
    }
    if (units.length > 1) setStatus(`Converting ${units.length} pages…`);

    let result;
    try {
      result = await convertDocument({
        units, total, api, allowFallback, ui: { status: setStatus },
      });
    } catch (err) {
      if (!(err instanceof FallbackNotAuthorized)) throw err;
      // The AI is down and nothing has been converted. Ask, then either run
      // the local path or stop -- never quietly produce a lesser document.
      setStatus('');
      if (!await askAboutFallback(err.status)) {
        toast('Cancelled. Your document was not converted.');
        return;
      }
      allowFallback = true;
      setStatus('Converting without AI…');
      result = await convertDocument({
        units, total, api, allowFallback: true, ui: { status: setStatus },
      });
    }

    const { tex, summary, issues } = result;
    state.tex = tex;
    state.name = file.name;
    el('tex').textContent = tex;
    el('result').hidden = false;

    // The one notice about a degraded conversion, shown once, here, on the
    // finished document -- not while it was running.
    if (summary.fallbackNotice) {
      const n = summary.fallbackNotice;
      notice(n.headline, n.detail, n.reason);
    }
    // Per-page notes: a page that could not be read is missing from the
    // output, and that is not something the user can see from the preview.
    if (summary.notes.length) {
      notice('Notes on this conversion', summary.notes.join(' '));
    }
    if (summary.uncertainLines) {
      notice(`${summary.uncertainLines} line(s) may be misread.`,
             'Those lines were recognised with low confidence — handwriting, '
             + 'usually. Check them against your original before using this.');
    }

    // Save before the preview: a conversion that compiled badly is still the
    // user's transcription, and losing it to a preview failure would be worse
    // than showing no preview.
    const saved = await history.record({
      isAuthenticated: state.shell.isAuthenticated,
      fileName: file.name, tex,
    });
    if (saved.items) state.guest = saved.items;

    setStatus('Building the preview…');
    await showPreview(tex, issues);
  } catch (err) {
    setStatus('');
    showError(err.message);
  } finally {
    el('go').disabled = false;
    allowFallback = false;
  }
}

/**
 * Add one notice. Appends rather than replaces: a long PDF that then loses the
 * model part way through has two things to say, and the second must not erase
 * the first. run() clears the box before each conversion.
 */
function notice(headline, detail, reason) {
  const box = el('notice');
  const item = document.createElement('div');
  const h = document.createElement('strong');
  h.textContent = headline;
  const p = document.createElement('p');
  p.textContent = detail + (reason ? ` (${reason})` : '');
  item.append(h, p);
  box.append(item);
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
      id: `guest-${index}`, index, fileName: item.fileName, timestamp: item.at,
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

    // Deleting your own conversion. The Flask app had no such control and its
    // Privacy Policy said so; this is the erasure right with a button on it.
    // The Worker re-checks that the row is yours whatever is sent from here.
    actions.append(button('Delete', async (event) => {
      const b = event.currentTarget;
      if (b.dataset.confirming !== 'yes') {
        // A second click rather than a browser dialog -- the suite pins that
        // this app never uses one, and an accidental delete is unrecoverable.
        b.dataset.confirming = 'yes';
        b.textContent = 'Delete for good?';
        b.classList.add('danger');
        setTimeout(() => {
          if (!b.isConnected || b.dataset.confirming !== 'yes') return;
          delete b.dataset.confirming;
          b.textContent = 'Delete';
          b.classList.remove('danger');
        }, 6000);
        return;
      }
      b.disabled = true;
      if (row.saved) {
        if (!await history.deleteSaved(row.id)) {
          b.disabled = false;
          delete b.dataset.confirming;
          b.textContent = 'Delete';
          b.classList.remove('danger');
          toast('That conversion could not be deleted. Please try again.');
          return;
        }
      } else {
        state.guest = history.removeGuest(row.index);
      }
      await renderHistory();
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

/**
 * Drop everything the previous visitor left in this tab.
 *
 * session.py start_session() clears the whole session on sign-in, and says
 * why: "On a shared computer the person signing in is not necessarily the
 * person who was just using it, and a token left in the cookie would let them
 * download the document that person converted." The tokens are gone here --
 * the document is held in the page instead -- so the same rule has to be
 * applied to the page, or the result panel is the leak the tokens used to be.
 */
function clearWorkspace() {
  state.tex = null;
  state.name = null;
  state.pdf = null;
  el('tex').textContent = '';
  el('result').hidden = true;
  el('preview').replaceChildren();
  el('preview-error').hidden = true;
  el('notice').replaceChildren();
  el('notice').hidden = true;
  el('download-pdf').hidden = true;
  // The chosen page as well as the converted one. A camera capture is held in
  // this module rather than in the file input, so clearing the input alone
  // would leave the previous visitor's photograph attached and ready to send.
  input.clearInput();
  setStatus('');
  clearError();
  history.clear();
  state.guest = [];
}

async function afterSignIn(result) {
  if (!result.ok) { authError(result.error || 'Authentication failed'); return; }
  applyShell(result);
  // Everything the previous visitor had goes -- their guest history and the
  // document still on screen alike.
  clearWorkspace();
  authError(''); authSuccess('');
  show('convert-view');
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
const legalCache = new Map();

async function showLegal(which) {
  if (which !== 'terms' && which !== 'privacy') return;
  const dialog = el('legal');
  el('legal-title').textContent =
    which === 'terms' ? 'Terms of Service' : 'Privacy Policy';
  const body = el('legal-body');

  if (!legalCache.has(which)) {
    body.textContent = 'Loading…';
    try {
      const res = await fetch(`/legal/${which}.html`);
      if (!res.ok) throw new Error(String(res.status));
      legalCache.set(which, await res.text());
    } catch {
      body.textContent = 'That document could not be loaded. Please try again.';
      if (!dialog.open) dialog.showModal();
      return;
    }
  }
  body.innerHTML = legalCache.get(which);
  // Stamp the version actually in force, which the Worker reports -- the
  // Flask template interpolated the same value.
  for (const slot of body.querySelectorAll('[data-terms-version]')) {
    slot.textContent = state.shell.termsVersion || '—';
  }
  if (!dialog.open) dialog.showModal();
}

// One delegated listener, so a control inside a document that was just
// inserted -- the Privacy Policy link inside the Terms -- works too.
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-legal]');
  if (!trigger) return;
  event.preventDefault();
  showLegal(trigger.dataset.legal);
});
el('legal-close').addEventListener('click', () => el('legal').close());

input.init({ toast, onChange: () => { clearError(); } });

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
  // auth.py's logout is session.clear(): the whole session goes, not just the
  // sign-in half. Nothing of the account that was just here is left behind for
  // whoever uses this tab next.
  clearWorkspace();
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
