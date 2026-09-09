/**
 * What the offline path costs, in bytes, milliseconds and megabytes.
 *
 * WHY MEASURE IT SEPARATELY. The fallback runs on the user's own device, so
 * every cost it has is paid by someone who is already having a worse day than
 * usual -- the AI is down and they have agreed to a slower, lower-quality
 * conversion. "It works" is not the only question about that path; "it works
 * on a phone" is the other one, and it has a different answer.
 *
 * The numbers here are the ones the README quotes.
 *
 *     node tests/resources.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const BENCH = resolve(process.env.CONTEX_BENCH || '../bench');
const MiB = (n) => `${(n / 1048576).toFixed(2)} MiB`;

/** Three bench pages as one PDF, for the multi-page measurement. */
async function buildPdf() {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (const name of ['headings_hi.png', 'display_math_hi.png', 'lists_hi.png']) {
    const png = await doc.embedPng(await readFile(join(BENCH, 'img_pages', name)));
    const page = doc.addPage([png.width / 2, png.height / 2]);
    page.drawImage(png, { x: 0, y: 0, width: png.width / 2, height: png.height / 2 });
  }
  await mkdir('tests/out', { recursive: true });
  await writeFile('tests/out/three-pages.pdfdata', await doc.save());
}

await buildPdf();
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 160)));
await page.goto(`${BASE}/tests/fallback-harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

const heap = () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
const rows = [];

// -- what the offline path downloads, once -----------------------------------
await fetch(`${BASE}/__reset`);
const warmMs = await page.evaluate(() => window.warm());
const log = await (await fetch(`${BASE}/__log`)).json();
const fetched = log.filter((r) => r.status === 200);
const bytes = fetched.reduce((a, b) => a + b.bytes, 0);
console.log(`\nOffline recognisers, cold`);
console.log(`  ${MiB(bytes)} over ${fetched.length} requests, ready in ${warmMs} ms`);
const byArea = {};
for (const r of fetched) {
  const area = r.path.split('/').slice(0, 3).join('/');
  byArea[area] = (byArea[area] || 0) + r.bytes;
}
for (const [area, n] of Object.entries(byArea).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${MiB(n).padStart(10)}  ${area}`);
}
rows.push(['offline recognisers, cold download', MiB(bytes)]);
rows.push(['offline recognisers, load time', `${warmMs} ms`]);

// -- one page, offline, warm --------------------------------------------------
const before = await heap();
for (const [label, urls] of [
  ['one printed page', ['/bench/img_mixed/print_prose_print_math.png']],
  ['one dense page', ['/bench/img_mixed/all_mixed.png']],
  ['a three-page PDF', ['/tests/out/three-pages.pdfdata']],
]) {
  const out = await page.evaluate((u) => window.convertLocally(u), urls);
  const after = await heap();
  console.log(`\n${label}`);
  console.log(`  ${out.ms} ms, ${out.equations.length} equation(s), `
              + `${out.textBlocks} text block(s)`);
  console.log(`  heap ${MiB(after)} (was ${MiB(before)})`);
  rows.push([`offline conversion — ${label}`, `${(out.ms / 1000).toFixed(1)} s`]);
  rows.push([`peak heap after ${label}`, MiB(after)]);
}

// -- the engine, which every path pays for ------------------------------------
await fetch(`${BASE}/__reset`);
const cold = await page.evaluate(async () => {
  const t0 = performance.now();
  const out = await window.compileTex(
    '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n'
    + 'Hello. \\[ E = mc^2 \\]\n\\end{document}\n');
  return { ms: Math.round(performance.now() - t0), ok: out.ok, bytes: out.bytes };
});
const engineLog = await (await fetch(`${BASE}/__log`)).json();
const engineBytes = engineLog.filter((r) => r.status === 200)
  .reduce((a, b) => a + b.bytes, 0);
const warm = await page.evaluate(async () => {
  const t0 = performance.now();
  await window.compileTex(
    '\\documentclass{article}\n\\begin{document}\nAgain.\n\\end{document}\n');
  return Math.round(performance.now() - t0);
});
console.log(`\nSwiftLaTeX`);
console.log(`  cold ${cold.ms} ms (${MiB(engineBytes)} over `
            + `${engineLog.filter((r) => r.status === 200).length} requests), `
            + `warm ${warm} ms`);
rows.push(['SwiftLaTeX cold compile', `${cold.ms} ms`]);
rows.push(['SwiftLaTeX cold download', MiB(engineBytes)]);
rows.push(['SwiftLaTeX warm compile', `${warm} ms`]);

console.log('\n' + '-'.repeat(62));
for (const [name, value] of rows) console.log(`  ${name.padEnd(44)}${value.padStart(14)}`);

await browser.close();
process.exit(0);
