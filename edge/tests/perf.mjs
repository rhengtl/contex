/**
 * Stage 2 performance: cold vs warm, a large document, and a throttled
 * mobile-class device.
 *
 * Cold start is the number that matters for a first visit -- it includes the
 * 1.7 MB engine and the 9.9 MB format file. Warm is every compile after that,
 * and is what a user editing and re-previewing actually experiences.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, devices } from 'playwright-core';
import './serve.mjs';

const BASE = 'http://127.0.0.1:8810';
const CORPUS = resolve(process.env.CORPUS || 'tests/corpus');

const corpusFiles = (await readdir(CORPUS)).filter((f) => f.endsWith('.tex')).sort();
const sample = await readFile(join(CORPUS, 'pages__matrix_hi.tex'), 'utf8');

// A deliberately large document: the whole corpus concatenated into one body,
// which is far past anything a single page produces.
const bodies = [];
for (const f of corpusFiles) {
  const t = await readFile(join(CORPUS, f), 'utf8');
  const m = t.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/);
  if (m) bodies.push(m[1]);
}
const large = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{booktabs}\n' +
  '\\begin{document}\n' + bodies.join('\n\\clearpage\n') + '\n\\end{document}\n';

async function run(label, contextOpts, throttle) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  if (throttle) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.goto(`${BASE}/tests/harness.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true, { timeout: 60000 });
  await fetch(`${BASE}/__reset`);

  const cold = await page.evaluate((t) => window.compileOne(t), sample);
  const warm = [];
  for (let i = 0; i < 3; i++) {
    warm.push((await page.evaluate((t) => window.compileOne(t), sample)).ms);
  }
  const big = await page.evaluate((t) => window.compileOne(t), large);

  const log = await (await fetch(`${BASE}/__log`)).json();
  const bytes = log.filter((r) => r.status === 200).reduce((a, b) => a + b.bytes, 0);

  console.log(`\n${label}`);
  console.log(`  cold compile      ${cold.ms} ms  (${cold.pdfBytes} B pdf)`);
  console.log(`  warm compile      ${warm.join(' / ')} ms`);
  console.log(`  large document    ${big.ms} ms  ok=${big.ok} ${big.pdfBytes} B` +
              (big.reason ? `  reason=${big.reason.slice(0, 60)}` : ''));
  console.log(`  network total     ${(bytes / 1048576).toFixed(2)} MiB over ${log.length} requests`);
  await browser.close();
}

await new Promise((r) => setTimeout(r, 400));
await run('desktop (no throttle)', {}, 0);
await run('mobile: Pixel 7 viewport, 4x CPU throttle',
          { ...devices['Pixel 7'], isMobile: undefined, hasTouch: undefined }, 4);
process.exit(0);
