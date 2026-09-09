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
 *   { attempted, ok, engine, errors, missingPackages, droppedPackages,
 *     reason, pdf, sourceSha }
 */

import { unsafeConstructs } from './validate.js';

const ENGINE_JS = '/vendor/PdfTeXEngine.js';
const TEXLIVE_ENDPOINT = '/';        // resolves to /pdftex/<format>/<name>

// engine.py has LATEX_COMPILE_TIMEOUT (120s) and gunicorn's own ceiling above
// it. Nothing bounded the browser compile until a mis-resolved worker path
// made loadEngine() hang forever with no error -- so both waits are bounded
// here, and both report rather than stall.
const COMPILE_TIMEOUT_MS = 120_000;
// Loading the engine means fetching a 9.88 MB format file, so this bounds a
// DOWNLOAD and not a computation -- and it was set as though it bounded a
// computation. Measured on an emulated phone at 1.6 Mbps, a cold engine load
// took 55 s of the 60 s allowed; a slower connection than that failed outright
// with "the engine could not be loaded" on a document that was never the
// problem. Sized now for the fetch: three minutes covers roughly 0.5 Mbps,
// and a user on less than that is not being helped by giving up sooner.
const ENGINE_LOAD_TIMEOUT_MS = 180_000;

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

/**
 * Remove packages the tree does not carry from a document's preamble.
 *
 * WHY. The shipped TeX Live tree is a subset -- 119 .sty files -- and the
 * model is not told which ones exist, so it can name one that does not. The
 * commonest is `\usepackage{utf8}`, which is not a package at all: utf8 is an
 * OPTION to inputenc. One wrong line in the preamble costs the whole preview,
 * even though every other line of the document is fine.
 *
 * A line loading several packages keeps the ones that do exist rather than
 * being dropped whole, so `\usepackage{utf8,amsmath}` does not take amsmath
 * with it. Only a line with nothing left goes.
 *
 * The .tex the user downloads is NOT this. This rewrite exists to get a
 * preview out of a document that would otherwise render nothing; what they
 * keep is what the model wrote.
 */
export function dropPackages(tex, names) {
  if (!names || !names.length) return tex || '';
  const missing = new Set(names);
  const out = [];
  for (const line of (tex || '').split('\n')) {
    const match = line.match(/^(\s*)\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]*)\}(.*)$/);
    if (!match) { out.push(line); continue; }
    const [, indent, options, list, trailer] = match;
    const asked = list.split(',').map((name) => name.trim()).filter(Boolean);
    const kept = asked.filter((name) => !missing.has(name));
    if (!kept.length) continue;
    if (kept.length === asked.length) { out.push(line); continue; }
    out.push(`${indent}\\usepackage${options || ''}{${kept.join(',')}}${trailer}`);
  }
  return out.join('\n');
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
    missingPackages: [], droppedPackages: [], pdf: null, sourceSha: null,
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
  const first = await attempt(tex, { allowFileAccess });
  // Nothing to repair: it worked, or it never ran, or it failed for a reason
  // that has nothing to do with a package being absent.
  if (first.ok || !first.attempted || !first.missingPackages.length) return first;

  const repaired = dropPackages(tex, first.missingPackages);
  if (repaired === tex) return first;

  const second = await attempt(repaired, { allowFileAccess });
  // A repair that does not produce a document is not an improvement, and the
  // second failure is about a source the user never wrote. Report the first.
  if (!second.ok) return first;

  return {
    ...second,
    // sourceSha identifies the .tex, which is the one the user keeps -- not
    // the rewritten source this PDF was actually built from.
    sourceSha: await sourceSha(tex),
    droppedPackages: first.missingPackages,
  };
}

async function attempt(tex, { allowFileAccess = false } = {}) {
  const unsafe = allowFileAccess ? [] : unsafeConstructs(tex);
  if (unsafe.length) return refusal(unsafe);

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    return {
      attempted: false, ok: false, engine: null, errors: '',
      missingPackages: [], droppedPackages: [], pdf: null, sourceSha: null,
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
      missingPackages: [], droppedPackages: [], pdf: null, sourceSha: null,
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
    droppedPackages: [],
    reason: null,
    pdf: ok ? result.pdf : null,
    sourceSha: ok ? await sourceSha(tex) : null,
    log,
  };
}
