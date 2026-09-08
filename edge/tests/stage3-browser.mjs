/**
 * Stage 3 in the browser: the guest-history contract, and the wiring that
 * decides which of the two histories a conversion goes into.
 *
 * The contract is the one static/scripts.js implements and the Privacy Policy
 * promises: a guest's results are cleared when they refresh or close the tab,
 * moving between views does not clear them, and a signed-in user never sees a
 * guest list. That is behaviour of the BROWSER -- sessionStorage, and the
 * navigation type -- so it is tested in one, not reasoned about.
 *
 * The second half drives the shipped page end to end with the network stubbed:
 * a Gemini-shaped reply per page, and assertions on what the client then does
 * with it. That exercises the real conversion path -- split, convert, merge,
 * validate, compile, preview, record -- without a model or an API key.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const CORPUS = resolve(process.env.CORPUS ||
  String.raw`C:\Users\rheni\AppData\Local\Temp\claude\d--Projects-contex\a4067a2f-7c7e-4cfe-90f8-dc4b9ae5afd5\scratchpad\s3\out`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
};

const corpus = (await readdir(CORPUS)).filter((f) => f.endsWith('.tex')).sort();
const pageTex = await readFile(join(CORPUS, corpus[0]), 'utf8');
const otherTex = await readFile(join(CORPUS, corpus[1]), 'utf8');

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });

// ---------------------------------------------------------------------------
// 1. The guest-history contract  (static/scripts.js, guest session history)
// ---------------------------------------------------------------------------
console.log('=== the guest-history contract (scripts.js) ===');
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/tests/history-harness.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

  const H = (fn, arg) => page.evaluate(fn, arg);

  await H(() => {
    window.history_.clear();
    window.history_.add({ fileName: 'one.png', result: 'ONE' });
    window.history_.add({ fileName: 'two.png', result: 'TWO' });
  });
  let items = await H(() => window.history_.read());
  check('a guest\'s conversions are kept, newest first',
        items.length === 2 && items[0].fileName === 'two.png',
        JSON.stringify(items.map((i) => i.fileName)));
  check('each entry carries the document itself, not a token that can expire',
        items[0].result === 'TWO' && !('token' in items[0]),
        JSON.stringify(Object.keys(items[0])));
  check('and a timestamp the list can render',
        !Number.isNaN(Date.parse(items[0].at)), items[0].at);

  const stored = await H(() => sessionStorage.getItem('contex_guest_history'));
  check('it lives in sessionStorage under the original key', !!stored);
  const local = await H(() => localStorage.length);
  check('and nowhere more durable than that', local === 0, String(local));

  // Moving between the workspace and history is an ordinary navigation, and
  // must not be mistaken for a refresh. This is the case the `keepGuestHistory`
  // flag existed to protect in the Flask app.
  await page.goto(`${BASE}/tests/history-harness.html?view=history`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true);
  items = await H(() => window.history_.open({ isAuthenticated: false }));
  check('walking between views keeps the list',
        items.length === 2, JSON.stringify(items.map((i) => i.fileName)));

  // A refresh wipes it. The Privacy Policy says so, so it is implemented
  // literally by asking the browser what kind of navigation this was.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true);
  const navType = await H(() => performance.getEntriesByType('navigation')[0].type);
  check('a reload reports itself as a reload', navType === 'reload', navType);
  items = await H(() => window.history_.open({ isAuthenticated: false }));
  check('and a refresh clears the guest list', items.length === 0,
        JSON.stringify(items));

  // A signed-in user must never see leftovers from an earlier guest session in
  // the same tab.
  await H(() => {
    window.history_.add({ fileName: 'guest.png', result: 'GUEST' });
  });
  items = await H(() => window.history_.open({ isAuthenticated: true }));
  check('a signed-in user sees no guest history at all', items.length === 0);
  check('and it is removed from storage, not merely hidden',
        (await H(() => sessionStorage.getItem('contex_guest_history'))) === null);

  // scripts.js MAX_ITEMS.
  await H(() => {
    window.history_.clear();
    for (let i = 0; i < 25; i++) {
      window.history_.add({ fileName: `f${i}.png`, result: `R${i}` });
    }
  });
  items = await H(() => window.history_.read());
  check('the guest list is capped at twenty entries', items.length === 20,
        String(items.length));
  check('and it is the oldest that fall off the end',
        items[0].fileName === 'f24.png' && items[19].fileName === 'f5.png',
        `${items[0].fileName}..${items[19].fileName}`);

  // sessionStorage is per-tab: the browser drops it when the tab closes.
  const other = await context.newPage();
  await other.goto(`${BASE}/tests/history-harness.html`, { waitUntil: 'load' });
  await other.waitForFunction(() => window.ready === true);
  const inNewTab = await other.evaluate(() => window.history_.read());
  check('a new tab does not inherit another tab\'s guest history',
        inNewTab.length === 0, String(inNewTab.length));

  // The date format the server rendered a saved conversion with.
  const shown = await H((v) => window.history_.formatWhen(v), '2026-03-04T09:07:00Z');
  check('dates are formatted as templates/history.html formatted them',
        /^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/.test(shown), shown);

  await context.close();
}

// ---------------------------------------------------------------------------
// 2. The shipped page, end to end, with the network stubbed
// ---------------------------------------------------------------------------
console.log('\n=== the page end to end (convert -> merge -> preview -> history) ===');

/** A Gemini reply carrying one page of LaTeX, fenced the way ai.py expects. */
const geminiReply = (tex) => JSON.stringify({
  candidates: [{ content: { parts: [{ text: '```latex\n' + tex + '\n```' }] } }],
});

async function openApp(page, { shell = {}, onHistoryPost, texts = [pageTex] } = {}) {
  let sent = 0;
  const posted = [];
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      isAuthenticated: false, hasAcceptedTerms: true, maxUploadMb: 32,
      termsVersion: '1.0-2026-08-24', displayName: null, email: null,
      firebaseConfig: null, ...shell,
    }),
  }));
  await page.route('**/api/ai-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ available: true, message: '' }),
  }));
  await page.route('**/api/convert/page*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'x-contex-model': 'gemini-3.1-flash-lite' },
    body: geminiReply(texts[Math.min(sent++, texts.length - 1)]),
  }));
  await page.route('**/api/history', (route) => {
    if (route.request().method() === 'POST') {
      posted.push(JSON.parse(route.request().postData() || '{}'));
      if (onHistoryPost) onHistoryPost(posted.at(-1));
      return route.fulfill({ status: 200, contentType: 'application/json',
                             body: JSON.stringify({ ok: true, id: 'doc-1', stored: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, isAuthenticated: !!shell.isAuthenticated, limit: 20,
        history: shell.isAuthenticated
          ? [{ id: 'doc-1', fileName: 'saved.pdf', ocrType: 'convert',
               timestamp: '2026-03-04T09:07:00Z', truncated: false }]
          : [] }) });
  });
  await page.route('**/api/history/doc-1', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, tex: pageTex, fileName: 'saved.pdf', truncated: false }),
  }));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('go') &&
                                   !document.getElementById('go').disabled);
  return { posted, sentCount: () => sent };
}

/** Put a file on the picker without touching the filesystem. */
async function attach(page, name, bytes, mime) {
  await page.setInputFiles('#file', { name, mimeType: mime, buffer: Buffer.from(bytes) });
}

// -- a guest converts -------------------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  const { posted } = await openApp(page);

  await attach(page, 'photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png');
  await page.click('#go');
  await page.waitForFunction(
    () => /Done|No preview/.test(document.getElementById('status').textContent),
    { timeout: 120000 });

  const status = await page.textContent('#status');
  check('a single image converts and previews', /^Done\. \d+ page/.test(status), status);
  check('the LaTeX is shown', (await page.textContent('#tex')).includes('\\documentclass'));
  check('the preview rendered a page',
        await page.locator('#preview canvas, #preview img').count() > 0);

  check('a guest\'s conversion never reaches the history endpoint',
        posted.length === 0, JSON.stringify(posted));
  const guest = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('contex_guest_history') || '[]'));
  check('it is kept in sessionStorage instead',
        guest.length === 1 && guest[0].fileName === 'photo.png',
        JSON.stringify(guest.map((g) => g.fileName)));

  // The history view renders the guest list, and the Clear button empties it.
  await page.click('#nav-history');
  await page.waitForSelector('#history-list li');
  check('the guest list renders in the history view',
        (await page.textContent('#history-list')).includes('photo.png'));
  check('and offers the Clear button that only a guest has',
        await page.isVisible('#history-clear'));
  await page.click('#history-clear');
  check('clearing empties the list',
        await page.evaluate(() => sessionStorage.getItem('contex_guest_history')) === null);
  await context.close();
}

// -- a signed-in user converts ----------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  const { posted } = await openApp(page, {
    shell: { isAuthenticated: true, displayName: 'Ada L', email: 'ada@example.com' },
  });

  check('the shell shows who is signed in',
        (await page.textContent('#who')) === 'Ada L');
  check('and offers signing out rather than signing in',
        await page.isVisible('#logout') && !(await page.isVisible('#nav-signin')));

  await attach(page, 'lecture.png', [0x89, 0x50, 0x4e, 0x47], 'image/png');
  await page.click('#go');
  await page.waitForFunction(
    () => /Done|No preview/.test(document.getElementById('status').textContent),
    { timeout: 120000 });

  check('a signed-in user\'s conversion is sent to be saved',
        posted.length === 1 && posted[0].fileName === 'lecture.png',
        JSON.stringify(posted));
  check('and carries the whole document, not a summary of it',
        posted[0].tex.includes('\\end{document}'));
  const guest = await page.evaluate(() =>
    sessionStorage.getItem('contex_guest_history'));
  check('nothing is written to the guest store for a signed-in user',
        guest === null, String(guest));

  await page.click('#nav-history');
  await page.waitForSelector('#history-list li');
  check('the saved list is rendered from the server\'s answer',
        (await page.textContent('#history-list')).includes('saved.pdf'));
  // templates/history.html rendered '%d %b %Y, %H:%M' server-side, in the
  // stored timestamp's own zone (UTC), while the guest list used
  // toLocaleString and showed local time -- so the two disagreed by the
  // reader's offset. Both go through formatWhen here, so the format AND the
  // zone now match, and the zone is the reader's.
  check('the saved list uses the same date format the server used',
        /^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/.test(await page.textContent('#history-list time')),
        await page.textContent('#history-list time'));
  check('and the same one the guest list uses, in the same zone',
        (await page.textContent('#history-list time')) ===
        (await page.evaluate(async () => (await import('/history.js'))
          .formatWhen('2026-03-04T09:07:00Z'))),
        await page.textContent('#history-list time'));
  check('and no Clear button, because there is no self-service delete',
        !(await page.isVisible('#history-clear')));

  // output.py history_preview(): a saved document compiles to a preview of its
  // own, fetched only when asked for.
  await page.click('#history-list button:has-text("Preview PDF")');
  await page.waitForSelector('#history-list .panel canvas, #history-list .panel img',
                             { timeout: 120000 });
  check('a saved conversion previews from its stored LaTeX', true);
  await context.close();
}

// -- a multi-page PDF -------------------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));

  // A real three-page PDF, built in the browser with the same library the app
  // splits with, so the split is exercised against a genuine file.
  await page.goto(`${BASE}/tests/history-harness.html`, { waitUntil: 'load' });
  const pdfBytes = await page.evaluate(async () => {
    const { PDFDocument } = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([300, 400]).drawText(`Page ${i + 1}`);
    return Array.from(await doc.save());
  });

  const app = await openApp(page, { texts: [pageTex, otherTex, pageTex] });
  await attach(page, 'notes.pdf', pdfBytes, 'application/pdf');
  await page.click('#go');
  await page.waitForFunction(
    () => /Done|No preview/.test(document.getElementById('status').textContent),
    { timeout: 180000 });

  check('a three-page PDF is converted a page at a time',
        app.sentCount() === 3, `${app.sentCount()} model calls`);
  const tex = await page.textContent('#tex');
  check('the pages are merged into ONE document',
        (tex.match(/\\documentclass/g) || []).length === 1 &&
        (tex.match(/\\begin\{document\}/g) || []).length === 1,
        `${(tex.match(/\\documentclass/g) || []).length} documentclass`);
  check('with a page break between each source page',
        (tex.match(/\\clearpage/g) || []).length === 2,
        String((tex.match(/\\clearpage/g) || []).length));
  check('and no package loaded twice',
        (tex.match(/\\usepackage\{amsmath\}/g) || []).length <= 1,
        String((tex.match(/\\usepackage\{amsmath\}/g) || []).length));
  const status = await page.textContent('#status');
  check('the merged document compiles to three pages',
        status === 'Done. 3 pages.', status);
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\nfailing:\n  ${failed.map((f) => f.name).join('\n  ')}`);
process.exit(failed.length ? 1 : 0);
