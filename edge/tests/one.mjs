// Quick single-document probe, for diagnosing the compile path.
import { chromium } from 'playwright-core';
import './serve.mjs';

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:8810/tests/harness.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

const CASES = [
  ['valid', String.raw`\documentclass{article}\begin{document}hi\end{document}`],
  ['empty', ''],
];

for (const [name, tex] of CASES) {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      page.evaluate((t) => window.compileOne(t), tex),
      new Promise((_, rj) => setTimeout(() => rj(new Error('HUNG >45s')), 45000)),
    ]);
    console.log(`${name} -> ok=${r.ok} ${r.pdfBytes}B ${Date.now() - t0}ms`);
    if (!r.ok) {
      console.log('   reason: ' + r.reason);
      console.log('   errors: ' + (r.errors || '').split('\n').slice(0, 5).join(' | '));
    }
  } catch (e) {
    console.log(`${name} -> ${e.message} ${Date.now() - t0}ms`);
  }
}

const log = await (await fetch('http://127.0.0.1:8810/__log')).json();
const misses = log.filter((r) => r.status === 404);
console.log(`\nfetched ${log.length} (${misses.length} misses)`);
console.log('misses: ' + [...new Set(misses.map((m) => m.path))].slice(0, 12).join(' '));
await browser.close();
process.exit(0);
