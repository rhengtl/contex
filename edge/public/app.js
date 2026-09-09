/**
 * The ConTeX client.
 *
 * Loaded by every page, because every page has the shell: the header's account
 * state, the legal dialog, the drawer, the toast. Only the workspace has a
 * converter, and setupConverter() returns immediately when there is not one.
 *
 * WHAT THIS FILE IS. The page: elements, listeners, and the two questions only
 * a person can answer -- do you accept the terms, and will you accept a
 * conversion without the AI. Everything with a decision in it lives elsewhere:
 *
 *   convert.js        run.py convert() and _convert_pages(): the model chain,
 *                     the page-by-page conversion, where to resume when the AI
 *                     stops part way, and the fallback authorisation gate.
 *   recognise/        the local recognisers and the layout analysis behind it.
 *   input.js          the four ways a page gets in.
 *   ui.js             dialogs, toasts, the drawer, the legal reader.
 *
 * That split is not tidying. A pipeline whose failure modes can only be
 * exercised by clicking is a pipeline whose failure modes are not tested, and
 * the failure modes are the point: tests/fallback.mjs drives the whole thing
 * against a Gemini that is down, rate-limited, or dies on page three, without
 * a browser click anywhere.
 *
 * What did NOT move: who this visitor is, and whether they may convert. Those
 * are read from the signed session cookie in the Worker and are never the
 * client's to assert. session.py's rule is unchanged.
 */

import { staticValidate } from '/latex/validate.js';
import { compile } from '/latex/compile.js';
import { renderPdf } from '/preview.js';
import { aiUnits, checkInput, extensionOf, totalPages, ACCEPTED,
         ACCEPTED_EXTENSIONS, MAX_PDF_PAGES } from '/pages.js';
import { convertDocument, FallbackNotAuthorized } from '/convert.js';
import * as auth from '/auth.js';
import * as history from '/history.js';
import * as input from '/input.js';
import { el, setText, toggle, toast, openDialog, closeDialog, onDismiss,
         writeClipboard, setTermsVersion, on } from '/ui.js';

const state = {
  tex: null,
  name: null,
  pdf: null,
  pdfUrl: null,
  texUrl: null,
  shell: {
    isAuthenticated: false, hasAcceptedTerms: false, maxUploadMb: 32,
    termsVersion: null, firebaseConfig: null,
  },
};

/* ---------------------------------------------------------------------------
   The shell -- on every page
   --------------------------------------------------------------------------- */

function applyShell(shell) {
  state.shell = { ...state.shell, ...shell };
  setTermsVersion(state.shell.termsVersion);

  const signedIn = !!shell.isAuthenticated;
  const name = shell.displayName || shell.email || '';

  // The header's account control. Flask rendered one of these two; both are in
  // the document here and one is unhidden -- with the same suppression the
  // original had, which is that the sign-in page does not offer a Sign in
  // button in its own header.
  const onLoginPage = document.body.dataset.page === 'login';
  toggle(el('nav-account-in'), signedIn);
  toggle(el('nav-account-out'), !signedIn && !onLoginPage);
  toggle(el('sidebar-account-in'), signedIn);
  toggle(el('sidebar-account-out'), !signedIn);
  if (el('nav-account-in')) el('nav-account-in').classList.toggle('flex', signedIn);
  if (el('nav-account-out')) {
    el('nav-account-out').classList.toggle('flex', !signedIn && !onLoginPage);
  }
  setText('nav-account-name', name);
  if (el('nav-account-name') && shell.email) el('nav-account-name').title = shell.email;
  setText('sidebar-account-name', name);
}

on('logout', async () => {
  const result = await auth.logout();
  // auth.py's logout is session.clear(): the whole session goes, not just the
  // sign-in half. Nothing of the account that was just here is left behind for
  // whoever uses this tab next -- including the guest list and any document
  // still on screen, which is why this reloads rather than patching the DOM.
  history.clear();
  applyShell(result);
  window.location.href = '/';
});

/* ---------------------------------------------------------------------------
   The terms gate

   The checkbox enables the controls; the Worker checks the session again on
   every /api/convert/page. Disabling the fieldset is a courtesy, not the
   enforcement.
   --------------------------------------------------------------------------- */

function lockControls(locked) {
  const controls = el('convert-controls');
  if (!controls) return;
  controls.disabled = locked;
  controls.classList.toggle('opacity-40', locked);
  controls.classList.toggle('pointer-events-none', locked);
}

function showTermsError(message) {
  const error = el('terms-error');
  if (!error) return;
  error.textContent = message;
  error.classList.remove('hidden');
}

function applyTermsState() {
  const accepted = !!state.shell.hasAcceptedTerms;
  toggle('terms-gate', !accepted);
  toggle('terms-accepted', accepted);
  setText('terms-accepted-version', state.shell.termsVersion || '');
  lockControls(!accepted);
}

function setupTermsGate() {
  const box = el('terms-checkbox');
  if (!box) return;

  box.addEventListener('change', async () => {
    const error = el('terms-error');
    if (error) error.classList.add('hidden');

    if (!box.checked) { lockControls(true); return; }
    box.disabled = true;

    try {
      const data = await auth.acceptTerms(state.shell.termsVersion);
      if (data && data.ok) {
        state.shell.hasAcceptedTerms = true;
        applyTermsState();
        toast('Thanks - you can now convert a document.');
      } else {
        box.checked = false;
        box.disabled = false;
        showTermsError((data && data.error)
          || 'Could not record your acceptance. Please try again.');
      }
    } catch {
      box.checked = false;
      box.disabled = false;
      showTermsError('Could not reach the server. Please try again.');
    }
  });
}

/* ---------------------------------------------------------------------------
   AI availability

   Checked immediately before a conversion starts, never after. A user who is
   about to get a materially worse result is told so while they can still
   decide not to.
   --------------------------------------------------------------------------- */

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
let busy = false;

function showAiModal(status) {
  status = status || {};
  setText('ai-modal-reason', status.message
    || 'The AI conversion service is currently unavailable.');

  // Flask listed every configured provider here. There is one, and naming it
  // is more useful than naming the category.
  setText('ai-modal-services', status.reason === 'not_configured'
    ? 'No AI service is configured on this server.'
    : 'Google Gemini API');

  const source = el('ai-modal-recovery-source');
  if (status.retryAt) {
    const when = new Date(status.retryAt * 1000);
    setText('ai-modal-recovery', `Expected back around ${when.toLocaleTimeString()}.`);
    if (source) {
      source.textContent = 'Source: the quota window reported by the provider.';
      source.classList.remove('hidden');
    }
  } else {
    setText('ai-modal-recovery', 'No estimated recovery time is currently available.');
    if (source) { source.textContent = ''; source.classList.add('hidden'); }
  }

  setText('ai-modal-checked', `Checked at ${new Date().toLocaleTimeString()}.`);
  openDialog('ai-modal');
}

/**
 * Offer the choice, and wait for it. Resolves true to continue locally, false
 * to cancel.
 *
 * Three ways out, as the Flask dialog had: check again (the outage may be
 * over, and a warning must not outlive it), continue without AI, or cancel and
 * wait. Nothing is converted until one of them is chosen.
 */
function askAboutFallback(status) {
  showAiModal(status);
  return new Promise((resolve) => { pendingAnswer = resolve; });
}

let pendingAnswer = null;

function answerFallback(value) {
  const resolve = pendingAnswer;
  pendingAnswer = null;
  closeDialog('ai-modal');
  if (resolve) resolve(value);
}

/** Re-check, so a warning cannot outlive the outage that produced it. */
async function recheckAi() {
  const button = el('ai-modal-recheck');
  if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  try {
    const fresh = await api.aiStatus();
    if (fresh && fresh.available) {
      toast('AI conversion is available again.');
      answerFallback('ai');
      return;
    }
    showAiModal(fresh);
    toast('Still unavailable.');
  } catch {
    toast('Could not check right now.');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Check again'; }
  }
}

onDismiss('ai-modal', () => {
  // Dismissing this dialog is cancelling the conversion, not merely hiding a
  // box -- which is why it does not go through closeDialog() alone.
  answerFallback(false);
  toast('Cancelled. Your document was not converted.');
});

/* ---------------------------------------------------------------------------
   The processing screen

   No progress bar, on purpose. Neither the Worker nor the model reports how
   far through a document it is, so a bar drawn here would be measuring
   nothing. Everything shown instead is true: which file is being read, how
   long it has actually been running, and an honest range for how long that
   usually takes.
   --------------------------------------------------------------------------- */

const PROCESSING_LONG_MS = 120000;
const PROCESSING_LONG_NOTE =
  'Still working. Long or dense documents take longer, and the conversion '
  + 'is not lost - please keep this tab open.';
const PROCESSING_NOTE =
  'Most single pages take 10–60 seconds. A long PDF can take a few '
  + 'minutes. Please keep this tab open.';

let processingTimer = null;

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function showProcessing(detail) {
  const screen = el('processing');
  if (!screen) return;

  setText('processing-detail', detail);
  setText('processing-note', PROCESSING_NOTE);
  setText('processing-elapsed', '0:00');

  const startedAt = Date.now();
  clearInterval(processingTimer);
  processingTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    setText('processing-elapsed', formatElapsed(elapsed));
    if (elapsed >= PROCESSING_LONG_MS) setText('processing-note', PROCESSING_LONG_NOTE);
  }, 1000);

  screen.classList.remove('hidden');
  screen.classList.add('flex');
  document.documentElement.style.overflow = 'hidden';
}

function hideProcessing() {
  const screen = el('processing');
  clearInterval(processingTimer);
  processingTimer = null;
  if (!screen) return;
  screen.classList.add('hidden');
  screen.classList.remove('flex');
  document.documentElement.style.overflow = '';
}

function describeConversion() {
  const name = input.chosenFileName();
  return name
    ? `Reading ${name} and writing the LaTeX for it.`
    : 'Reading your page and writing the LaTeX for it.';
}

function setSubmitting(working, label) {
  const button = el('convert-submit');
  if (!button) return;
  button.disabled = !!working;
  if (working && label) {
    button.dataset.idleLabel = button.dataset.idleLabel || button.textContent.trim();
    button.textContent = label;
  } else if (!working && button.dataset.idleLabel) {
    button.textContent = button.dataset.idleLabel;
  }
}

/* ---------------------------------------------------------------------------
   Converting
   --------------------------------------------------------------------------- */

function showConvertError(message) {
  setText('convert-error-text', message);
  toggle('convert-error', true);
}

function clearNotices() {
  toggle('convert-error', false);
  toggle('convert-blocked', false);
  toggle('fallback-notice', false);
  toggle('convert-notes', false);
  const list = el('convert-notes-list');
  if (list) list.replaceChildren();
}

/**
 * Warn about the page cap as soon as a long PDF is chosen.
 *
 * Before the conversion, not after: once Convert is pressed the processing
 * screen covers the page, so anything shown then is shown to nobody. The Flask
 * app never said this at all -- a PDF longer than the cap was converted in
 * part and the Terms disclosed the limit, which is not where anybody looks to
 * find out why their document ends at page ten.
 */
async function checkPageLimit() {
  const file = input.selectedFile();
  toggle('convert-pagelimit', false);
  if (!file || extensionOf(file.name) !== '.pdf') return;
  try {
    const total = await totalPages(new Uint8Array(await file.arrayBuffer()), file.name);
    if (total <= MAX_PDF_PAGES) return;
    setText('pagelimit-kept', String(MAX_PDF_PAGES));
    setText('pagelimit-detail',
      `This PDF has ${total} pages. ConTeX converts at most ${MAX_PDF_PAGES} of `
      + `them, so pages ${MAX_PDF_PAGES + 1} to ${total} will not be sent and `
      + 'will not appear in the result. Split the file and convert the rest '
      + 'separately if you need all of it.');
    toggle('convert-pagelimit', true);
  } catch {
    // An unreadable PDF is the conversion's problem to report, not this one's.
  }
}

/** The Flask "blocked" panel: asked to convert, said no to the fallback. */
function showBlocked(status) {
  setText('convert-blocked-reason', status?.message
    || 'The AI conversion service is temporarily unavailable.');
  const recovery = el('convert-blocked-recovery');
  if (recovery) {
    if (status?.retryAt) {
      const when = new Date(status.retryAt * 1000);
      recovery.textContent = `Expected back around ${when.toLocaleTimeString()}.`;
      recovery.classList.remove('hidden');
    } else {
      recovery.classList.add('hidden');
    }
  }
  toggle('convert-blocked', true);
}

async function startConversion(headline, detail) {
  if (busy) return;
  busy = true;
  clearNotices();

  const file = input.selectedFile();
  setText('processing-title', headline || 'Converting your document');
  showProcessing(detail || describeConversion());

  try {
    checkInput(file.name);
    const buf = new Uint8Array(await file.arrayBuffer());
    const { units, total, dropped } = await aiUnits(buf, file.name, file.type);

    // Say so BEFORE the conversion, not after. A PDF longer than the cap is
    // converted in part, and the Python app never mentioned it -- the Terms
    // disclose the limit, but nobody reads terms to find out why their
    // document ends at page ten.
    const pageNotes = [];
    if (dropped > 0) {
      pageNotes.push(`Only the first ${units.length} pages of this ${total}-page `
        + 'PDF were converted. Split the file and convert the rest separately '
        + 'if you need all of it.');
    }
    // Said before the conversion by checkPageLimit(); repeated here so the
    // finished document carries it too, for anyone who comes back to it later.

    let result;
    try {
      result = await convertDocument({
        units, total, api, allowFallback, ui: { status: setProcessingDetail },
      });
    } catch (err) {
      if (!(err instanceof FallbackNotAuthorized)) throw err;
      // The AI is down and nothing has been converted. Ask, then either run
      // the local path or stop -- never quietly produce a lesser document.
      hideProcessing();
      const answer = await askAboutFallback(err.status);
      if (!answer) { showBlocked(err.status); return; }
      const local = answer !== 'ai';
      setText('processing-title', local ? 'Converting without AI' : 'Converting your document');
      showProcessing(local
        ? 'The AI service is unavailable, so this is being converted in this '
          + 'browser. Nothing is sent anywhere, and quality will be lower.'
        : describeConversion());
      result = await convertDocument({
        units, total, api, allowFallback: local, ui: { status: setProcessingDetail },
      });
    }

    await showResult(file.name, result, pageNotes);
  } catch (err) {
    showConvertError(err.message);
  } finally {
    hideProcessing();
    setSubmitting(false);
    busy = false;
    allowFallback = false;
  }
}

function setProcessingDetail(message) {
  if (message) setText('processing-detail', message);
}

/** Swap the workspace from the input state to the document state. */
async function showResult(name, { tex, summary, issues }, pageNotes) {
  state.tex = tex;
  state.name = name;

  setText('result-name', name || 'document');
  const heading = el('result-name');
  if (heading) heading.title = name || 'document';
  setText('convert-tex', tex);

  // The one notice about a degraded conversion, shown once, here, on the
  // finished document -- not while it was running.
  if (summary.fallbackNotice) {
    const notice = summary.fallbackNotice;
    setText('fallback-notice-title', notice.partial ? 'Incomplete conversion' : notice.headline);
    const headline = el('fallback-notice-headline');
    if (headline) {
      headline.textContent = notice.partial ? notice.headline : '';
      headline.classList.toggle('hidden', !notice.partial);
    }
    setText('fallback-notice-detail', notice.detail);
    const reason = el('fallback-notice-reason');
    if (reason) {
      reason.textContent = notice.reason ? `Reason: ${notice.reason}` : '';
      reason.classList.toggle('hidden', !notice.reason);
    }
    const box = el('fallback-notice');
    // The alarm variant for a conversion that stopped part way, the caution
    // variant for one that finished by another route. Whole literal class
    // strings, because that is what Tailwind's scanner reads.
    if (box) box.className = notice.partial ? 'note-alarm mb-5' : 'note-caution mb-5';
    toggle('fallback-notice', true);
  }

  // Per-page notes: a page that could not be read is missing from the output,
  // and that is not something the user can see from the preview.
  const notes = [...pageNotes, ...summary.notes];
  if (summary.uncertainLines) {
    notes.push(`${summary.uncertainLines} line(s) were recognised with low `
      + 'confidence — handwriting, usually. Check them against your original.');
  }
  if (notes.length) {
    const list = el('convert-notes-list');
    for (const note of notes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.appendChild(item);
    }
    toggle('convert-notes', true);
  }

  // Save before the preview: a conversion that compiled badly is still the
  // user's transcription, and losing it to a preview failure would be worse
  // than showing no preview.
  await history.record({
    isAuthenticated: state.shell.isAuthenticated, fileName: name, tex,
  });

  const base = (name || 'converted').replace(/\.[^.]*$/, '') || 'document';
  if (state.texUrl) URL.revokeObjectURL(state.texUrl);
  state.texUrl = URL.createObjectURL(new Blob([tex], { type: 'application/x-tex' }));
  const download = el('download-tex');
  if (download) { download.href = state.texUrl; download.download = `${base}.tex`; }

  toggle('convert-input', false);
  toggle('convert-result', true);
  window.scrollTo({ top: 0, behavior: 'auto' });

  await loadPreview(issues);
}

/**
 * Compile and render, or explain why not.
 *
 * Mirrors the contract of output.py's preview route: a failed preview never
 * costs the .tex, and the reason is named -- the missing package, the unsafe
 * construct, or the engine error -- rather than reported as a generic failure.
 */
async function loadPreview(issues) {
  const pages = el('preview-pages');
  const loading = el('preview-loading');
  const error = el('preview-error');
  if (!pages) return;

  toggle(error, false);
  toggle(pages, false);
  toggle('preview-dropped', false);
  toggle(loading, true);
  setText('preview-loading-text', 'Compiling your document…');
  pages.replaceChildren();

  const result = await compile(state.tex);

  // A preview that only exists because a package was dropped is not the same
  // document as the .tex beside it, and saying so is the whole point of the
  // repair being visible rather than silent.
  const dropped = result.droppedPackages || [];
  if (dropped.length) {
    setText('preview-dropped-detail',
      `This document asks for ${dropped.join(', ')}, which `
      + `${dropped.length === 1 ? 'is' : 'are'} not available here, so `
      + `${dropped.length === 1 ? 'it was' : 'they were'} left out to render `
      + 'the preview. Everything else is as converted.');
    toggle('preview-dropped', true);
  }

  if (result.ok) {
    state.pdf = result.pdf;
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
    const open = el('preview-open');
    if (open) open.href = state.pdfUrl;

    await renderPdf(result.pdf, pages);
    toggle(loading, false);
    toggle(pages, true);
    return;
  }

  const parts = [];
  if (result.reason) parts.push(result.reason);
  if (result.missingPackages.length) {
    parts.push(`Missing LaTeX packages: ${result.missingPackages.join(', ')}. `
      + 'The .tex file is unchanged and can still be compiled wherever those '
      + 'packages are available.');
  } else if (result.attempted && !result.reason) {
    parts.push('The preview could not be built from this document.');
  }
  setText('preview-error-reason', parts.join(' '));

  const detail = el('preview-error-detail');
  const found = issues && issues.length ? `Validation found: ${issues.join(' ')}` : '';
  if (detail) {
    detail.textContent = found;
    detail.classList.toggle('hidden', !found);
  }
  toggle(loading, false);
  toggle(error, true);
}

/**
 * Compile one document into an arbitrary panel -- what a history row's
 * "Preview PDF" does. Same engine, same failure wording as the workspace.
 */
async function previewInto(tex, panel) {
  panel.replaceChildren();
  const waiting = document.createElement('div');
  waiting.className = 'empty';
  const text = document.createElement('p');
  text.className = 'empty-body';
  text.textContent = 'Compiling this document…';
  waiting.appendChild(text);
  panel.appendChild(waiting);

  const result = await compile(tex);
  panel.replaceChildren();

  if (!result.ok) {
    const note = document.createElement('div');
    note.className = 'note-alarm';
    const title = document.createElement('p');
    title.className = 'note-title';
    title.textContent = 'The document could not be rendered';
    const reason = document.createElement('p');
    reason.textContent = result.reason
      || (result.missingPackages.length
        ? `Missing LaTeX packages: ${result.missingPackages.join(', ')}.`
        : 'The preview could not be built from this document.');
    note.append(title, reason);
    panel.appendChild(note);
    return;
  }

  // The same caveat the workspace shows, for the same reason: this PDF and the
  // saved .tex are not the same document.
  const dropped = result.droppedPackages || [];
  if (dropped.length) {
    const note = document.createElement('div');
    note.className = 'note-caution mb-3';
    const title = document.createElement('p');
    title.className = 'note-title';
    title.textContent = 'Preview built without some packages';
    const body = document.createElement('p');
    body.textContent = `${dropped.join(', ')} `
      + `${dropped.length === 1 ? 'is' : 'are'} not available here, so `
      + `${dropped.length === 1 ? 'it was' : 'they were'} left out to render `
      + 'this preview. The saved .tex still asks for them.';
    note.append(title, body);
    panel.appendChild(note);
  }

  const pages = document.createElement('div');
  pages.className = 'pagestack max-h-[60vh]';
  panel.appendChild(pages);
  await renderPdf(result.pdf, pages);
}

/* ---------------------------------------------------------------------------
   Wiring
   --------------------------------------------------------------------------- */

function setupConverter() {
  const form = el('convert-form');
  if (!form) return;

  setupTermsGate();
  input.init({
    accepted: ACCEPTED_EXTENSIONS,
    onChange: () => { toggle('convert-error', false); checkPageLimit(); },
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const file = input.selectedFile();
    if (!file) {
      toast('Choose a file, take a photo, or write something first.');
      return;
    }
    clearNotices();

    if (file.size === 0) { showConvertError('That file was empty.'); return; }
    const extension = extensionOf(file.name);
    if (extension && !ACCEPTED.has(extension)) {
      showConvertError(`Unsupported file type: '${extension}'`);
      return;
    }
    const limit = state.shell.maxUploadMb;
    if (file.size > limit * 1024 * 1024) {
      showConvertError(`That file is larger than the ${limit} MB limit.`);
      return;
    }

    setSubmitting(true, 'Checking…');
    const status = await api.aiStatus();
    setSubmitting(false);

    if (status && status.available) {
      startConversion('Converting your document');
      return;
    }
    // Not available: ask before anything is converted, exactly as the Flask
    // gate did, and run whichever path the answer names.
    const answer = await askAboutFallback(status);
    if (!answer) { showBlocked(status); return; }
    if (answer === 'ai') {
      startConversion('Converting your document');
    } else {
      allowFallback = true;
      startConversion('Converting without AI',
        'The AI service is unavailable, so this is being converted in this '
        + 'browser. Nothing is sent anywhere, and quality will be lower.');
    }
  });

  on({
    'ai-recheck': () => recheckAi(),
    'ai-cancel': () => { answerFallback(false); toast('Cancelled. Your document was not converted.'); },
    'ai-fallback': () => answerFallback('local'),
    'copy-tex': (element) => writeClipboard(el(element.dataset.arg)?.textContent || '', element),
    'preview-load': () => loadPreview(state.tex ? staticValidate(state.tex) : []),
    // The href is a blob URL this page made, so the link works on its own.
    // Kept as an action so it behaves the same way as every other control.
    'open-pdf': () => {},
  });
}

/* ---------------------------------------------------------------------------
   Start
   --------------------------------------------------------------------------- */

(async () => {
  // BEFORE the first await, and deliberately so. These forms have no action of
  // their own, so until their submit listener exists a submit is a native GET
  // that puts the password in the URL. Anything that waits on the network here
  // is a window in which that can happen.
  auth.setupForms();

  const shell = await auth.session();
  applyShell(shell);
  applyTermsState();
  setText('max-upload-mb', String(state.shell.maxUploadMb));

  // The guest-history contract for this page load: a refresh wipes the list, a
  // signed-in user never sees one.
  history.open(shell);

  setupConverter();
  auth.setupGoogle(state.shell);
  // The history page compiles a saved document through the same engine the
  // workspace uses. Passed in rather than imported there, so a list of file
  // names does not pull a 12 MB compiler in with it.
  await history.renderPage(state.shell, { preview: previewInto });

  // Ask before converting, so a warning cannot outlive the outage that caused
  // it -- but say so up front when the service is not configured at all.
  if (el('convert-form')) {
    api.aiStatus().then((status) => {
      if (status && status.reason === 'not_configured') {
        toggle('qa-notice-training', false);
        toggle('qa-notice-unconfigured', true);
      }
    }).catch(() => {});
  }
})();
