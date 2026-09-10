/**
 * Multi-page merge parity: public/latex/documents.js against the bytes
 * contex/pipeline/latex/documents.py produces for the same page groups.
 *
 * Two halves, and both matter:
 *
 *   1. BYTE parity, in Node. A merge is a text transformation, so the only
 *      honest check is character-for-character equality with the original --
 *      "looks equivalent" is how a preamble quietly loses a package.
 *   2. The merged documents actually COMPILE, in the browser, through the real
 *      engine and the curated tree, and produce one output page per source
 *      page. That is the behaviour test_contex.py pins with pikepdf, and it is
 *      the reason \clearpage is in there at all.
 *
 * Reference JSON comes from tools/merge-reference.py, which runs the Python
 * implementation. Inputs live in that file too, so both sides merge the same
 * bytes rather than two transcriptions of the same idea.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { mergeDocuments, splitDocument } from '../public/latex/documents.js';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
// Committed. The Python that produced it is no longer in this repository, so
// this is a frozen golden file rather than something regenerated on demand.
const REF = resolve(process.env.MERGE_REF || 'tests/reference/merge-ref.json');

const ref = JSON.parse(await readFile(REF, 'utf8'));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
};

/** Where two strings first disagree, with a little context either side. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return `at ${i}: js=${JSON.stringify(a.slice(i, i + 40))} ` +
         `py=${JSON.stringify(b.slice(i, i + 40))}`;
}

// -- 1. byte parity ------------------------------------------------------
console.log('=== merge parity (documents.js vs documents.py) ===');
for (const [key, record] of Object.entries(ref)) {
  const got = mergeDocuments(record.inputs);
  check(`${key}: merged bytes match Python`, got === record.merged,
        got === record.merged ? '' : firstDifference(got, record.merged));
}

// splitDocument is public in both, and the merge is built on it, so a
// divergence there would show up as a subtler merge bug later.
console.log('\n=== splitDocument ===');
for (const [key, record] of Object.entries(ref)) {
  for (const doc of record.inputs) {
    const [cls, pre, body] = splitDocument(doc);
    if (!doc.trim()) continue;
    check(`${key}: split keeps the body`,
          doc.includes('\\begin{document}') ? body.length > 0 || !doc.includes('\\end{document}')
                                            : body === doc.trim(),
          `class=${JSON.stringify(cls)} preamble=${pre.length} body=${body.length}`);
  }
}

// -- 2. the merged documents compile ------------------------------------
console.log('\n=== merged documents compile ===');
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
await page.goto(`${BASE}/tests/harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

const timings = [];
for (const [key, record] of Object.entries(ref)) {
  if (!record.merged.trim()) continue;
  // The validator's verdict on the merged document is part of the reference:
  // a merge that produces an unbalanced document is a merge bug.
  const val = await page.evaluate((t) => window.validate(t), record.merged);
  check(`${key}: merged document validates as Python says`,
        JSON.stringify(val.issues) === JSON.stringify(record.issues),
        `js=${JSON.stringify(val.issues)} py=${JSON.stringify(record.issues)}`);

  const got = await page.evaluate(([t, w]) => window.compileOne(t, w),
                                  [record.merged, true]);
  check(`${key}: merged document compiles`, got.ok,
        (got.reason || got.errors || '').slice(0, 120));
  if (!got.ok) continue;
  timings.push(got.ms);

  // One source page per output page. Without the \clearpage the bodies set as
  // continuous copy and three short pages land on one.
  const expected = record.inputs.filter((d) => (d || '').trim()).length;
  const pages = await page.evaluate(async (b) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(b) }).promise;
    return doc.numPages;
  }, got.pdfFull);
  check(`${key}: ${expected} source pages produced ${expected} output pages`,
        pages === expected, `got ${pages}`);
}

// A background must not outlive the page that asked for it, and the text on
// the page after it must still be readable. Measured off the rendered pixels,
// exactly as test_contex.py does with Poppler.
console.log('\n=== a background does not outlive its page ===');
for (const key of ['background-in-preamble', 'background-in-body']) {
  const merged = ref[key].merged;
  check(`${key}: the background is not in the shared preamble`,
        !merged.split('\\begin{document}')[0].includes('\\pagecolor'));
  check(`${key}: page one keeps its background`, merged.includes('\\pagecolor'));

  const got = await page.evaluate((t) => window.compileOne(t, true), merged);
  if (!got.ok) { check(`${key}: compiles`, false, got.reason || got.errors); continue; }
  const shades = await page.evaluate(async (b) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(b) }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const vp = pg.getViewport({ scale: 0.7 });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d');
      // pdf.js paints nothing where the page is white, so start from white.
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const corner = ctx.getImageData(c.width - 8, c.height - 8, 1, 1).data;
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < px.length; i += 4) {
        if ((px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) < 128) dark++;
      }
      out.push({ corner: corner[0] + corner[1] + corner[2],
                 ink: dark / (px.length / 4) });
      pg.cleanup();
    }
    return out;
  }, got.pdfFull);

  check(`${key}: page one keeps its own dark background`, shades[0].corner < 330,
        `rgb sum ${shades[0].corner}`);
  for (let n = 1; n < shades.length; n++) {
    check(`${key}: the background did not bleed onto page ${n + 1}`,
          shades[n].corner >= 330, `rgb sum ${shades[n].corner}`);
  }
  // The half a reader actually notices: \color is a declaration too, so page
  // one's white text used to carry onto a page that is now white.
  check(`${key}: page two still has dark ink on it`, shades[1].ink > 0.0005,
        `ink ${shades[1].ink.toFixed(5)} - white on white`);
}

// A definition is not formatting: scoping it away would fail every later page.
console.log('\n=== a macro defined on one page still works on the next ===');
{
  const merged = ref['macro-definition-survives'].merged;
  check('the defining body is not wrapped in a group',
        !merged.includes('\\begingroup\n\\newcommand'));
  const got = await page.evaluate((t) => window.compileOne(t), merged);
  check('the merged document compiles', got.ok,
        (got.errors || got.reason || '').slice(0, 200));
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
if (timings.length) {
  const s = [...timings].sort((a, b) => a - b);
  console.log(`merged compile ms: min ${s[0]} median ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]}`);
}
if (failed.length) console.log(`\nfailing: ${failed.map((f) => f.name).join(' | ')}`);
process.exit(failed.length ? 1 : 0);
