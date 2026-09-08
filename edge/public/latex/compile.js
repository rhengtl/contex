/**
 * Compiling a document -- the browser replacement for
 * contex/pipeline/latex/engine.py.
 *
 * The engine is SwiftLaTeX's pdfTeX built to WebAssembly, and the TeX Live
 * tree is served as ordinary static files from /texmf/. Both run on the
 * viewer's machine, so there is no compile queue, no 300 s server timeout, and
 * no 1 GB TeX installation to host.
 *
 * compile() returns the same shape engine.py's compile_tex() does, so callers
 * that already handle "no engine installed" handle "no WASM support" the same
 * way:
 *   { attempted, ok, engine, errors, missingPackages, reason, pdf, sourceSha }
 */

import { unsafeConstructs } from './validate.js';

const ENGINE_JS = '/vendor/PdfTeXEngine.js';
const TEXLIVE_ENDPOINT = '/';        // resolves to /pdftex/<format>/<name>

// engine.py has LATEX_COMPILE_TIMEOUT (120s) and gunicorn's own ceiling above
// it. Nothing bounded the browser compile until a mis-resolved worker path
// made loadEngine() hang forever with no error -- so both waits are bounded
// here, and both report rather than stall.
const COMPILE_TIMEOUT_MS = 120_000;
const ENGINE_LOAD_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

let enginePromise = null;

/** Lines that matter when a compile fails -- engine.py _ERROR_LINE. */
const ERROR_LINE = new RegExp(
  '^(?:!' +
  '|.*?:\\d+:' +
  '|l\\.\\d+' +
  '|.*?\\bUndefined control sequence\\b' +
  '|.*?\\bLaTeX Error\\b' +
  '|.*?\\bEmergency stop\\b' +
  '|.*?\\bRunaway argument\\b' +
  '|.*?\\bFile .*? not found\\b)');

/** Condense a TeX log into just the error-bearing lines. */
export function extractErrors(log, maxLines = 40) {
  if (!log) return '';
  const kept = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_LINE.test(lines[i].trim())) {
      // TeX puts the offending source on the following lines.
      for (const raw of lines.slice(i, i + 3)) {
        const context = raw.replace(/\s+$/, '');
        if (context && !kept.includes(context)) kept.push(context);
      }
    }
    if (kept.length >= maxLines) break;
  }
  if (!kept.length) {
    // No recognisable error line - fall back to the tail of the log, where
    // TeX reports fatal stops.
    for (const raw of lines.slice(-maxLines)) {
      const t = raw.replace(/\s+$/, '');
      if (t.trim()) kept.push(t);
    }
  }
  return kept.slice(0, maxLines).join('\n');
}

/** Package names the engine could not find -- engine.py missing_packages(). */
export function missingPackages(log) {
  const names = new Set();
  for (const m of (log || '').matchAll(/File [`']([^'`]+)\.sty' not found/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** Identity of a LaTeX source, used to match a cached PDF to its .tex. */
export async function sourceSha(tex) {
  const bytes = new TextEncoder().encode(tex || '');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * One engine instance, reused across compiles. Creating it is cheap; what is
 * not cheap is the 9.88 MB format file it fetches, which is why /vendor/ and
 * /texmf/ are served immutable and long-lived (see public/_headers).
 */
async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (typeof WebAssembly === 'undefined') throw new Error('no-wasm');
    if (typeof window.PdfTeXEngine === 'undefined') await loadScript(ENGINE_JS);
    const engine = new window.PdfTeXEngine();
    await withTimeout(engine.loadEngine(), ENGINE_LOAD_TIMEOUT_MS, 'engine-load-timeout');
    engine.setTexliveEndpoint(new URL(TEXLIVE_ENDPOINT, location.origin).href);
    return engine;
  })().catch((err) => { enginePromise = null; throw err; });
  return enginePromise;
}

function refusal(unsafe) {
  return {
    attempted: false, ok: false, engine: 'pdftex.wasm', errors: '',
    missingPackages: [], pdf: null, sourceSha: null,
    reason: 'This document asks LaTeX to reach outside itself (' +
            unsafe.join(', ') + '), so it was not compiled. The .tex file is ' +
            'unchanged and can still be downloaded and compiled wherever you ' +
            'trust it.',
  };
}

/**
 * Compile LaTeX source to a PDF.
 *
 * The unsafe-construct check runs first and refuses before the engine ever
 * sees the document, exactly as engine.py does -- attempted:false, because
 * nothing was run.
 */
export async function compile(tex, { allowFileAccess = false } = {}) {
  const unsafe = allowFileAccess ? [] : unsafeConstructs(tex);
  if (unsafe.length) return refusal(unsafe);

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    return {
      attempted: false, ok: false, engine: null, errors: '',
      missingPackages: [], pdf: null, sourceSha: null,
      reason: err.message === 'no-wasm'
        ? 'This browser cannot run the LaTeX engine, so no preview was built. ' +
          'The .tex file is unchanged and can still be downloaded.'
        : 'The LaTeX engine could not be loaded, so no preview was built. ' +
          'The .tex file is unchanged and can still be downloaded.',
    };
  }

  let result;
  try {
    engine.writeMemFSFile('main.tex', tex);
    engine.setEngineMainFile('main.tex');
    result = await withTimeout(engine.compileLaTeX(), COMPILE_TIMEOUT_MS,
                               'compile-timeout');
  } catch (err) {
    // A crashed or wedged engine must not poison later compiles.
    enginePromise = null;
    try { engine.closeWorker(); } catch { /* already gone */ }
    const timedOut = err && err.message === 'compile-timeout';
    return {
      attempted: true, ok: false, engine: 'pdftex.wasm', errors: '',
      missingPackages: [], pdf: null, sourceSha: null,
      reason: timedOut
        ? `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`
        : `Could not run the LaTeX engine: ${err && err.message || err}`,
    };
  }

  const log = result.log || '';
  const ok = result.status === 0 && !!result.pdf;
  return {
    attempted: true,
    ok,
    engine: 'pdftex.wasm',
    errors: ok ? '' : extractErrors(log),
    missingPackages: ok ? [] : missingPackages(log),
    reason: null,
    pdf: ok ? result.pdf : null,
    sourceSha: ok ? await sourceSha(tex) : null,
    log,
  };
}
