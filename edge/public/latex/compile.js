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

// WHERE THE TIME GOES. Measured 2026-10-16, cold cache, the source of a real
// conversion (maxresdefault.jpg, a page of worked word problems):
//
//                        unthrottled   1.6 Mbps   0.7 Mbps
//   loadEngine()             90 ms       10.0 s        --       1.78 MB, 3 files
//   first compileLaTeX()    489 ms       60.4 s   >120 s        10.28 MB, 34 files
//   second compileLaTeX()    53 ms         80 ms       --       nothing
//
// The engine fetches every TeX file -- the 9.88 MB format first -- lazily,
// INSIDE compileLaTeX(), one synchronous request at a time. So the compile
// deadline below was timing a download, and a phone under ~0.8 Mbps got
// "Compilation timed out after 120s" on a document TeX builds in half a
// second. Worse, "Reload preview" could never recover: the timed-out worker
// was only asked to close (it cannot hear that mid-request), so it went on
// downloading as an orphan while a fresh worker started the same 9.88 MB
// again from nothing. Reproduced: two consecutive 120 s timeouts at 0.7 Mbps.
//
// So the files every document needs are now downloaded HERE, asynchronously,
// in parallel, with progress and a stall deadline, kept for the life of the
// page, and handed to the worker before it compiles (the `preload` command,
// tools/patch-engine.mjs). The compile deadline is left measuring TeX.

const limits = {
  // TeX work plus the occasional small package nobody preloaded. A typical
  // document needs well under a second; reaching this means the source itself
  // does not terminate.
  COMPILE_TIMEOUT_MS: 120_000,
  // The worker script and WASM binary, 1.78 MB. It used to be described as
  // bounding the format download; it never did -- see above.
  ENGINE_LOAD_TIMEOUT_MS: 180_000,
  // The preload download is bounded by PROGRESS, not by a fixed time: a slow
  // link that is still delivering is left to finish, and one that has
  // delivered nothing for this long has stopped.
  DOWNLOAD_STALL_MS: 30_000,
  // And an outer bound, so nothing waits forever: 10.6 MB in ten minutes is
  // ~0.15 Mbps.
  DOWNLOAD_DEADLINE_MS: 600_000,
  DOWNLOAD_CONCURRENCY: 4,
};

/**
 * Change the limits above -- for the test suite, which cannot wait two
 * minutes per case, and for diagnosing a slow device from the console.
 * Unknown keys are refused rather than silently ignored.
 */
export function setLimits(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits) || !(Number(value) > 0)) throw new Error(`bad limit: ${key}`);
    limits[key] = Number(value);
  }
  return { ...limits };
}

/**
 * Files a typical document needs, as the worker names them (<format>/<name>,
 * under /pdftex/): every request two real conversions made -- an article with
 * amsmath, amsfonts/amssymb, inputenc, \section headings, \huge, and inline
 * and displayed maths. About 10.6 MB, nearly all of it the format. The .vf
 * entries do not exist; downloading them answers 404 and they are recorded as
 * absent, which saves the worker a blocking round trip each. Anything else a
 * document asks for by name is fetched before its compile too (filesFor()).
 */
export const PRELOAD = [
  '10/swiftlatexpdftex.fmt',
  '11/pdftex.map',
  '26/article.cls', '26/size10.clo', '26/l3backend-pdfmode.def', '26/inputenc.sty',
  '26/amsmath.sty', '26/amsbsy.sty', '26/amsgen.sty', '26/amsopn.sty', '26/amstext.sty',
  '26/amsfonts.sty', '26/amssymb.sty', '26/umsa.fd', '26/umsb.fd',
  '3/cmbx10', '3/cmbx12', '3/cmr12', '3/cmex7',
  '3/msam5', '3/msam7', '3/msam10', '3/msbm5', '3/msbm7', '3/msbm10',
  '32/cmr10.pfb', '32/cmmi10.pfb', '32/cmsy10.pfb', '32/cmbx10.pfb', '32/cmbx12.pfb',
  '33/cmr10.vf', '33/cmmi10.vf', '33/cmsy10.vf', '33/cmbx10.vf', '33/cmbx12.vf',
];

/**
 * The class and packages a source names, as worker keys -- fetched before its
 * compile so they are not fetched during it. A name that does not exist
 * answers 404 and is recorded as absent, so "package not found" is immediate
 * too. Comments are ignored; only plain names are taken (no paths).
 */
export function filesFor(tex) {
  const source = (tex || '').replace(/(^|[^\\])%.*$/gm, '$1');
  const keys = new Set();
  const cls = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(source);
  if (cls) keys.add(`26/${cls[1].trim()}.cls`);
  for (const m of source.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (/^[A-Za-z0-9._-]+$/.test(n)) keys.add(`26/${n}.sty`);
    }
  }
  return [...keys].filter((k) => /^26\/[A-Za-z0-9._-]+\.(?:cls|sty)$/.test(k));
}

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

// ---------------------------------------------------------------------------
// The preload download
// ---------------------------------------------------------------------------

// key -> ArrayBuffer, or null for a file that does not exist. Lives as long
// as the page, NOT as long as an engine: a worker that is discarded after a
// failure takes nothing with it, and the next one is handed the same bytes.
const texFiles = new Map();
let downloadPromise = null;
// Whoever is waiting on the download right now, for progress. One at a time,
// because compiles are queued (see compile()).
let progressListener = null;
const progressState = { loaded: 0, total: 0 };

function report() {
  if (progressListener) {
    try { progressListener({ ...progressState }); } catch { /* the listener's problem */ }
  }
}

class DownloadError extends Error {
  constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail || ''; }
}

/** One file, streamed, abandoned if it stops making progress. */
async function fetchTexFile(key, group, onBytes) {
  const own = new AbortController();
  let stalled = false;
  const stop = () => own.abort();
  group.signal.addEventListener('abort', stop, { once: true });
  let timer = setTimeout(() => { stalled = true; own.abort(); }, limits.DOWNLOAD_STALL_MS);
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; own.abort(); }, limits.DOWNLOAD_STALL_MS);
  };
  try {
    const res = await fetch(new URL(`pdftex/${key}`, new URL(TEXLIVE_ENDPOINT, location.origin)),
                            { signal: own.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new DownloadError('download-failed', `${key}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onBytes(value.length);
      poke();
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out.buffer;
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    if (stalled) throw new DownloadError('download-stalled', key);
    if (group.signal.aborted) throw new DownloadError(group.reason || 'download-failed', key);
    throw new DownloadError('download-failed', `${key}: ${err && err.message || err}`);
  } finally {
    clearTimeout(timer);
    group.signal.removeEventListener('abort', stop);
  }
}

/**
 * Fetch whichever of `keys` this page does not have yet. Downloads run one
 * batch at a time: a second caller waits for the batch in progress and then
 * fetches only what is still missing, so nothing is ever downloaded twice.
 * What arrived before a failure is kept, so a retry resumes rather than
 * restarts.
 */
function downloadTexFiles(keys = PRELOAD) {
  const run = (downloadPromise || Promise.resolve()).catch(() => {})
    .then(() => fetchMissing(keys));
  downloadPromise = run;
  run.finally(() => { if (downloadPromise === run) downloadPromise = null; }).catch(() => {});
  return run;
}

async function fetchMissing(keys) {
  const todo = [...new Set(keys)].filter((key) => !texFiles.has(key));
  if (!todo.length) return;

  const group = new AbortController();
  group.reason = '';
  const deadline = setTimeout(() => {
    group.reason = 'download-timeout';
    group.abort();
  }, limits.DOWNLOAD_DEADLINE_MS);
  // Total for the progress line: the format dominates and its size is fixed,
  // so this is close before a single header has arrived.
  progressState.loaded = 0;
  progressState.total = (todo.includes(PRELOAD[0]) ? 10_400_000 : 0) + todo.length * 30_000;
  report();
  let next = 0;
  const lane = async () => {
    while (next < todo.length && !group.signal.aborted) {
      const key = todo[next++];
      const body = await fetchTexFile(key, group, (n) => {
        progressState.loaded += n;
        if (progressState.loaded > progressState.total) progressState.total = progressState.loaded;
        report();
      });
      texFiles.set(key, body);
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(limits.DOWNLOAD_CONCURRENCY, todo.length) }, lane));
  } catch (err) {
    // Stop the other lanes too: one stalled file means the connection has,
    // and their half-finished files would be discarded anyway.
    if (!group.reason) group.reason = err.kind || 'download-failed';
    group.abort();
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Hand a worker every downloaded file it does not already hold. Called once
 * when it loads (the preload set) and again before each compile (whatever
 * that document named).
 */
function preloadInto(engine) {
  if (!engine.given) engine.given = new Set();
  const files = {};
  let count = 0;
  for (const [key, body] of texFiles) {
    if (engine.given.has(key)) continue;
    files[key] = body;                                     // copied, not moved
    count += 1;
  }
  if (!count) return Promise.resolve(0);
  for (const key of Object.keys(files)) engine.given.add(key);
  return new Promise((resolve) => {
    const worker = engine.latexWorker;
    worker.onmessage = (ev) => {
      if (ev.data && ev.data.cmd === 'preload') {
        worker.onmessage = () => {};
        resolve(ev.data.count || 0);
      }
    };
    worker.postMessage({ cmd: 'preload', files });
  });
}

/**
 * Stop a worker NOW. The engine's own closeWorker() only posts a message
 * asking the worker to close itself, which a worker blocked in a synchronous
 * compile or download cannot read until it is done -- that is how a timed-out
 * compile used to keep running, and downloading, behind the next one.
 */
function discardEngine(engine) {
  try { if (engine && engine.latexWorker) engine.latexWorker.terminate(); } catch { /* gone */ }
  if (engine) engine.latexWorker = undefined;
}

/**
 * One engine instance, reused across compiles, and only ever handed out
 * already holding the preload files -- so its first compile downloads nothing
 * those files cover. The worker loads while the files download.
 */
async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (typeof WebAssembly === 'undefined') throw new Error('no-wasm');
    const files = downloadTexFiles();
    files.catch(() => {});      // awaited below; never an unhandled rejection
    if (typeof window.PdfTeXEngine === 'undefined') await loadScript(ENGINE_JS);
    const engine = new window.PdfTeXEngine();
    try {
      await withTimeout(engine.loadEngine(), limits.ENGINE_LOAD_TIMEOUT_MS, 'engine-load-timeout');
      engine.setTexliveEndpoint(new URL(TEXLIVE_ENDPOINT, location.origin).href);
      await files;
      await withTimeout(preloadInto(engine), limits.ENGINE_LOAD_TIMEOUT_MS, 'engine-load-timeout');
    } catch (err) {
      discardEngine(engine);
      throw err;
    }
    return engine;
  })().catch((err) => { enginePromise = null; throw err; });
  return enginePromise;
}

/**
 * Start loading the engine and its files without compiling anything. Called
 * when a conversion starts, so the download overlaps the conversion instead
 * of following it. Harmless to call twice; a failure here is reported by the
 * compile that needs the engine, not by this.
 */
export function warm() {
  getEngine().catch(() => {});
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
// One compile at a time. There is one engine and it can run one compile: a
// second compileLaTeX() on a busy engine throws "Engine is still spinning",
// and the error handling below used to answer ANY throw by discarding the
// engine -- the one the first compile was still running on. "Reload preview"
// pressed during a slow compile did exactly that. Queued instead, and a
// request for a source that is already being compiled joins that compile
// rather than repeating it.
let queue = Promise.resolve();
const inFlight = new Map();

export function compile(tex, { allowFileAccess = false, onProgress = null } = {}) {
  const key = `${allowFileAccess ? 1 : 0}\n${tex || ''}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = queue.then(async () => {
    progressListener = onProgress;
    try {
      return await compileNow(tex, { allowFileAccess });
    } finally {
      progressListener = null;
    }
  });
  queue = job.catch(() => {});
  inFlight.set(key, job);
  job.finally(() => inFlight.delete(key)).catch(() => {});
  return job;
}

async function compileNow(tex, { allowFileAccess }) {
  const started = performance.now();
  const result = await compileOnce(tex, { allowFileAccess });
  // One line per compile, for whoever is reading the console or a bug report:
  // what happened and where the time went. No document text.
  console.info(`[compile] ${result.ok ? 'ok' : (result.failure || 'error')} `
    + `phase=${result.phase || 'compile'} total=${Math.round(performance.now() - started)}ms `
    + `engine=${result.timing ? result.timing.engineMs : '-'}ms `
    + `tex=${result.timing ? result.timing.compileMs : '-'}ms bytes=${(tex || '').length}`);
  return result;
}

async function compileOnce(tex, { allowFileAccess = false } = {}) {
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

  const engineStart = performance.now();
  let engine;
  try {
    engine = await getEngine();
    // What this document names beyond the preload set, fetched now and handed
    // over, so its compile does not fetch it synchronously against the
    // compile deadline.
    await downloadTexFiles(filesFor(tex));
    await withTimeout(preloadInto(engine), limits.ENGINE_LOAD_TIMEOUT_MS, 'engine-load-timeout');
  } catch (err) {
    const kind = err && (err.kind || err.message);
    const mb = (n) => (n / 1048576).toFixed(1);
    const download = kind === 'download-stalled' || kind === 'download-timeout'
      || kind === 'download-failed';
    return {
      attempted: false, ok: false, engine: null, errors: '',
      missingPackages: [], droppedPackages: [], pdf: null, sourceSha: null,
      phase: download ? 'download' : 'load',
      failure: kind || 'engine-load-failed',
      reason: kind === 'no-wasm'
        ? 'This browser cannot run the LaTeX engine, so no preview was built. ' +
          'The .tex file is unchanged and can still be downloaded.'
        : download
          ? `The LaTeX engine's files stopped downloading (${mb(progressState.loaded)} of `
            + `about ${mb(progressState.total)} MB arrived), so no preview was built. `
            + 'What arrived is kept: check the connection and press Reload preview '
            + 'to continue. The .tex file is unchanged and can still be downloaded.'
          : 'The LaTeX engine could not be loaded, so no preview was built. ' +
            'The .tex file is unchanged and can still be downloaded.',
    };
  }
  const engineMs = Math.round(performance.now() - engineStart);

  let result;
  const compileStart = performance.now();
  try {
    engine.writeMemFSFile('main.tex', tex);
    engine.setEngineMainFile('main.tex');
    result = await withTimeout(engine.compileLaTeX(), limits.COMPILE_TIMEOUT_MS,
                               'compile-timeout');
  } catch (err) {
    // A crashed or wedged engine must not poison later compiles -- and must
    // actually stop, rather than run on behind the next one. The preload
    // files stay, so its replacement starts with them.
    enginePromise = null;
    discardEngine(engine);
    const timedOut = err && err.message === 'compile-timeout';
    return {
      attempted: true, ok: false, engine: 'pdftex.wasm', errors: '',
      missingPackages: [], droppedPackages: [], pdf: null, sourceSha: null,
      phase: 'compile',
      failure: timedOut ? 'compile-timeout' : 'engine-crashed',
      timing: { engineMs, compileMs: Math.round(performance.now() - compileStart) },
      reason: timedOut
        ? `Compilation timed out after ${limits.COMPILE_TIMEOUT_MS / 1000}s: LaTeX did not `
          + 'finish this document.'
        : `Could not run the LaTeX engine: ${err && err.message || err}`,
    };
  }

  const log = result.log || '';
  // How many files the worker failed to fetch during this compile -- a font
  // nobody preloaded, on a link that has died (tools/patch-engine.mjs).
  const netfail = result.netfail | 0;
  // A PDF is only a PDF if it says so. An empty or truncated buffer from a
  // compile that reported success would otherwise reach pdf.js as a document.
  const pdfOk = !!result.pdf && result.pdf.length > 4
    && result.pdf[0] === 0x25 && result.pdf[1] === 0x50
    && result.pdf[2] === 0x44 && result.pdf[3] === 0x46;     // %PDF
  const ok = result.status === 0 && pdfOk;
  // A file that could not be FETCHED looks to TeX exactly like one that does
  // not exist. Reported as what it was -- and not offered to the missing-
  // package repair, which would strip a package that is really there.
  const network = !ok && netfail > 0;
  return {
    attempted: true,
    ok,
    engine: 'pdftex.wasm',
    errors: ok ? '' : extractErrors(log),
    missingPackages: ok || network ? [] : missingPackages(log),
    droppedPackages: [],
    reason: network
      ? `${netfail} of LaTeX's files could not be downloaded during the compile, `
        + 'so no preview was built. Check the connection and press Reload preview. '
        + 'The .tex file is unchanged and can still be downloaded.'
      : ok || result.status !== 0 ? null
        : 'LaTeX reported success but produced no readable PDF.',
    phase: 'compile',
    failure: ok ? null
      : network ? 'download-failed'
        : (result.status === 0 ? 'invalid-pdf' : 'latex-error'),
    timing: { engineMs, compileMs: Math.round(performance.now() - compileStart) },
    pdf: ok ? result.pdf : null,
    sourceSha: ok ? await sourceSha(tex) : null,
    log,
  };
}
