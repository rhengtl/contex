/**
 * Stage 2 verification: browser validation + SwiftLaTeX compile, checked
 * against the original Python implementation's own results.
 *
 * Corpus = 15 crafted failure fixtures + the 26 real ConTeX benchmark outputs
 * collected in S3, so the happy path is real model output rather than examples
 * chosen to pass.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURES = resolve('tests/fixtures');
const CORPUS = resolve(process.env.CORPUS ||
  String.raw`C:\Users\rheni\AppData\Local\Temp\claude\d--Projects-contex\a4067a2f-7c7e-4cfe-90f8-dc4b9ae5afd5\scratchpad\s3\out`);
const REF = resolve(process.env.REF ||
  String.raw`C:\Users\rheni\AppData\Local\Temp\claude\d--Projects-contex\a4067a2f-7c7e-4cfe-90f8-dc4b9ae5afd5\scratchpad\python-ref.json`);

// MiKTeX auto-installs missing packages, so the Python reference compiled tikz
// on this machine. The container it actually ships in would not. Compile-parity
// for this one document is therefore not meaningful; its missing-package
// DETECTION is checked separately and is the behaviour that matters.
const ENV_DEPENDENT = new Set(['missing-package']);

// Was: documents where the edge port was deliberately stricter than
// validate.py, because \openin1= slipped past the original's \b. That defect
// is now fixed in validate.py itself (and in five sibling constructs), so the
// two implementations agree again and nothing belongs in this set. Kept as an
// empty set rather than deleted: the next divergence should be declared here
// and justified, not quietly accepted.
const STRICTER = new Set([]);

const ref = JSON.parse(await readFile(REF, 'utf8'));
const docs = [];
for (const [dir, tag] of [[FIXTURES, 'fixture'], [CORPUS, 'corpus']]) {
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.tex'))) {
    docs.push({ key: name.replace(/\.tex$/, ''), tag,
                tex: await readFile(join(dir, name), 'utf8') });
  }
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
};

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
await page.goto(`${BASE}/tests/harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

console.log('=== validation parity (staticValidate / unsafeConstructs) ===');
for (const d of docs) {
  const got = await page.evaluate((t) => window.validate(t), d.tex);
  const want = ref[d.key];
  if (!want) { check(`${d.key}: reference present`, false); continue; }
  check(`${d.key}: issues match Python`,
        JSON.stringify(got.issues) === JSON.stringify(want.issues),
        `edge=${JSON.stringify(got.issues)} python=${JSON.stringify(want.issues)}`);
  if (STRICTER.has(d.key)) {
    check(`${d.key}: edge catches what validate.py misses`,
          got.unsafe.length > want.unsafe.length,
          `edge=${JSON.stringify(got.unsafe)} python=${JSON.stringify(want.unsafe)}`);
  } else {
    check(`${d.key}: unsafe match Python`,
          JSON.stringify(got.unsafe) === JSON.stringify(want.unsafe),
          `edge=${JSON.stringify(got.unsafe)} python=${JSON.stringify(want.unsafe)}`);
  }
}

// Tightening the control-word boundary must not have started matching a
// LONGER command that merely begins with one of these names. JS and Python
// regex dialects agree here, but "agree" is worth proving in the browser that
// actually runs it -- \includegraphics is in any document with a figure.
console.log('\n=== control-word boundary (no over-match) ===');
for (const body of ['\\includegraphics[width=3cm]{plot.png}',
                    '\\inputencoding{utf8}', '\\openinput{x}',
                    '\\opening{Dear Sir}', '\\readline\\x', '\\writes',
                    '\\pdffiledumper{x}', '\\pdfximages{x}',
                    '\\pdfobjcompresslevel=2', '\\pdfmdfivesums{x}']) {
  const got = await page.evaluate((b) => window.validate(
    '\\documentclass{article}\n\\begin{document}\n' + b + '\n\\end{document}\n'),
    body);
  check(`${body}: not mistaken for a file primitive`, got.unsafe.length === 0,
        JSON.stringify(got.unsafe));
}

console.log('\n=== compile ===');
await fetch(`${BASE}/__reset`);
const timings = [];
const pdfs = new Map();
for (const d of docs) {
  const wantBytes = d.tag === 'corpus' && pdfs.size < 3;
  const got = await page.evaluate(([t, w]) => window.compileOne(t, w), [d.tex, wantBytes]);
  const want = ref[d.key].compile;

  if (!ENV_DEPENDENT.has(d.key) && !STRICTER.has(d.key)) {
    check(`${d.key}: compile ok matches Python`, got.ok === want.ok,
          `edge=${got.ok} python=${want.ok}`);
  }
  if (STRICTER.has(d.key)) {
    // Refusing earlier than the original is the improvement, so `attempted`
    // legitimately differs: edge never starts the engine, Python did.
    check(`${d.key}: refused without running the engine`, got.attempted === false,
          `attempted=${got.attempted}`);
  } else {
    check(`${d.key}: attempted matches Python`, got.attempted === want.attempted,
          `edge=${got.attempted} python=${want.attempted}`);
  }
  if (got.ok) {
    check(`${d.key}: produced a valid PDF`,
          got.pdfBytes > 0 && String.fromCharCode(...got.pdf) === '%PDF-1.5',
          `${got.pdfBytes}B header=${got.pdf && String.fromCharCode(...got.pdf)}`);
    timings.push({ key: d.key, tag: d.tag, ms: got.ms, bytes: got.pdfBytes,
                   python: want.pdf_bytes });
    if (got.pdfFull) pdfs.set(d.key, got.pdfFull);
  }
  if (d.key === 'missing-package') {
    check('missing-package: names the package',
          JSON.stringify(got.missingPackages) === JSON.stringify(['tikz']),
          JSON.stringify(got.missingPackages));
  }
  if (d.key.startsWith('unsafe-') && ref[d.key].unsafe.length) {
    check(`${d.key}: refused before the engine ran`,
          got.attempted === false && /reach outside itself/.test(got.reason || ''),
          `attempted=${got.attempted} reason=${(got.reason || '').slice(0, 70)}`);
  }
  if (d.key === 'undefined-command') {
    check('undefined-command: error text extracted',
          /Undefined control sequence/.test(got.errors), got.errors.slice(0, 80));
  }
}

// -- a package the tree does not carry -------------------------------------
//
// WHY THIS EXISTS. The shipped tree is 119 .sty files and the model is not
// told which ones they are, so it can name one that is not there. Reported
// from production: Gemini wrote `\usepackage{utf8}` -- which is not a package
// at all, utf8 being an OPTION to inputenc -- and one wrong preamble line cost
// the whole preview of an otherwise perfectly good document.
//
// compile() now drops what is missing and tries once more. What has to be
// true is that the preview comes back, that the user is told what was left
// out, and that the repair never invents a document: if the rest does not
// compile either, the ORIGINAL failure is what gets reported.

// The rewrite itself, without the engine.
{
  const cases = [
    [String.raw`\usepackage{utf8}`, ['utf8'], ''],
    [String.raw`\usepackage[T1]{fontenc}`, ['utf8'],
     String.raw`\usepackage[T1]{fontenc}`],
    // A line that loads several keeps the ones that exist.
    [String.raw`\usepackage{utf8,amsmath}`, ['utf8'],
     String.raw`\usepackage{amsmath}`],
    [String.raw`\usepackage{amsmath,utf8,array}`, ['utf8'],
     String.raw`\usepackage{amsmath,array}`],
    // Nothing missing, nothing touched.
    [String.raw`\usepackage{amsmath}`, [], String.raw`\usepackage{amsmath}`],
    // Indentation and options survive.
    [String.raw`  \usepackage[a]{utf8,amsmath}`, ['utf8'],
     String.raw`  \usepackage[a]{amsmath}`],
  ];
  for (const [input, missing, want] of cases) {
    const got = await page.evaluate(([t, m]) => window.dropPackages(t, m),
                                    [input, missing]);
    check(`dropPackages: ${JSON.stringify(input)} minus ${JSON.stringify(missing)}`,
          got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

// End to end, through the real engine.
{
  const head = String.raw`\documentclass{article}` + '\n';
  const body = String.raw`\begin{document}` + '\nHello $x^2$.\n'
    + String.raw`\end{document}` + '\n';
  const utf8Line = String.raw`\usepackage{utf8}` + '\n';

  const repaired = await page.evaluate(
    (t) => window.compileOne(t), head + utf8Line + body);
  check('a document asking for a package that is not here still previews',
        repaired.ok === true, `ok=${repaired.ok} errors=${(repaired.errors || '').slice(0, 120)}`);
  check('and says which package it left out',
        JSON.stringify(repaired.droppedPackages) === JSON.stringify(['utf8']),
        JSON.stringify(repaired.droppedPackages));
  check('and the PDF is real',
        repaired.pdfBytes > 0 && String.fromCharCode(...repaired.pdf) === '%PDF-1.5',
        `${repaired.pdfBytes}B`);

  // The .tex the user keeps is the one they were given, so its identity must
  // be the identity of THAT source and not of the rewritten one.
  const shaOfOriginal = await page.evaluate(
    (t) => window.sha(t), head + utf8Line + body);
  check('the source identity stays that of the .tex, not the repaired copy',
        repaired.sourceSha === shaOfOriginal,
        `${repaired.sourceSha} vs ${shaOfOriginal}`);

  // A real package alongside a missing one must survive the repair.
  const mixed = await page.evaluate(
    (t) => window.compileOne(t),
    head + String.raw`\usepackage{utf8,amsmath}` + '\n'
      + String.raw`\begin{document}` + '\n'
      + String.raw`\begin{align}x &= 1\end{align}` + '\n'
      + String.raw`\end{document}` + '\n');
  check('a real package on the same line as a missing one is kept',
        mixed.ok === true, `ok=${mixed.ok} errors=${(mixed.errors || '').slice(0, 160)}`);

  // And the repair must not manufacture a document out of one that is broken
  // for other reasons: tikz is missing AND its body needs it.
  const stillBroken = await page.evaluate(
    (t) => window.compileOne(t),
    head + String.raw`\usepackage{tikz}` + '\n'
      + String.raw`\begin{document}` + '\n'
      + String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}` + '\n'
      + String.raw`\end{document}` + '\n');
  check('a document that needs the missing package still fails',
        stillBroken.ok === false, `ok=${stillBroken.ok}`);
  check('and reports the original missing package rather than the repair',
        JSON.stringify(stillBroken.missingPackages) === JSON.stringify(['tikz'])
        && stillBroken.droppedPackages.length === 0,
        `missing=${JSON.stringify(stillBroken.missingPackages)} `
        + `dropped=${JSON.stringify(stillBroken.droppedPackages)}`);
}

// -- caching -------------------------------------------------------------
console.log('\n=== caching ===');
const before = await (await fetch(`${BASE}/__log`)).json();
const fmtFetches = before.filter((r) => r.path.includes('swiftlatexpdftex.fmt')).length;
check('format file fetched at most once across all compiles', fmtFetches <= 1,
      `${fmtFetches} fetches`);
const texmfBytes = before.filter((r) => r.status === 200 && r.path.startsWith('/pdftex/'))
  .reduce((a, b) => a + b.bytes, 0);
const uniqueTexmf = new Set(before.filter((r) => r.path.startsWith('/pdftex/') && r.status === 200)
  .map((r) => r.path)).size;
const misses = before.filter((r) => r.path.startsWith('/pdftex/') && r.status === 404).length;

// -- PDF renders ---------------------------------------------------------
console.log('\n=== preview render (pdf.js) ===');
const sample = [...pdfs.entries()].slice(0, 3);
for (const [key, bytes] of sample) {
  const r = await page.evaluate(async (b) => {
    // The vendored copy, which is the one that ships -- a CDN build would be
    // testing somebody else's bytes.
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(b) }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1.5 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200) ink++;
    return { pages: doc.numPages, w: Math.round(vp.width), h: Math.round(vp.height), ink };
  }, bytes);
  check(`${key}: renders with visible content`,
        r.pages >= 1 && r.ink > 100, `pages=${r.pages} ${r.w}x${r.h} ink=${r.ink}`);
}

await browser.close();

// -- report --------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
const corpusT = timings.filter((t) => t.tag === 'corpus').map((t) => t.ms).sort((a, b) => a - b);
const med = corpusT[Math.floor(corpusT.length / 2)];
console.log(`\n=== SUMMARY ===`);
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
console.log(`compiled: ${timings.length} documents`);
console.log(`corpus compile ms: min ${corpusT[0]} median ${med} max ${corpusT[corpusT.length - 1]}`);
console.log(`texmf: ${uniqueTexmf} unique files, ${(texmfBytes / 1048576).toFixed(2)} MiB, ${misses} 404s (expected: .vf/.aux probes)`);
const sizes = timings.filter((t) => t.python > 0);
const ratio = sizes.map((t) => t.bytes / t.python);
console.log(`pdf size vs Python: mean ratio ${(ratio.reduce((a, b) => a + b, 0) / ratio.length).toFixed(3)}`);
if (failed.length) console.log(`\nfailing: ${failed.map((f) => f.name).join(' | ')}`);

await mkdir('tests/out', { recursive: true });
await writeFile('tests/out/stage2-results.json',
  JSON.stringify({ results, timings, uniqueTexmf, texmfBytes, misses }, null, 2));
process.exit(0);
