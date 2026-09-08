/**
 * Stage 1 client. Carries the parts of static/scripts.js that this stage
 * covers: the terms gate, the upload, and getting the .tex back out.
 *
 * Two responsibilities moved here from the server, and both are deliberate:
 *
 *   base64 encoding   so the Worker can stream the body without reading it
 *                     (spec R1/R2). Chunked, because a 19 MB image blows the
 *                     call stack if spread into one apply().
 *   the model chain   a stream cannot be replayed, so the retry loop that
 *                     lived in services/llm/ lives here now. The order and
 *                     the outage semantics are unchanged.
 */

import { staticValidate } from '/latex/validate.js';
import { compile } from '/latex/compile.js';
import { renderPdf, downloadPdf } from '/preview.js';

const el = (id) => document.getElementById(id);
const state = { tex: null, name: null, pdf: null };

// inputs.py ACCEPTED -- the single source of truth for file types. The picker
// in index.html derives from the same list, so the control cannot offer
// something the converter will refuse.
const ACCEPTED = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp',
                  '.gif', '.pdf', '.docx'];
const MAX_UPLOAD_MB = 32;

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

async function acceptTerms() {
  const res = await fetch('/api/session/terms', { method: 'POST' });
  return res.ok;
}

/**
 * One page through the Worker, walking the model chain on retryable failure.
 * Mirrors availability.py: the service counts as unavailable only when every
 * candidate has refused, and a fallback is never taken silently.
 */
async function convertPage(base64, mime) {
  let attempt = 0;
  let thinking = true;
  for (let guard = 0; guard < 10; guard++) {
    const query = `attempt=${attempt}${thinking ? '' : '&thinking=off'}`;
    const res = await fetch(`/api/convert/page?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-image-mime': mime },
      body: base64,
    });
    if (res.ok) {
      const payload = await res.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '').join('') || '';
      const tex = fencedLatex(text);
      if (tex) return { tex, model: res.headers.get('x-contex-model') };
      throw new Error('The conversion failed. Please try a different file.');
    }
    const err = await res.json().catch(() => ({}));
    if (!err.retryable || err.nextAttempt === null) {
      throw new Error(err.error || 'The conversion failed. Please try a different file.');
    }
    if (err.retryWithoutThinking) {
      // This model does not accept a thinking level. Drop it once and retry
      // the same model -- gemini.py ask() does exactly this.
      thinking = false;
    } else {
      attempt = err.nextAttempt;
      thinking = true;
      setStatus(`${err.model || 'That model'} is unavailable — trying the next one…`);
    }
  }
  throw new Error('The AI conversion service is temporarily unavailable.');
}

async function run() {
  clearError();
  const file = el('file').files[0];
  if (!file) { showError('No file selected.'); return; }
  if (file.size === 0) { showError('That file was empty.'); return; }

  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!ACCEPTED.includes(ext)) {
    showError(`Unsupported file type: '${ext}'`);
    return;
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    showError(`That file is larger than the ${MAX_UPLOAD_MB} MB limit.`);
    return;
  }

  el('go').disabled = true;
  setStatus('Converting…');
  try {
    if (el('accept').checked) await acceptTerms();
    const buf = await file.arrayBuffer();
    const { tex } = await convertPage(toBase64(buf), file.type || 'image/png');
    state.tex = tex;
    state.name = file.name;
    el('tex').textContent = tex;
    el('result').hidden = false;

    // Structural check before the engine, exactly as the pipeline does. Issues
    // are reported but never block the .tex: a document that does not validate
    // is still the user's transcription.
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

/**
 * Compile and render, or explain why not.
 *
 * Mirrors the contract of output.py's preview route: a failed preview never
 * costs the .tex, and the reason is named -- the missing package, the unsafe
 * construct, or the engine error -- rather than reported as a generic failure.
 */
async function showPreview(tex, issues) {
  const box = el('preview-error');
  box.hidden = true;
  el('download-pdf').hidden = true;
  el('preview').replaceChildren();

  const result = await compile(tex);

  if (result.ok) {
    state.pdf = result.pdf;
    el('download-pdf').hidden = false;
    const { pages } = await renderPdf(result.pdf, el('preview'));
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
  if (issues.length) parts.push('Validation found: ' + issues.join(' '));
  box.textContent = parts.join(' ');
  box.hidden = false;
  setStatus('Converted. No preview — see the note above.');
}

function download() {
  if (!state.tex) return;
  const base = (state.name || 'converted').replace(/\.[^.]*$/, '') || 'document';
  const url = URL.createObjectURL(new Blob([state.tex], { type: 'application/x-tex' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.tex`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

el('terms').hidden = false;
el('go').addEventListener('click', run);
el('download').addEventListener('click', download);
el('copy').addEventListener('click', () => navigator.clipboard.writeText(state.tex || ''));
el('download-pdf').addEventListener('click', () => {
  if (state.pdf) downloadPdf(state.pdf, state.name);
});

// Ask before converting, so a warning cannot outlive the outage that caused it.
fetch('/api/ai-status').then((r) => r.json()).then((s) => {
  if (!s.available) setStatus(s.message);
}).catch(() => {});
