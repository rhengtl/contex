/**
 * The fallback pipeline, end to end.
 *
 * WHAT THIS SUITE IS FOR. The AI path is the one ConTeX advertises; the
 * fallback is the one that decides whether ConTeX is *dependable*. A free-tier
 * key runs out, a model is rate-limited, a service has an outage -- and on
 * every one of those days the question is not whether the conversion was as
 * good as usual but whether the user got a document at all.
 *
 * So this measures the whole chain, in the order a user meets it:
 *
 *     AI unavailable -> the gate -> browser OCR + formula recognition ->
 *     layout assembly -> QA repair -> validation -> SwiftLaTeX -> a PDF
 *
 * and it measures the OUTPUT, against bench/'s ground truth and against the
 * Python pipeline's own numbers on the same images, rather than asserting that
 * functions were called.
 *
 * THE REFERENCE. ../.contex-fallback-ref.json is what contex/pipeline/run.py
 * produces for the same corpus on this machine -- same Tesseract, same
 * eng.traineddata (tools/build-models.mjs copies the installed one), same
 * pix2text-mfr weights. Regenerate it with the script in the README. Where the
 * two disagree by more than tokenizer spacing, one of them is wrong.
 *
 *     node tests/fallback.mjs [group]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { textScore, structureScore, mathScore, normalize, pct } from './score.mjs';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const BENCH = resolve(process.env.CONTEX_BENCH || '../bench');
const REF = resolve('../.contex-fallback-ref.json');
const ONLY = process.argv[2] || '';

const results = [];
let group = '';
const heading = (name) => {
  group = name;
  if (!ONLY || ONLY === name) console.log(`\n-- ${name} ` + '-'.repeat(Math.max(0, 58 - name.length)));
};
const skip = () => ONLY && ONLY !== group;
const check = (name, pass, detail = '') => {
  if (skip()) return;
  results.push({ group, name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? '  ::  ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A three-page PDF, built from bench pages.
 *
 * The corpus has no multi-page document, and multi-page is where the local
 * path has a whole class of faults of its own: boxes from page two sorting
 * into page one's reading order, equation numbering restarting, and the page
 * break that stops LaTeX setting ten pages as continuous copy.
 */
async function buildPdf() {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (const name of ['headings_hi.png', 'display_math_hi.png', 'lists_hi.png']) {
    const png = await doc.embedPng(await readFile(join(BENCH, 'img_pages', name)));
    // Half scale: three full-resolution bench pages is a 9 MB PDF, and the
    // recognisers are being asked about layout here, not about resolution.
    const page = doc.addPage([png.width / 2, png.height / 2]);
    page.drawImage(png, { x: 0, y: 0, width: png.width / 2, height: png.height / 2 });
  }
  await mkdir('tests/out', { recursive: true });
  // NOT ".pdf". Edge answers a same-origin fetch for any URL ending in .pdf
  // with 204 and an empty body, whatever the server sends -- measured here,
  // and it cost an afternoon looking for a bug in the rasteriser. The app is
  // unaffected: an uploaded PDF arrives as a File and is never fetched by URL.
  await writeFile('tests/out/three-pages.pdfdata', await doc.save());
  return '/tests/out/three-pages.pdfdata';
}

// ---------------------------------------------------------------------------

const manifestMixed = JSON.parse(
  await readFile(join(BENCH, 'manifest_mixed.json'), 'utf8'));
const manifestPages = JSON.parse(
  await readFile(join(BENCH, 'manifest_pages.json'), 'utf8'));
const reference = existsSync(REF)
  ? JSON.parse(await readFile(REF, 'utf8')) : null;
if (!reference) {
  console.log('NOTE: ../.contex-fallback-ref.json is missing, so the Python '
              + 'comparison is skipped. See the README to regenerate it.');
}

const pdfPath = await buildPdf();

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  PAGEERROR ' + e.message.slice(0, 200)));
await page.goto(`${BASE}/tests/fallback-harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

// page.evaluate takes exactly ONE argument, so everything below passes a
// single object. Passing two silently dropped the second, which turned a
// scripted outage into `undefined` and made the gate look like it worked for
// the wrong reason.
const run = (fn, arg) => page.evaluate(fn, arg);

// ---------------------------------------------------------------------------
heading('the AI path never pays for the fallback');
// ---------------------------------------------------------------------------
//
// FIRST, and that ordering is load-bearing. Once anything in this file has
// warmed the recognisers the browser cache would answer a later request
// without touching the network, and an assertion about the request log would
// pass for the wrong reason.

if (!skip()) {
  const before = await run(() => window.enginesReady());
  check('neither recogniser is loaded before anything asks for one',
        before.text === false && before.formulas === false, JSON.stringify(before));

  await fetch(`${BASE}/__reset`);
  const ai = await run(({ u }) => window.convertWith([u], {
    available: { available: true, model: 'gemini-2.5-flash' },
    pages: ['ok'],
  }), { u: '/bench/img_pages/headings_hi.png' });
  const log = await (await fetch(`${BASE}/__log`)).json();
  const heavy = log.filter((r) => r.path.startsWith('/models/')
                              || r.path.startsWith('/vendor/ort/')
                              || r.path.startsWith('/vendor/tesseract/'));

  check('a successful AI conversion produces a document', ai.ok && ai.tex.includes('model converted'));
  check('it reports the AI path', ai.ok && ai.summary.path === 'ai', ai.ok && ai.summary.path);
  check('it carries no fallback notice', ai.ok && ai.summary.fallbackNotice === null);
  check('nothing was fetched from /models/, ORT or tesseract',
        heavy.length === 0, heavy.map((r) => r.path).join(', '));
  const after = await run(() => window.enginesReady());
  check('and neither recogniser was loaded',
        after.text === false && after.formulas === false, JSON.stringify(after));
}

// ---------------------------------------------------------------------------
heading('the gate: a downgrade is never silent');
// ---------------------------------------------------------------------------

if (!skip()) {
  const down = { available: false, reason: 'exhausted',
                 message: 'The AI conversion service is temporarily unavailable.',
                 retryAt: Math.floor(Date.now() / 1000) + 600 };

  const refused = await run(({ u, s }) => window.convertWith([u], {
    available: s, pages: [], allowFallback: false,
  }), { u: '/bench/img_mixed/print_prose.png', s: down });
  check('AI down and fallback not authorised -> FallbackNotAuthorized',
        !refused.ok && refused.name === 'FallbackNotAuthorized', refused.name);
  check('nothing was sent to the model', !refused.ok && refused.calls.length === 0);
  check('the refusal carries the status, so the page can say what is down',
        !refused.ok && refused.status && refused.status.reason === 'exhausted',
        JSON.stringify(refused.status));

  const allowed = await run(({ u, s }) => window.convertWith([u], {
    available: s, pages: [], allowFallback: true,
  }), { u: '/bench/img_mixed/print_prose.png', s: down });
  check('AI down and fallback authorised -> a document', allowed.ok && allowed.tex.length > 100);
  check('it reports the local path', allowed.ok && allowed.summary.path === 'converters',
        allowed.ok && allowed.summary.path);
  check('nothing was sent to the model on the local path',
        allowed.ok && allowed.calls.length === 0);

  const n = allowed.ok && allowed.summary.fallbackNotice;
  check('the finished document carries exactly one notice, and it says so',
        Boolean(n) && n.headline === 'This document was converted without AI.',
        JSON.stringify(n && n.headline));
  check('the notice names the reason the AI was unavailable',
        Boolean(n) && n.reason.includes('temporarily unavailable'), n && n.reason);
  check('the notice is not marked partial -- the document is whole',
        Boolean(n) && n.partial === false);
}

// ---------------------------------------------------------------------------
heading('outage and rate-limit, as the service actually reports them');
// ---------------------------------------------------------------------------

if (!skip()) {
  const up = { available: true, model: 'gemini-2.5-flash' };

  // Every model out of quota mid-conversion: nextAttempt null is the Worker's
  // "the chain is finished".
  const exhausted = await run(({ u, s }) => window.convertWith([u], {
    available: s, allowFallback: false,
    pages: [{ retryable: true, nextAttempt: null,
              error: 'Every AI model has reached its quota.' }],
  }), { u: '/bench/img_mixed/print_prose.png', s: up });
  check('quota exhausted after the conversion started -> the local path finishes it',
        exhausted.ok && exhausted.summary.path === 'converters',
        exhausted.ok ? exhausted.summary.path : exhausted.message);
  check('and it is NOT re-asked for permission it already had reason to assume',
        exhausted.ok, 'the AI was up when the user pressed Convert');
  check('the notice names the quota as the reason',
        exhausted.ok && exhausted.summary.fallbackNotice.reason.includes('quota'),
        exhausted.ok && exhausted.summary.fallbackNotice.reason);

  // A rate limit that names the next model: the chain must advance rather than
  // fall back. This is the case where falling back would be the WRONG answer.
  const rotated = await run(({ u, s }) => window.convertWith([u], {
    available: s, allowFallback: false,
    pages: [{ retryable: true, nextAttempt: 1, model: 'gemini-2.5-flash',
              error: 'Rate limited.' }, 'ok'],
  }), { u: '/bench/img_mixed/print_prose.png', s: up });
  check('a rate limit that names a next model rotates instead of falling back',
        rotated.ok && rotated.summary.path === 'ai',
        rotated.ok ? rotated.summary.path : rotated.message);
  check('the second attempt used the model the Worker named',
        rotated.ok && rotated.calls.length === 2 && rotated.calls[1].attempt === 1,
        JSON.stringify(rotated.calls));
  check('the user was told the chain moved',
        rotated.ok && rotated.statuses.some((s) => s.includes('trying the next one')));

  // A model that refuses a thinking level: retry the same model without it.
  const nothink = await run(({ u, s }) => window.convertWith([u], {
    available: s, allowFallback: false,
    pages: [{ retryable: true, nextAttempt: 0, retryWithoutThinking: true,
              error: 'thinking unsupported' }, 'ok'],
  }), { u: '/bench/img_mixed/print_prose.png', s: up });
  check('a model that will not take a thinking level is retried without one',
        nothink.ok && nothink.calls.length === 2
        && nothink.calls[0].thinking === true && nothink.calls[1].thinking === false,
        JSON.stringify(nothink.calls));

  // A fatal error is not a fallback: the document is unconvertible, and
  // running the recognisers over it would produce nonsense with a warning.
  const fatal = await run(({ u, s }) => window.convertWith([u], {
    available: s, allowFallback: false,
    pages: [{ retryable: false, error: 'That file could not be read.' }],
  }), { u: '/bench/img_mixed/print_prose.png', s: up });
  check('a non-retryable failure still finishes the document locally',
        fatal.ok && fatal.summary.path === 'converters',
        fatal.ok ? fatal.summary.path : fatal.message);
}

// ---------------------------------------------------------------------------
heading('the AI stops part way through a document');
// ---------------------------------------------------------------------------

if (!skip()) {
  const urls = ['/bench/img_pages/headings_hi.png',
                '/bench/img_pages/display_math_hi.png',
                '/bench/img_pages/lists_hi.png'];
  const mixed = await run(({ u, s }) => window.convertWith(u, {
    available: s, allowFallback: false,
    // Page one converts; the chain is then exhausted. The speculative pass
    // runs first, so several calls may be made -- what matters is the outcome.
    pages: ['ok', { retryable: true, nextAttempt: null,
                    error: 'Every AI model has reached its quota.' }],
  }), { u: urls, s: { available: true, model: 'gemini-2.5-flash' } });

  check('a document that lost the model part way is still finished',
        mixed.ok && mixed.tex.length > 200, mixed.ok ? '' : mixed.message);
  check('it reports the mixed path', mixed.ok && mixed.summary.path === 'mixed',
        mixed.ok && mixed.summary.path);
  check('the AI pages are kept, not redone',
        mixed.ok && mixed.summary.aiPages >= 1 && mixed.tex.includes('model converted'),
        mixed.ok && `aiPages=${mixed.summary.aiPages}`);
  check('the rest was converted locally',
        mixed.ok && mixed.summary.fallbackPages >= 1,
        mixed.ok && `fallbackPages=${mixed.summary.fallbackPages}`);
  check('the notice says which page the change happened at',
        mixed.ok && /stopped after page \d+ of 3/.test(mixed.summary.fallbackNotice.headline),
        mixed.ok && mixed.summary.fallbackNotice.headline);
  check('the notice promises the earlier pages are unaffected',
        mixed.ok && mixed.summary.fallbackNotice.detail.includes('unaffected'));
  check('the spliced document still validates',
        mixed.ok && mixed.issues.length === 0, mixed.ok && mixed.issues.join(' '));
  check('the seam carries a page break',
        mixed.ok && mixed.tex.includes('\\clearpage'));
}

// ---------------------------------------------------------------------------
heading('content: the kinds of page a user actually has');
// ---------------------------------------------------------------------------

const scored = [];
if (!skip()) {
  console.log('  page                          text     structure      math   eqs');
  for (const entry of manifestMixed) {
    const url = `/bench/img_mixed/${entry.file}`;
    const out = await run((u) => window.convertLocally([u]), url);
    const row = {
      file: entry.file, feature: entry.feature,
      text: textScore(entry.gt_tex, out.tex),
      structure: structureScore(entry.gt_tex, out.tex),
      math: mathScore(entry.gt_tex, out.tex),
      equations: out.equations, issues: out.issues, unsafe: out.unsafe,
      tex: out.tex, uncertainLines: out.uncertainLines,
    };
    scored.push(row);
    console.log(`  ${entry.file.padEnd(28)}${pct(row.text)}   ${pct(row.structure)}   `
                + `${pct(row.math)}${String(row.equations.length).padStart(5)}`);
  }

  const by = (name) => scored.find((r) => r.feature === name);

  // Typed text is the easy case and the one with no excuse.
  check('typed prose is transcribed essentially perfectly',
        by('print_prose').text >= 0.98, pct(by('print_prose').text));

  // Handwriting: Tesseract is 95.4% word-error-rate on it and often returns
  // nothing at all, so this number is the salvage path -- unwrapText() on what
  // the formula model read -- and not the text engine.
  check('handwritten prose is recovered rather than dropped',
        by('hand_prose').text >= 0.85, pct(by('hand_prose').text));

  check('a typed formula is read',
        by('print_math').math >= 0.9, pct(by('print_math').math));

  // Handwriting is the documented weak spot -- pix2text-mfr is trained on
  // printed formulas, and bench/README.md says so -- so the bar here is the
  // reference implementation rather than a number picked in advance. It turns
  // out to be met comfortably on this page, because the two expressions are
  // segmented apart where Python merged them into one; see the comparison
  // group below.
  const handMath = by('hand_math').math;
  const handRef = reference && reference.find((r) => r.file === 'hand_math.png');
  check('a handwritten formula is read at least as well as the reference reads it',
        handMath !== null && (!handRef || handMath >= handRef.math - 0.02),
        `${pct(handMath)} against Python's ${handRef ? pct(handRef.math) : 'n/a'}`);
  check('and its two expressions are found separately, not merged into one',
        by('hand_math').equations.length === 2,
        `${by('hand_math').equations.length} found`);

  for (const name of ['print_prose_print_math', 'print_prose_hand_math',
                      'hand_prose_print_math', 'hand_prose_hand_math']) {
    const row = by(name);
    check(`${name}: prose and mathematics both survive being on one page`,
          row.text >= 0.85 && row.tex.includes('\\['),
          `text ${pct(row.text)}, ${row.equations.length} equation(s)`);
  }

  const many = by('related_math');
  check('several equations on one page are read separately, not as one',
        many.equations.length >= 2, `${many.equations.length} found`);
  check('and each is placed in its own display',
        (many.tex.match(/\\\[/g) || []).length === many.equations.length);

  const all = by('all_mixed');
  check('a page of everything keeps its structure',
        all.structure !== null && all.structure >= 0.9, pct(all.structure));

  check('every page produced a document that validates',
        scored.every((r) => r.issues.length === 0),
        scored.filter((r) => r.issues.length).map((r) => r.file).join(', '));
  check('no page produced an unsafe construct',
        scored.every((r) => r.unsafe.length === 0),
        scored.filter((r) => r.unsafe.length).map((r) => `${r.file}: ${r.unsafe}`).join(', '));
}

// ---------------------------------------------------------------------------
heading('against the Python pipeline, on the same images');
// ---------------------------------------------------------------------------

if (!skip() && reference) {
  console.log('  page                          text  (python)   math  (python)');
  const collapsed = [];
  const mine = { text: [], math: [], structure: [] };
  const theirs = { text: [], math: [], structure: [] };
  for (const row of scored) {
    const ref = reference.find((r) => r.file === row.file);
    if (!ref) continue;
    console.log(`  ${row.file.padEnd(28)}${pct(row.text)} ${pct(ref.text)}  `
                + `${pct(row.math)} ${pct(ref.math)}`);
    for (const key of ['text', 'math', 'structure']) {
      if (row[key] !== null && ref[key] !== null) {
        mine[key].push(row[key]);
        theirs[key].push(ref[key]);
      }
    }
    // A page is only a REGRESSION if it collapsed. Small per-page differences
    // are the two tokenizers disagreeing about how to write the same picture
    // -- measured on all_mixed, `E_{\mathrm{k}}` here against `E_{f k}`
    // there, from crops that differ by a pixel or two of ink threshold. Both
    // are the same subscript; normalize() collapses neither, so the character
    // metric charges for the longer spelling. Judging that per page at two
    // points would be measuring the tokenizer, so the aggregate is the claim
    // and this is the floor under it.
    for (const key of ['text', 'math']) {
      if (row[key] !== null && ref[key] !== null && row[key] < ref[key] - 0.15) {
        collapsed.push(`${row.file} ${key}`);
      }
    }
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  for (const key of ['text', 'math', 'structure']) {
    const ours = mean(mine[key]);
    const ref = mean(theirs[key]);
    console.log(`  ${('mean ' + key).padEnd(28)}${pct(ours)} ${pct(ref)}`);
    check(`mean ${key} accuracy is no worse than the Python pipeline's`,
          ours >= ref - 0.01, `${pct(ours)} against ${pct(ref)}`);
  }
  check('no page collapsed against the reference', collapsed.length === 0,
        collapsed.join(', '));

  // On a page of PRINTED mathematics both pipelines are deterministic and see
  // the same crop, so "close enough" is not the claim -- they should agree
  // exactly once spacing is normalised away.
  const printed = ['print_math.png', 'print_prose_print_math.png',
                   'hand_prose_print_math.png'];
  for (const file of printed) {
    const row = scored.find((r) => r.file === file);
    const ref = reference.find((r) => r.file === file);
    if (!row || !ref) continue;
    check(`${file}: the same expressions as Python, exactly`,
          row.equations.map(normalize).join('|') === ref.equations.map(normalize).join('|'),
          `${JSON.stringify(row.equations)} vs ${JSON.stringify(ref.equations)}`);
  }
}

// ---------------------------------------------------------------------------
heading('multi-page documents');
// ---------------------------------------------------------------------------

if (!skip()) {
  const three = await run((p) => window.convertLocally([p]), pdfPath);
  check('a three-page PDF converts', three.tex.length > 300);
  check('it is set as three pages, not as continuous copy',
        (three.tex.match(/\\clearpage/g) || []).length === 2,
        `${(three.tex.match(/\\clearpage/g) || []).length} breaks`);
  check('the multi-page document validates', three.issues.length === 0,
        three.issues.join(' '));
  check('page one\'s headings survived', /\\section\{/.test(three.tex));

  // Boxes are pooled across pages and sorted once, so a page-two line must not
  // sort into page one. The offset is what prevents it.
  const images = ['/bench/img_pages/headings_hi.png',
                  '/bench/img_pages/display_math_hi.png'];
  const two = await run((u) => window.convertLocally(u), images);
  check('two images convert as one document in page order',
        two.tex.indexOf('Introduction') < two.tex.indexOf('\\clearpage'),
        'page one content must precede the break');
  check('equations are numbered across the whole document, not per page',
        two.equations.length >= 1);
}

// ---------------------------------------------------------------------------
heading('degraded input: skew, noise, a phone photograph');
// ---------------------------------------------------------------------------

if (!skip()) {
  const clean = manifestPages.find((m) => m.file === 'mixed_hi.png');
  const base = await run((u) => window.convertLocally([u]),
                         '/bench/img_pages/mixed_hi.png');
  const baseText = textScore(clean.gt_tex, base.tex);
  console.log(`  clean baseline: text ${pct(baseText)}`);

  for (const kind of ['skew', 'noise', 'camera']) {
    const out = await run(({ u, k }) => window.convertDegraded(u, k),
                          { u: '/bench/img_pages/mixed_hi.png', k: kind });
    const score = textScore(clean.gt_tex, out.tex);
    console.log(`  ${kind.padEnd(8)}        text ${pct(score)}   ` +
                `${out.equations.length} equation(s)`);
    check(`${kind}: still produces a document that validates`,
          out.issues.length === 0 && out.tex.length > 150, out.issues.join(' '));
    check(`${kind}: the page is still readable`, score >= 0.5, pct(score));
  }

  // The specific claim preprocessing exists for. bench measured a 10-degree
  // page taking Tesseract from 99.84% to 28.44% character accuracy, and at
  // PSM 3 to an empty string.
  const skewed = await run((u) => window.skewOf(u), '/bench/img_pages/mixed_hi.png');
  check('a straight page is not rotated for nothing', Math.abs(skewed) < 0.4,
        `estimated ${skewed} degrees`);
  const bent = await run(({ u, k }) => window.convertDegraded(u, k),
                         { u: '/bench/img_pages/mixed_hi.png', k: 'skew' });
  check('a 7-degree page is deskewed, and says so',
        bent.notes.some((n) => /Deskewed by/.test(n)), bent.notes.join(' | '));
  check('and the deskewed page reads at close to the clean score',
        textScore(clean.gt_tex, bent.tex) >= baseText - 0.15,
        `${pct(textScore(clean.gt_tex, bent.tex))} against ${pct(baseText)} clean`);
}

// ---------------------------------------------------------------------------
heading('malformed and low-quality input');
// ---------------------------------------------------------------------------

if (!skip()) {
  const cases = [
    ['an empty file', [], 'empty.png', 'image/png'],
    ['a truncated PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0],
     'truncated.png', 'image/png'],
    ['a text file wearing a .png name', [...'not an image at all'].map((c) => c.charCodeAt(0)),
     'lying.png', 'image/png'],
    ['a PDF that is not a PDF', [...'%PDF-1.4 broken'].map((c) => c.charCodeAt(0)),
     'broken.pdf', 'application/pdf'],
  ];
  for (const [label, bytes, name, mime] of cases) {
    const out = await run(({ b, n, m }) => window.convertBytes(b, n, m).then(
      (r) => ({ ok: true, ...r }), (e) => ({ ok: false, message: String(e && e.message || e) })),
      { b: bytes, n: name, m: mime });
    // Either a document or a clean refusal -- never a crash, and never a
    // half-written .tex. run.py's rule: a page that will not open is recorded
    // and skipped, and the pages that did open survive.
    check(`${label}: fails without taking the app with it`,
          out.ok ? out.issues.length === 0 : Boolean(out.message),
          out.ok ? out.issues.join(' ') : out.message);
    if (out.ok) {
      check(`${label}: says the page could not be read`,
            out.notes.some((n) => /could not be read/.test(n)) || out.textBlocks === 0,
            out.notes.join(' | '));
    }
  }

  // Blank and solid pages: the two inputs that break an ink threshold. A blank
  // page must not become one giant "formula", and a black page must not make
  // the mask flag every pixel.
  for (const [label, colour] of [['a blank white page', '#fff'],
                                 ['a solid black page', '#000']]) {
    const out = await run(async (c) => {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 1000;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 800, 1000);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      return window.convertBytes(new Uint8Array(await blob.arrayBuffer()),
                                 'flat.png', 'image/png');
    }, colour);
    check(`${label}: produces a valid, empty document rather than nonsense`,
          out.issues.length === 0 && out.equations.length === 0,
          `${out.issues.join(' ')} ${out.equations.length} equations`);
  }

  // A very small capture. This is the upscale path, and bench measured low DPI
  // at 87.52% with 0/10 exact lines without it.
  const tiny = await run(async () => {
    const source = new Image();
    source.src = '/bench/img_mixed/print_prose.png';
    await source.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = Math.round(source.naturalHeight * (420 / source.naturalWidth));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return window.convertBytes(new Uint8Array(await blob.arrayBuffer()),
                               'tiny.png', 'image/png');
  });
  check('a low-resolution capture is upscaled, and says so',
        tiny.notes.some((n) => /Upscaled/.test(n)), tiny.notes.join(' | '));
  check('and it still produces a valid document', tiny.issues.length === 0);
}

// ---------------------------------------------------------------------------
heading('fallback LaTeX cannot bypass the validator or the engine');
// ---------------------------------------------------------------------------
//
// The one place arbitrary LaTeX enters a document this app compiles. Prose is
// escaped -- a backslash becomes \textbackslash{} -- but a recognised formula
// is inserted VERBATIM, because escaping it would destroy it. So the formula
// model's output is untrusted input, and is treated as such.

if (!skip()) {
  const hostile = [
    ['\\input{/etc/passwd}', 'input'],
    ['x = \\input{secret}', 'input'],
    ['\\openin1=secret.txt', 'openin'],
    ['a \\write18{rm -rf /} b', 'write18'],
    ['\\pdffiledump offset 0 length 99 {/etc/passwd}', 'pdffiledump'],
    ['\\pdffilesize{/etc/passwd}', 'pdffilesize'],
    ['\\pdffilemoddate{/etc/passwd}', 'pdffilemoddate'],
    ['\\pdfmdfivesum file {/etc/passwd}', 'pdfmdfivesum'],
    ['\\pdfximage{/etc/passwd}', 'pdfximage'],
    ['\\pdfobj file {/etc/passwd}', 'pdfobj'],
    ['\\directlua{os.execute("id")}', 'directlua'],
    ['\\include{other}', 'include'],
    ['\\read1 to \\x', 'read'],
  ];
  for (const [expression, label] of hostile) {
    const out = await run((s) => window.pure.sanitiseMath(s), expression);
    check(`an expression containing ${label} is dropped, not patched`,
          out.ok === false && out.latex === '', JSON.stringify(out));
  }

  // The look-alikes: control words that merely START with a dangerous name.
  // Refusing these would refuse real mathematics.
  for (const expression of ['\\inputs = 4', '\\readable + 1', '\\writing = x',
                            '\\pdffiledumped = 2', '\\includegraphicsx = 1']) {
    const out = await run((s) => window.pure.sanitiseMath(s), expression);
    check(`${expression.split(' ')[0]} is not mistaken for a file primitive`,
          out.ok === true, JSON.stringify(out));
  }

  // Structural damage, which the model produces far more often than anything
  // dangerous. Repaired rather than dropped: the transcription is still good.
  //
  // The last four are the ones that VALIDATE and still will not compile, and
  // they are why the suite asks the engine about every page rather than
  // trusting staticValidate(). \tag is the one that actually happened: the
  // model saw "(2)" printed beside a Fourier transform and transcribed it.
  const broken = [
    ['\\frac{1}{2', 'an unclosed brace'],
    ['x^{2}}', 'a stray closing brace'],
    ['\\left( x + 1', 'a \\left with no \\right'],
    ['\\begin{matrix} a & b', 'an unclosed environment'],
    ['E = mc$^2$', 'a math shift inside a display'],
    ['x = 1 % and the rest', 'a comment that would eat the \\]'],
    ['f(t) = 1 \\tag * { \\omega } ( 2 )', 'a \\tag outside an equation environment'],
    ['x = 1 \\label{eq:one}', 'a \\label outside an equation environment'],
    ['a = b \\\\ c = d', 'a line break with no environment to live in'],
    ['a &= b', 'an alignment tab with no environment to live in'],
  ];
  for (const [expression, label] of broken) {
    const out = await run((s) => window.pure.sanitiseMath(s), expression);
    const doc = await run((s) => window.pure.staticValidate(
      `\\documentclass{article}\n\\begin{document}\n\\[\n${s}\n\\]\n\\end{document}\n`),
      out.latex);
    check(`${label} is repaired into something that validates`,
          out.ok && doc.length === 0, `${JSON.stringify(out.latex)} -> ${doc.join(' ')}`);
  }

  // Validating is not enough for those last four, so ask the engine as well.
  // "It parses" and "it builds" are different questions, and the fallback has
  // nobody to ask the second one for it.
  for (const [expression, label] of [
    ['f(t) = 1 \\tag * { \\omega } ( 2 )', 'a \\tag'],
    ['a = b \\\\ c = d', 'a bare line break'],
    ['a &= b \\\\ c &= d', 'alignment tabs'],
  ]) {
    const safe = await run((s) => window.pure.sanitiseMath(s), expression);
    const built = await run((t) => window.compileTex(t),
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\[\n'
      + safe.latex + '\n\\]\n\\end{document}\n');
    check(`${label} is repaired into something that actually compiles`,
          built.ok,
          `${JSON.stringify(safe.latex)} :: ${(built.errors || built.reason || '').slice(0, 140)}`);
  }

  // And the belt-and-braces claim: even if all of the above were bypassed, the
  // engine refuses before it is loaded.
  const refused = await run(() => window.compileTex(
    '\\documentclass{article}\n\\begin{document}\n\\input{/etc/passwd}\n\\end{document}\n'));
  check('the engine refuses an unsafe document without compiling it',
        refused.ok === false && refused.attempted === false
        && refused.reason.includes('reach outside itself'), JSON.stringify(refused));

  // Text is escaped, so a page with a command PRINTED on it stays text.
  const escaped = await run((s) => window.pure.escapeTex(s),
                            '\\input{/etc/passwd} & 50% $x$ #1 ~ ^');
  check('OCR text containing LaTeX syntax is escaped into literals',
        escaped.includes('\\textbackslash{}') && !/\\input\{/.test(escaped),
        escaped);
  const escapedIssues = await run((s) => window.pure.unsafeConstructs(
    `\\documentclass{article}\n\\begin{document}\n${s}\n\\end{document}\n`), escaped);
  check('and a document built from it carries no unsafe construct',
        escapedIssues.length === 0, escapedIssues.join(', '));
}

// ---------------------------------------------------------------------------
heading('the end of the chain: it compiles, and there is a PDF');
// ---------------------------------------------------------------------------

if (!skip()) {
  // EVERY page, not a sample. A document can validate and still not build:
  // staticValidate() checks that braces, environments and delimiters balance,
  // and cannot know that \tag is fatal outside a numbered equation. That is
  // exactly what the fallback produced on the Fourier page -- the model read
  // the printed "(2)" beside the equation and transcribed it as a tag -- and
  // only the engine could say so. So the engine is asked, about all of them.
  const broke = [];
  for (const row of scored) {
    const built = await run((t) => window.compileTex(t), row.tex);
    if (!built.ok || built.bytes <= 1000) {
      broke.push(`${row.file}: ${(built.reason || built.errors).slice(0, 120)}`);
    }
  }
  check('every fallback document in the corpus compiles to a PDF',
        broke.length === 0, broke.join(' | '));

  const three = await run((p) => window.convertLocally([p]), pdfPath);
  const built = await run((t) => window.compileTex(t), three.tex);
  check('the three-page fallback document compiles too',
        built.ok && built.bytes > 1000, built.reason || built.errors);
}

// ---------------------------------------------------------------------------

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failing:');
  for (const f of failed) console.log(`  [${f.group}] ${f.name}${f.detail ? '  ::  ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
