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
  // Mutable, because signing in is now a page load: the app asks
  // /api/session again on the workspace it lands on, and a stub frozen at
  // "guest" would answer that nobody signed in.
  const session = {
    isAuthenticated: false, hasAcceptedTerms: true, maxUploadMb: 32,
    termsVersion: '2.0-2026-09-08', displayName: null, email: null,
    firebaseConfig: null, ...shell,
  };
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(session),
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
  await page.waitForFunction(() => document.getElementById('convert-submit') &&
                                   !document.getElementById('convert-submit').disabled);
  return { posted, sentCount: () => sent, session };
}

/**
 * A conversion has finished when the workspace has swapped to the document
 * state and the preview has stopped compiling -- pages rendered, or the note
 * saying why not. Flask signalled this by replacing the whole page; these two
 * states are the same moment.
 */
const settled = (page, timeout = 120000) => page.waitForFunction(() => {
  const result = document.getElementById('convert-result');
  if (!result || result.classList.contains('hidden')) return false;
  const pages = document.getElementById('preview-pages');
  const error = document.getElementById('preview-error');
  return !pages.classList.contains('hidden') || !error.classList.contains('hidden');
}, { timeout });

/** How many pages the preview drew. */
const previewPages = (page) => page.locator('#preview-pages canvas').count();

/** Put a file on the picker without touching the filesystem. */
async function attach(page, name, bytes, mime) {
  await page.setInputFiles('#convert-file-upload', { name, mimeType: mime, buffer: Buffer.from(bytes) });
}

// -- a guest converts -------------------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  const { posted } = await openApp(page);

  await attach(page, 'photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png');
  await page.click('#convert-submit');
  await settled(page, 120000);

  check('a single image converts and previews', await previewPages(page) > 0,
        `${await previewPages(page)} pages drawn`);
  check('the LaTeX is shown', (await page.textContent('#convert-tex')).includes('\\documentclass'));
  check('the preview rendered a page',
        await page.locator('#preview-pages canvas').count() > 0);

  check('a guest\'s conversion never reaches the history endpoint',
        posted.length === 0, JSON.stringify(posted));
  const guest = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('contex_guest_history') || '[]'));
  check('it is kept in sessionStorage instead',
        guest.length === 1 && guest[0].fileName === 'photo.png',
        JSON.stringify(guest.map((g) => g.fileName)));

  // The history view renders the guest list, and the Clear button empties it.
  await page.goto(`${BASE}/history`, { waitUntil: 'load' });
  await page.waitForSelector('#history-list li');
  check('the guest list renders in the history view',
        (await page.textContent('#history-list')).includes('photo.png'));
  check('and offers the Clear button that only a guest has',
        await page.isVisible('#guest-history-clear'));
  await page.click('#guest-history-clear');
  await page.waitForSelector('#confirm-modal.is-open');
  await page.click('#confirm-accept');
  await page.waitForFunction(
    () => sessionStorage.getItem('contex_guest_history') === null, { timeout: 10000 });
  check('clearing empties the list',
        await page.evaluate(() => sessionStorage.getItem('contex_guest_history')) === null);
  await context.close();
}

// -- the terms are readable before they are accepted ------------------------
//
// A gate that asks you to accept a document you cannot open is not consent.
// The Flask app served /legal/<document> as a fragment for the in-app modal;
// this checks the same thing is reachable here, and that what it shows names
// the version actually being enforced.
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  await openApp(page, { shell: { hasAcceptedTerms: false } });

  check('the terms checkbox is shown to someone who has not accepted',
        await page.isVisible('#terms-gate'));
  for (const [which, title] of [['terms', 'Terms of Service'],
                                ['privacy', 'Privacy Policy']]) {
    await page.click(`#terms-gate [data-action="legal"][data-arg="${which}"]`);
    await page.waitForSelector('#legal-modal.is-open .doc', { timeout: 10000 });
    check(`${which}: opens from the acceptance control itself`,
          (await page.textContent('#legal-title')) === title,
          await page.textContent('#legal-title'));
    const shown = await page.textContent('#legal-body [data-terms-version]');
    check(`${which}: names the version being enforced`,
          shown === '2.0-2026-09-08', shown);
    await page.click('[data-action="legal-close"]');
  }

  // The statements this build must not repeat from the Flask policy.
  const privacy = await (await fetch(`${BASE}/legal/privacy.html`)).text();
  check('the privacy policy no longer claims a one-hour server retention',
        !/one hour/i.test(privacy.replace(/<!--[\s\S]*?-->/, '')),
        'the stale retention claim is still there');
  check('and says the PDF is compiled in the browser',
        /compiled (on your device|in your own browser)/i.test(privacy));
  check('and discloses the Files API upload and its deletion',
        /Files API/.test(privacy) && /deletes the uploaded file/i.test(privacy));
  check('and discloses Cloudflare as the host',
        /Cloudflare/.test(privacy));
  check('and discloses the abuse-prevention counters',
        /Abuse-prevention counters/i.test(privacy));
  const terms = await (await fetch(`${BASE}/legal/terms.html`)).text();
  check('the terms no longer promise a one-hour result',
        !/kept[\s\S]{0,40}one hour/i.test(terms));
  check('and state the request limits the Worker actually enforces',
        /30 in any 5 minutes/.test(terms) && /20 in any 5 minutes/.test(terms));

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
        (await page.textContent('#nav-account-name')) === 'Ada L');
  check('and offers signing out rather than signing in',
        await page.isVisible('[data-action="logout"]') && !(await page.isVisible('#nav-account-out')));

  await attach(page, 'lecture.png', [0x89, 0x50, 0x4e, 0x47], 'image/png');
  await page.click('#convert-submit');
  await settled(page, 120000);

  check('a signed-in user\'s conversion is sent to be saved',
        posted.length === 1 && posted[0].fileName === 'lecture.png',
        JSON.stringify(posted));
  check('and carries the whole document, not a summary of it',
        posted[0].tex.includes('\\end{document}'));
  const guest = await page.evaluate(() =>
    sessionStorage.getItem('contex_guest_history'));
  check('nothing is written to the guest store for a signed-in user',
        guest === null, String(guest));

  await page.goto(`${BASE}/history`, { waitUntil: 'load' });
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
        !(await page.isVisible('#guest-history-clear')));

  // output.py history_preview(): a saved document compiles to a preview of its
  // own, fetched only when asked for.
  await page.click('#history-list button:has-text("Preview PDF")');
  await page.waitForSelector('#history-list [data-preview] canvas',
                             { timeout: 120000 });
  check('a saved conversion previews from its stored LaTeX', true);
  await context.close();
}

// -- signing in does not inherit the previous visitor's document -------------
//
// session.py start_session() clears the whole session for this reason: on a
// shared computer the person signing in is not necessarily the person who was
// just using it. In Flask the danger was a result token left in the cookie;
// here the document itself is in the page, so the page has to be cleared.
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  const app = await openApp(page);
  await page.route('**/api/auth/login', (route) => {
    Object.assign(app.session, { isAuthenticated: true, displayName: 'Ada L',
                                 email: 'ada@example.com' });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, isAuthenticated: true, displayName: 'Ada L',
                             email: 'ada@example.com', hasAcceptedTerms: true,
                             maxUploadMb: 32, termsVersion: '2.0-2026-09-08',
                             firebaseConfig: null }),
    });
  });

  await attach(page, 'private.png', [0x89, 0x50, 0x4e, 0x47], 'image/png');
  await page.click('#convert-submit');
  await settled(page, 120000);
  check('the guest has a converted document on screen',
        !(await page.locator('#convert-result').isHidden()) &&
        (await page.textContent('#convert-tex')).includes('documentclass'));
  const guestBefore = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('contex_guest_history') || '[]').length);
  check('and an entry in their guest history', guestBefore === 1);

  // Sign-in is its own page, as it was in Flask, and a successful one lands
  // back on the workspace. That navigation IS the clearing: session.py cleared
  // the whole session for this reason, and here the document lives in the
  // page, so a fresh page is what clears it.
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.fill('#email', 'ada@example.com');
  await page.fill('#password', 'pw');
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(
    () => location.pathname === '/'
          && !document.getElementById('nav-account-in').classList.contains('hidden'),
    { timeout: 30000 });

  check('signing in hides the previous visitor\'s result',
        await page.locator('#convert-result').isHidden());
  check('and drops the document itself, not just the panel',
        (await page.textContent('#convert-tex')) === '',
        await page.textContent('#convert-tex'));
  check('and clears their guest history',
        (await page.evaluate(() =>
          sessionStorage.getItem('contex_guest_history'))) === null);
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
  await page.click('#convert-submit');
  await settled(page, 180000);

  check('a three-page PDF is converted a page at a time',
        app.sentCount() === 3, `${app.sentCount()} model calls`);
  const tex = await page.textContent('#convert-tex');
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
  check('the merged document compiles to three pages',
        await previewPages(page) === 3, `${await previewPages(page)} pages drawn`);
  await context.close();
}

// -- a PDF longer than the cap says so, before it starts --------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  await page.goto(`${BASE}/tests/history-harness.html`, { waitUntil: 'load' });
  const longPdf = await page.evaluate(async () => {
    const { PDFDocument } = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 14; i++) doc.addPage([300, 400]).drawText(`Page ${i + 1}`);
    return Array.from(await doc.save());
  });

  const app = await openApp(page, { texts: [pageTex] });
  await attach(page, 'long.pdf', longPdf, 'application/pdf');
  // BEFORE Convert is pressed, not after: once it is, the processing screen
  // covers the page and a warning behind it is a warning nobody reads.
  await page.waitForSelector('#convert-pagelimit:not(.hidden)', { timeout: 30000 });
  const warning = await page.textContent('#convert-pagelimit');
  check('a 14-page PDF warns that only 10 pages will be converted',
        /Only the first 10 pages/.test(warning) && /has 14 pages/.test(warning),
        warning.slice(0, 160));
  check('and says which pages are missing',
        /pages 11 to 14 will not be sent/.test(warning), warning.slice(0, 240));
  await page.click('#convert-submit');

  await settled(page, 180000);
  check('exactly ten pages were sent to the model', app.sentCount() === 10,
        `${app.sentCount()} model calls`);
  check('and the finished document carries the same note',
        /Only the first 10 pages of this 14-page PDF were converted/
          .test(await page.textContent('#convert-notes')),
        (await page.textContent('#convert-notes')).slice(0, 200));
  await context.close();
}

// -- .docx is not offered while its extraction is unported ------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await openApp(page);
  const accept = await page.getAttribute('#convert-file-upload', 'accept');
  check('the picker does not offer .docx', !accept.includes('.docx'), accept);

  await attach(page, 'report.docx', [0x50, 0x4b, 0x03, 0x04],
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.click('#convert-submit');
  await page.waitForSelector('#convert-error:not(.hidden)', { timeout: 30000 });
  check('and one chosen anyway is refused with inputs.py\'s wording',
        (await page.textContent('#convert-error-text')) === "Unsupported file type: '.docx'",
        await page.textContent('#convert-error-text'));
  await context.close();
}

// -- deleting a saved conversion --------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
  let rows = [{ id: 'doc-1', fileName: 'saved.pdf', ocrType: 'convert',
                timestamp: '2026-03-04T09:07:00Z', truncated: false }];
  const deleted = [];
  await openApp(page, { shell: { isAuthenticated: true, displayName: 'Ada L' } });
  await page.route('**/api/history', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, isAuthenticated: true, limit: 20, history: rows }),
  }));
  await page.route('**/api/history/doc-1', (route) => {
    if (route.request().method() === 'DELETE') {
      deleted.push('doc-1');
      rows = [];
      return route.fulfill({ status: 200, contentType: 'application/json',
                             body: JSON.stringify({ ok: true, deleted: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, tex: pageTex, fileName: 'saved.pdf',
                             truncated: false }) });
  });

  await page.goto(`${BASE}/history`, { waitUntil: 'load' });
  await page.waitForSelector('#history-list li');
  const del = page.locator('#history-list button:has-text("Delete")').first();
  await del.click();
  await page.waitForSelector('#confirm-modal.is-open');
  check('it asks before deleting rather than deleting',
        deleted.length === 0 &&
        /removed for good/.test(await page.textContent('#confirm-body')),
        await page.textContent('#confirm-body'));
  await page.click('#confirm-accept');
  await page.waitForSelector('#history-empty-auth:not(.hidden)', { timeout: 15000 });
  check('the second click deletes it', deleted.length === 1, JSON.stringify(deleted));
  check('and the list is empty afterwards',
        await page.locator('#history-list').isHidden());
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`\nfailing:\n  ${failed.map((f) => f.name).join('\n  ')}`);
process.exit(failed.length ? 1 : 0);
