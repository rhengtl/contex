/**
 * The PDF preview's compile path, under the conditions that broke it.
 *
 *     npm run test:compile
 *
 * THE FAILURE. "Compilation timed out after 120s" on a page of word problems
 * (maxresdefault.jpg, 2026-10-16). TeX builds that document in half a second.
 * The engine fetched the 9.88 MB format and every package lazily, INSIDE
 * compileLaTeX(), one synchronous request at a time, so the compile deadline
 * was timing a download: 60 s at 1.6 Mbps, over 120 s below ~0.8 Mbps. And a
 * retry could never win -- the timed-out worker was only asked to close (it
 * cannot hear that mid-request) and went on downloading, while its
 * replacement started the same 9.88 MB from nothing. Reproduced before the
 * fix: two consecutive 120 s timeouts at 0.7 Mbps.
 *
 * Every case here drives the real shipped compile.js and the real engine in a
 * real browser, through tests/harness.html. Each case gets a fresh browser
 * context, so a fresh HTTP cache and fresh module state: a cold first visit.
 * Network conditions are imposed with the DevTools protocol, which does reach
 * the engine worker's requests (verified: 1.6 Mbps turned a 0.5 s cold compile
 * into 60 s).
 */
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? '  ::  ' + detail : ''}`);
};
const heading = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 58 - t.length))}`);

const SIMPLE = String.raw`\documentclass{article}
\begin{document}
Hello.
\end{document}
`;

// The shape of the document that timed out: sections, word problems,
// fractions, inline and displayed equations, amsmath, utf8 input.
const WORD_PROBLEMS = String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\begin{document}
\section*{Writing Equations from Word Problems}
\subsection*{Example 1}
Half of a number is 16. Write an equation to represent this situation.
Define your variable and solve. Let $n$ = the number.
\[
\frac{1}{2}n = 16 \qquad \Rightarrow \qquad n = 32
\]
\subsection*{Example 2}
Mrs.\ Gaddie has two dogs. Her friend Anna-Marie has three less than twice as
many as Mrs.\ Gaddie. How many dogs does Anna-Marie have?
\begin{align*}
d &= 2(2) - 3 \\
d &= 1
\end{align*}
\end{document}
`;

// What a real conversion of maxresdefault.jpg produced (gemini-3.5-flash-lite).
const CONVERTED = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{amsfonts}
\usepackage{amssymb}
\begin{document}
\begin{center}
\textbf{\huge Writing Equations from Word Problems} \hfill 8/17/2012
\end{center}
\noindent \textbf{Ex:} \underline{Half \fbox{of} a number} \fbox{is} \underline{16}.
Write an equation to represent this situation. Define your variable and solve.
\noindent $n = \text{the number}$ \hfill
$\begin{aligned}
\frac{1}{2}n &= 16 \\
\div \frac{1}{2} \quad &\div \frac{1}{2}
\end{aligned}$ \hfill \fbox{$n = 32$}
\end{document}
`;

// Fails fast and fatally: a brace closes the group around an open array.
const INVALID = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\[ { \left[ \begin{array}{c} x }}\right.\end{array} \]
\end{document}
`;

// Never terminates: a macro that expands to itself, forever, in constant
// memory. Nothing a timeout of any length would rescue.
const NON_TERMINATING = String.raw`\documentclass{article}
\begin{document}
\def\x{\x}\x
\end{document}
`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function freshPage({ mbps = 0, latency = 0 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Record the engine's workers: how many compiles each was asked for, and
  // whether it was really terminated rather than asked to close.
  await page.addInitScript(() => {
    window.__workers = [];
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url, ...rest) {
        super(url, ...rest);
        const rec = { url: String(url), compiles: 0, terminated: false };
        if (rec.url.includes('swiftlatex')) window.__workers.push(rec);
        const terminate = this.terminate.bind(this);
        this.terminate = () => { rec.terminated = true; terminate(); };
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...more) => {
          if (message && message.cmd === 'compilelatex') rec.compiles += 1;
          post(message, ...more);
        };
      }
    };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const throttle = (down, lat = latency) => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: lat,
    downloadThroughput: down ? down * 1e6 / 8 : -1, uploadThroughput: -1,
  });
  if (mbps) await throttle(mbps);
  await page.goto(`${BASE}/tests/harness.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true, { timeout: 120000 });
  return { context, page, throttle };
}

const requests = async () => (await (await fetch(`${BASE}/__log`)).json())
  .filter((r) => r.path.startsWith('/pdftex/'));
const reset = () => fetch(`${BASE}/__reset`);

/** compile() in the page, with only what the assertions need coming back. */
const compileIn = (page, tex, limits = null) => page.evaluate(async ({ tex, limits }) => {
  const mod = await import('/latex/compile.js');
  if (limits) mod.setLimits(limits);
  const t0 = performance.now();
  const r = await mod.compile(tex);
  return {
    ok: r.ok, attempted: r.attempted, failure: r.failure || null, phase: r.phase || null,
    reason: r.reason, errors: (r.errors || '').slice(0, 300), timing: r.timing || null,
    pdfHead: r.pdf ? String.fromCharCode(...r.pdf.slice(0, 5)) : '',
    pdfBytes: r.pdf ? r.pdf.length : 0,
    ms: Math.round(performance.now() - t0),
  };
}, { tex, limits });

// ---------------------------------------------------------------------------
heading('documents that should build, do');
// ---------------------------------------------------------------------------
{
  const { context, page } = await freshPage();
  for (const [label, tex] of [['a minimal document', SIMPLE],
                              ['the word-problem document', WORD_PROBLEMS],
                              ['the real conversion of maxresdefault.jpg', CONVERTED]]) {
    const r = await compileIn(page, tex);
    check(`${label} compiles to a PDF`, r.ok && r.pdfHead === '%PDF-', JSON.stringify(r));
  }
  const warm = await compileIn(page, WORD_PROBLEMS);
  check('a warm compile is fast (under 2 s)', warm.ok && warm.ms < 2000, `${warm.ms} ms`);
  await context.close();
}

// ---------------------------------------------------------------------------
heading('the engine files arrive before the compile, once');
// ---------------------------------------------------------------------------
{
  const { context, page } = await freshPage();
  await reset();
  const r = await compileIn(page, WORD_PROBLEMS);
  const fmt = (await requests()).filter((q) => q.path.endsWith('.fmt'));
  check('a cold compile succeeds', r.ok, JSON.stringify(r));
  // serve.mjs answers /pdftex/ with no-cache, so a worker that fetched the
  // format itself would show up here as a second request.
  check('the 9.88 MB format is downloaded exactly once, by the page',
        fmt.length === 1, `${fmt.length} requests`);
  check('and the compile itself is TeX, not a download (under 5 s)',
        r.timing && r.timing.compileMs < 5000, JSON.stringify(r.timing));
  await reset();
  await compileIn(page, CONVERTED);
  const again = await requests();
  check('a second document re-downloads nothing it already has',
        !again.some((q) => q.path.endsWith('.fmt') || q.path.endsWith('amsmath.sty')),
        again.map((q) => q.path).join(' '));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('the original failure: a download longer than the compile deadline');
// ---------------------------------------------------------------------------
// Scaled down from 120 s at 0.7 Mbps: a 15 s compile deadline against a
// 2 Mbps link needs ~45 s for the files. Before the fix the download ran
// inside compileLaTeX() and this was "Compilation timed out after 15s"; the
// deadline must now see only TeX.
{
  const { context, page } = await freshPage({ mbps: 2, latency: 100 });
  const r = await compileIn(page, WORD_PROBLEMS, { COMPILE_TIMEOUT_MS: 15000 });
  check('a cold compile on a slow link no longer times out', r.ok, JSON.stringify(r));
  check('the download took longer than the compile deadline (the old failure)',
        r.timing && r.timing.engineMs > 15000, JSON.stringify(r.timing));
  check('and the compile itself stayed inside it',
        r.timing && r.timing.compileMs < 15000, JSON.stringify(r.timing));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('a stalled download fails promptly, and a retry resumes');
// ---------------------------------------------------------------------------
{
  const { context, page } = await freshPage();
  // A dead link for the one big file: the request is made and never answered.
  // Everything else is served, so the other download lanes finish.
  const hang = async () => { /* never fulfilled */ };
  await page.route('**/pdftex/10/swiftlatexpdftex.fmt', hang);
  await reset();
  const t0 = Date.now();
  const stalled = await compileIn(page, WORD_PROBLEMS, { DOWNLOAD_STALL_MS: 3000 });
  const waited = Date.now() - t0;
  check('a download that stops delivering is reported as stalled',
        !stalled.ok && stalled.failure === 'download-stalled' && stalled.phase === 'download',
        JSON.stringify(stalled));
  check('within the stall limit, not after a fixed two minutes',
        waited < 15000, `${waited} ms`);
  check('the message says what happened and that a retry continues',
        /stopped downloading/.test(stalled.reason || '') && /Reload preview/.test(stalled.reason || ''),
        stalled.reason);
  check('and no engine compile was attempted on a half-downloaded engine',
        (await page.evaluate(() => window.__workers.reduce((n, w) => n + w.compiles, 0))) === 0);
  const before = (await requests()).map((q) => q.path);
  await page.unroute('**/pdftex/10/swiftlatexpdftex.fmt', hang);
  await reset();
  const retry = await compileIn(page, WORD_PROBLEMS);
  const fetched = (await requests()).map((q) => q.path);
  check('Reload after the connection returns builds the PDF', retry.ok, JSON.stringify(retry));
  check('and fetches only what had not already arrived',
        before.some((p) => p.endsWith('article.cls')) && !fetched.some((p) => p.endsWith('article.cls'))
        && fetched.some((p) => p.endsWith('.fmt')),
        `before: ${before.length} files; retry fetched ${fetched.map((p) => p.split('/').pop()).join(' ')}`);
  await context.close();
}

// ---------------------------------------------------------------------------
heading('a file fetched DURING the compile fails as a download, not a timeout');
// ---------------------------------------------------------------------------
// Italic is not in the preload set, so the worker fetches cmti10 itself,
// synchronously, mid-compile. On a dead link that used to be one 150 s
// request inside a 120 s compile deadline: "Compilation timed out".
const ITALIC = String.raw`\documentclass{article}
\begin{document}
\textit{Half of a number} is 16.
\end{document}
`;
for (const mode of ['503', 'drop']) {
  const { context, page } = await freshPage();
  await compileIn(page, SIMPLE);                      // engine and preload ready
  await fetch(`${BASE}/__fail?match=cmti10&mode=${mode}`);
  const t0 = Date.now();
  const r = await compileIn(page, ITALIC);
  const took = Date.now() - t0;
  await fetch(`${BASE}/__fail`);
  const label = mode === 'drop' ? 'a dropped connection' : 'a 503';
  check(`${label} is reported as files that could not be downloaded`,
        !r.ok && r.failure === 'download-failed' && /could not be downloaded/.test(r.reason || ''),
        JSON.stringify(r));
  check(`${label}: promptly, not at the compile deadline`, took < 40000, `${took} ms`);
  const ok = await compileIn(page, ITALIC);
  check(`${label}: once the file can be fetched, the same document builds`,
        ok.ok, JSON.stringify(ok));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('errors are errors, timeouts are timeouts');
// ---------------------------------------------------------------------------
{
  const { context, page } = await freshPage();
  await compileIn(page, SIMPLE);          // engine ready, so timings are TeX

  const bad = await compileIn(page, INVALID);
  check('invalid LaTeX is a LaTeX error', !bad.ok && bad.failure === 'latex-error',
        JSON.stringify(bad));
  check('reported promptly (under 5 s), not at a deadline', bad.ms < 5000, `${bad.ms} ms`);
  check('with the pdfTeX error attached', /Extra \}/.test(bad.errors), bad.errors);

  const t0 = Date.now();
  const stuck = await compileIn(page, NON_TERMINATING, { COMPILE_TIMEOUT_MS: 3000 });
  const took = Date.now() - t0;
  check('a document that never finishes is a compile timeout',
        !stuck.ok && stuck.failure === 'compile-timeout' && stuck.phase === 'compile',
        JSON.stringify(stuck));
  check('stopped at the configured deadline (3 s)', took >= 2900 && took < 8000, `${took} ms`);
  const workers = await page.evaluate(() => window.__workers.map((w) => ({ ...w })));
  check('the worker that was running it was terminated, not left running',
        workers.length === 1 && workers[0].terminated === true, JSON.stringify(workers));

  await reset();
  const after = await compileIn(page, WORD_PROBLEMS, { COMPILE_TIMEOUT_MS: 120000 });
  const refetched = (await requests()).filter((q) => q.path.endsWith('.fmt'));
  check('the next compile succeeds on a new worker', after.ok, JSON.stringify(after));
  check('which is handed the files already downloaded (no second 9.88 MB)',
        refetched.length === 0, `${refetched.length} format requests`);
  const now = await page.evaluate(() => window.__workers.map((w) => ({ ...w })));
  check('exactly one replacement worker, still alive',
        now.length === 2 && now[1].terminated === false, JSON.stringify(now));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('one engine, one compile at a time, no duplicate work');
// ---------------------------------------------------------------------------
{
  const { context, page } = await freshPage();
  const same = await page.evaluate(async (tex) => {
    const { compile } = await import('/latex/compile.js');
    const a = compile(tex);
    const b = compile(tex);
    const [ra, rb] = await Promise.all([a, b]);
    return { identical: a === b, ok: ra.ok && rb.ok,
             compiles: window.__workers.reduce((n, w) => n + w.compiles, 0) };
  }, WORD_PROBLEMS);
  check('the same source requested twice at once is compiled once',
        same.identical && same.ok && same.compiles === 1, JSON.stringify(same));

  const many = await page.evaluate(async (docs) => {
    const { compile } = await import('/latex/compile.js');
    const before = window.__workers.reduce((n, w) => n + w.compiles, 0);
    const out = await Promise.all(docs.map((d) => compile(d)));
    return { oks: out.map((r) => r.ok), reasons: out.map((r) => r.reason),
             compiles: window.__workers.reduce((n, w) => n + w.compiles, 0) - before,
             workers: window.__workers.length };
  }, [SIMPLE, CONVERTED, INVALID]);
  // Before: the second compileLaTeX() on a busy engine threw "Engine is still
  // spinning", and the handler discarded the engine the first was using.
  check('different sources at once are queued, not collided',
        many.oks[0] && many.oks[1] && !many.oks[2] && many.compiles === 3,
        JSON.stringify(many));
  check('and nobody was told the engine was busy',
        !many.reasons.some((r) => /spinning|Could not run/.test(r || '')), JSON.stringify(many.reasons));
  check('on the one engine', many.workers === 1, `${many.workers} workers`);
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failing:');
  for (const f of failed) console.log(`  ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
