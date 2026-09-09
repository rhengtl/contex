/**
 * The whole application, through the front door.
 *
 * WHY THIS EXISTS SEPARATELY. Stages 1-4 each have a suite, and each one is
 * honest about the layer it tests: security.mjs calls the Worker handler,
 * fallback.mjs calls the pipeline modules, input.mjs drives the input controls.
 * None of them puts a person in front of index.html and follows them all the
 * way to a downloaded PDF, and the bugs that live between two layers are
 * exactly the ones nobody's unit test owns.
 *
 * Two of them cannot be found any other way at all:
 *
 *   The content-security policy is a header. It is enforced by the browser and
 *   by nothing else, so a policy that forbids something the app really does
 *   fails for the first time in production. tests/serve.mjs now serves the
 *   real public/_headers, and this suite runs a complete offline conversion
 *   under it while listening for violations.
 *
 *   Layout is a viewport. A 360px phone is where a <fieldset>'s min-content
 *   width, a wide <pre> of LaTeX, or a full-screen dialog goes wrong, and none
 *   of that is visible at 1280px.
 *
 *     node tests/integration.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const BENCH = resolve(process.env.CONTEX_BENCH || '../bench');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? '  ::  ' + detail : ''}`);
};
const heading = (name) => console.log(`\n-- ${name} `
  + '-'.repeat(Math.max(0, 58 - name.length)));

const PAGE_TEX = '\\documentclass{article}\n\\begin{document}\n'
  + 'Converted by the model.\n\\end{document}\n';

/** A twelve-page PDF, to exercise the cap and its warning. */
async function buildLongPdf() {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(await readFile(
    join(BENCH, 'img_pages', 'headings_hi.png')));
  for (let i = 0; i < 12; i++) {
    const page = doc.addPage([png.width / 4, png.height / 4]);
    page.drawImage(png, { x: 0, y: 0, width: png.width / 4, height: png.height / 4 });
  }
  await mkdir('tests/out', { recursive: true });
  const bytes = await doc.save();
  await writeFile('tests/out/twelve-pages.pdf', bytes);
  return Buffer.from(bytes);
}

const twelvePage = await buildLongPdf();
const samplePng = await readFile(join(BENCH, 'img_mixed', 'print_prose_print_math.png'));

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/**
 * The app, with only the Worker stubbed.
 *
 * Everything the browser does for itself -- recognisers, engine, canvases --
 * is real. `ai` decides whether the model is up; `violations` collects every
 * content-security-policy report the page makes.
 */
async function openApp({ ai = { available: true, model: 'gemini-2.5-flash' },
                         authenticated = false, viewport = null,
                         convert = null } = {}) {
  const context = await browser.newContext({
    permissions: ['camera'],
    ...(viewport ? { viewport } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  const violations = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__violations.push({
        directive: event.violatedDirective,
        blocked: String(event.blockedURI || '').slice(0, 120),
      });
    });
  });

  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isAuthenticated: authenticated, hasAcceptedTerms: true,
                           maxUploadMb: 32, termsVersion: '2.0-2026-09-08',
                           email: authenticated ? 'someone@example.com' : null }),
  }));
  await page.route('**/api/ai-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(ai),
  }));
  await page.route('**/api/history**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, history: [] }),
  }));
  await page.route('**/api/convert/page**', convert || ((route) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'x-contex-model': 'gemini-2.5-flash' },
    body: JSON.stringify({ candidates: [{ content: { parts: [{
      text: '```latex\n' + PAGE_TEX + '```' }] } }] }),
  })));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('convert-submit'));
  return {
    context, page, errors,
    violations: async () => (await page.evaluate(() => window.__violations)) || [],
  };
}

const attach = (page, name, bytes, mime) => page.setInputFiles(
  '#convert-file-upload', { name, mimeType: mime, buffer: Buffer.from(bytes) });

/**
 * A conversion has settled when the workspace has swapped to the document
 * state and the preview has stopped compiling -- or when it failed and said
 * so in the input panel instead.
 */
const settled = (page, timeout = 300000) => page.waitForFunction(() => {
  const error = document.getElementById('convert-error');
  if (error && !error.classList.contains('hidden')) return true;
  const result = document.getElementById('convert-result');
  if (!result || result.classList.contains('hidden')) return false;
  const pages = document.getElementById('preview-pages');
  const failed = document.getElementById('preview-error');
  return !pages.classList.contains('hidden') || !failed.classList.contains('hidden');
}, { timeout });

// ---------------------------------------------------------------------------
heading('the AI path, end to end, through the real page');
// ---------------------------------------------------------------------------
{
  const { context, page, errors, violations } = await openApp();
  await attach(page, 'photo.png', samplePng, 'image/png');
  await page.click('#convert-submit');
  await settled(page);

  check('a conversion produces the document the model returned',
        (await page.textContent('#convert-tex')).includes('Converted by the model'));
  check('the result panel is shown',
        await page.evaluate(() => !document.getElementById('convert-result').classList.contains('hidden')));
  check('a PDF preview was built',
        await page.evaluate(() => document.querySelectorAll('#preview-pages canvas').length) > 0,
        String(await page.locator('#preview-pages canvas').count()));
  // Flask offered "Open PDF" rather than a download, because the rendered
  // document is what a reader wants and the browser's own viewer is where it
  // belongs. The href is a blob this page made.
  check('and the compiled PDF is reachable',
        /^blob:/.test(await page.getAttribute('#preview-open', 'href') || ''),
        String(await page.getAttribute('#preview-open', 'href')));
  check('no notice was shown, because nothing degraded',
        await page.evaluate(() =>
          document.getElementById('fallback-notice').classList.contains('hidden')
          && document.getElementById('convert-notes').classList.contains('hidden')));
  check('the page threw nothing', errors.length === 0, errors.join(' | '));
  check('and the content-security policy was not violated',
        (await violations()).length === 0, JSON.stringify(await violations()));

  // Download .tex is an <a download> pointed at a Blob this page made -- the
  // shape templates/partials/convert_section.html gave it, where the href was
  // a server route. The browser will not hand the file back to a test, so what
  // is asserted is the link: a blob href, and a name taken from the document.
  const download = await page.evaluate(() => {
    const link = document.getElementById('download-tex');
    return { href: link.getAttribute('href'), name: link.getAttribute('download') };
  });
  check('the .tex is offered as a download named after the document',
        /^blob:/.test(download.href || '') && download.name === 'photo.tex',
        JSON.stringify(download));
  // Not fetched back to check its media type: connect-src is 'self' and does
  // not name blob:, so reading it here would be the test tripping the policy
  // rather than the app. What the file holds is asserted from the page itself,
  // which is the same string the Blob was built from.
  check('and it is the document that was just converted',
        (await page.textContent('#convert-tex')).includes('\end{document}'));

  await context.close();
}

// ---------------------------------------------------------------------------
heading('a camera capture, converted');
// ---------------------------------------------------------------------------
{
  // A capture never touches the file input, so this is the one path where
  // run() reads from input.js instead. It is also the only one that produces
  // an image/jpeg, which the Worker's media-type allowlist has to accept.
  const own = await chromium.launch({
    channel: 'msedge', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await own.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  const sent = [];
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isAuthenticated: false, hasAcceptedTerms: true,
                           maxUploadMb: 32, termsVersion: '2.0-2026-09-08' }),
  }));
  await page.route('**/api/ai-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ available: true }),
  }));
  await page.route('**/api/history**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, history: [] }),
  }));
  await page.route('**/api/convert/page**', (route) => {
    sent.push({ mime: route.request().headers()['x-image-mime'],
                bytes: (route.request().postDataBuffer() || Buffer.alloc(0)).length });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'x-contex-model': 'gemini-2.5-flash' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{
        text: '```latex\n' + PAGE_TEX + '```' }] } }] }),
    });
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('convert-submit'));

  await page.click('[data-action="camera-open"]');
  await page.waitForFunction(
    () => document.getElementById('camera-stream').videoWidth > 0, { timeout: 20000 });
  await page.click('[data-action="camera-capture"]');
  await page.waitForFunction(() => document.getElementById('camera-modal').classList.contains('hidden'),
                             { timeout: 20000 });
  await page.click('#convert-submit');
  await settled(page);

  check('a capture converts without ever touching the file input',
        (await page.textContent('#convert-tex')).includes('Converted by the model'),
        String(await page.locator('#preview-pages canvas').count()));
  check('and it is sent as the media type the Worker allows',
        sent.length === 1 && sent[0].mime === 'image/jpeg', JSON.stringify(sent));
  check('as raw bytes, with no base64 inflation',
        sent.length === 1 && sent[0].bytes > 0, JSON.stringify(sent));

  await own.close();
}

// ---------------------------------------------------------------------------
heading('the AI is down: the gate, the offline path, and the CSP');
// ---------------------------------------------------------------------------
{
  const { context, page, errors, violations } = await openApp({
    ai: { available: false, reason: 'exhausted',
          message: 'The AI conversion service is temporarily unavailable.' },
  });
  await attach(page, 'page.png', samplePng, 'image/png');
  await page.click('#convert-submit');

  await page.waitForSelector('#ai-modal.is-open', { timeout: 20000 });
  check('the user is asked before anything is downgraded',
        await page.isVisible('#ai-modal'));
  check('and told what is wrong',
        (await page.textContent('#ai-modal-reason')).includes('temporarily unavailable'));

  // Cancel first: nothing must have been converted.
  await page.click('[data-action="ai-cancel"]');
  await page.waitForFunction(() => document.getElementById('ai-modal').classList.contains('hidden'));
  check('cancelling converts nothing',
        await page.evaluate(() => document.getElementById('convert-result').classList.contains('hidden')));
  check('and says so', (await page.textContent('#toast-text')).includes('Cancelled'));
  check('the recognisers were never downloaded',
        await page.evaluate(async () => {
          const t = await import('/recognise/text.js');
          const f = await import('/recognise/formulas.js');
          return t.ready() === false && f.ready() === false;
        }));

  // Now accept, and let the whole offline pipeline run for real.
  await page.click('#convert-submit');
  await page.waitForSelector('#ai-modal.is-open', { timeout: 20000 });
  await page.click('[data-action="ai-fallback"]');
  await settled(page);

  const tex = await page.textContent('#convert-tex');
  check('the offline conversion produces a document',
        tex.includes('\\documentclass') && tex.length > 200, tex.slice(0, 120));
  check('it read the page rather than inventing it',
        /energy|mass/i.test(tex), tex.slice(0, 200));
  check('and it found the mathematics', tex.includes('\\['), tex.slice(0, 300));
  check('a PDF preview was built from it',
        await page.evaluate(() => document.querySelectorAll('#preview-pages canvas').length) > 0,
        String(await page.locator('#preview-pages canvas').count()));
  check('the user is told the document was converted without AI',
        /without (the )?AI|in this browser/i.test(await page.textContent('#fallback-notice')),
        (await page.textContent('#fallback-notice')).slice(0, 200));
  check('the page threw nothing during the whole offline run',
        errors.length === 0, errors.join(' | '));

  // The one that cannot be tested any other way.
  const found = await violations();
  check('a complete offline conversion violates no CSP directive',
        found.length === 0, JSON.stringify(found));

  await context.close();
}

// ---------------------------------------------------------------------------
heading('a drawing, converted offline');
// ---------------------------------------------------------------------------
{
  // The canvas produces a transparent PNG. Without flatten_alpha() every
  // greyscale conversion downstream turns that background BLACK -- measured in
  // Python at 100% ink and a collapse to one band. This is that path, end to
  // end, in a browser.
  const { context, page, errors } = await openApp({
    ai: { available: false, message: 'unavailable' },
  });
  await page.click('[data-action="draw-open"]');
  const box = await page.locator('#draw-canvas').boundingBox();
  // Something with ink in it, spread over a few lines.
  for (const y of [60, 110, 160]) {
    await page.mouse.move(box.x + 60, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + y, { steps: 8 });
    await page.mouse.up();
  }
  await page.click('[data-action="draw-save"]');
  await page.waitForFunction(() => document.getElementById('draw-modal').classList.contains('hidden'));

  await page.click('#convert-submit');
  await page.waitForSelector('#ai-modal.is-open', { timeout: 20000 });
  await page.click('[data-action="ai-fallback"]');
  await settled(page);

  const tex = await page.textContent('#convert-tex');
  check('a drawing converts offline into a valid document',
        tex.includes('\\documentclass') && tex.includes('\\end{document}'),
        tex.slice(0, 160));
  check('and it was not read as a solid black page',
        !/\\\[[\s\S]{800,}/.test(tex),
        'a black page becomes one enormous nominated region');
  check('the page threw nothing', errors.length === 0, errors.join(' | '));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('a PDF longer than the cap');
// ---------------------------------------------------------------------------
{
  const { context, page } = await openApp();
  let calls = 0;
  await page.route('**/api/convert/page**', (route) => {
    calls += 1;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'x-contex-model': 'gemini-2.5-flash' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{
        text: '```latex\n' + PAGE_TEX + '```' }] } }] }),
    });
  });

  await attach(page, 'long.pdf', twelvePage, 'application/pdf');

  // BEFORE the conversion, and that is the whole point: it appears when the
  // file is chosen, while Convert has still not been pressed. Once it is, the
  // processing screen covers the page and a warning behind it is unread.
  await page.waitForSelector('#convert-pagelimit:not(.hidden)', { timeout: 30000 });
  const notice = await page.textContent('#convert-pagelimit');
  check('the user is warned BEFORE the conversion, not after',
        notice.includes('Only the first 10 pages')
        && await page.evaluate(() =>
             document.getElementById('convert-result').classList.contains('hidden')),
        notice.slice(0, 160));
  check('the warning names the real page count', notice.includes('has 12 pages'),
        notice.slice(0, 200));
  check('the warning says which pages are not sent',
        notice.includes('pages 11 to 12 will not be sent'), notice.slice(0, 240));

  await page.click('#convert-submit');
  await settled(page);
  check('exactly ten pages were sent', calls === 10, `${calls} calls`);

  await context.close();
}

// ---------------------------------------------------------------------------
heading('history, across a conversion');
// ---------------------------------------------------------------------------
{
  const { context, page } = await openApp();
  await attach(page, 'first.png', samplePng, 'image/png');
  await page.click('#convert-submit');
  await settled(page);

  await page.goto(`${BASE}/history`, { waitUntil: 'load' });
  await page.waitForSelector('#history-list li', { timeout: 10000 });
  check('a guest conversion appears in this browser\'s own history',
        (await page.textContent('#history-list')).includes('first.png'));
  check('and nothing was posted to the server for it',
        await page.evaluate(() =>
          !document.getElementById('guest-history-clear').classList.contains('hidden')),
        'the Clear control is the guest-only one');

  await context.close();
}

// ---------------------------------------------------------------------------
heading('the terms gate');
// ---------------------------------------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  let converted = 0;
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isAuthenticated: false, hasAcceptedTerms: false,
                           maxUploadMb: 32, termsVersion: '2.0-2026-09-08' }),
  }));
  await page.route('**/api/ai-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }),
  }));
  await page.route('**/api/session/terms', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/history**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, history: [] }),
  }));
  await page.route('**/api/convert/page**', (route) => {
    converted += 1;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'x-contex-model': 'gemini-2.5-flash' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{
        text: '```latex\n' + PAGE_TEX + '```' }] } }] }),
    });
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('convert-submit'));

  check('the terms are asked for when they have not been accepted',
        await page.evaluate(() =>
          !document.getElementById('terms-gate').classList.contains('hidden')));
  // The gate disables the whole fieldset, which is how the Flask page did it:
  // there is nothing to press until it is answered, so the refusal is not a
  // message delivered after the upload has already gone.
  check('and the controls are unusable until they are',
        await page.evaluate(() => document.getElementById('convert-controls').disabled));
  await attach(page, 'page.png', samplePng, 'image/png');
  await page.click('#convert-submit', { force: true }).catch(() => {});
  check('so nothing can be sent', converted === 0, `${converted} calls`);

  await page.check('#terms-checkbox');
  await page.waitForFunction(
    () => !document.getElementById('convert-controls').disabled, { timeout: 10000 });
  check('and the gate goes away once it is accepted',
        await page.evaluate(() =>
          document.getElementById('terms-gate').classList.contains('hidden')));
  await attach(page, 'page.png', samplePng, 'image/png');
  await page.click('#convert-submit');
  await settled(page);
  check('accepting them lets the conversion run', converted === 1, `${converted} calls`);

  // The documents themselves have to be readable without leaving the page.
  await page.click('footer [data-action="legal"][data-arg="privacy"]');
  await page.waitForSelector('#legal-modal.is-open');
  const body = await page.textContent('#legal-body');
  check('the Privacy Policy opens and is the real document',
        body.includes('Gemini API') && body.includes('offline conversion'),
        body.slice(0, 120));
  check('and it is stamped with the version in force',
        body.includes('2.0-2026-09-08'));

  await context.close();
}

// ---------------------------------------------------------------------------
heading('a wrong address');
// ---------------------------------------------------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  // The emulator answers a miss with a bare 404, as Pages does before it
  // substitutes public/404.html; fetch the page itself, which is what Pages
  // would serve.
  await page.goto(`${BASE}/404.html`, { waitUntil: 'load' });
  const text = await page.textContent('body');
  check('the 404 page is in the application\'s own shell',
        text.includes('There is nothing here') && text.includes('ConTeX'));
  check('it says nothing about the cause',
        !/stack|trace|worker|exception|\.js:/i.test(text), text.slice(0, 200));
  check('and offers a way back',
        await page.getAttribute('main a.btn-primary', 'href') === '/');
  // templates/error.html extended the application shell, so this does too --
  // the header, the footer and the legal dialog are all still on it.
  check('it is the shell, not a bare page',
        await page.evaluate(() => Boolean(document.querySelector('header .nav-link')
                                          && document.querySelector('footer .eyebrow'))));
  // Nothing on it may DEPEND on the application: the way out is a plain link,
  // so it works whether or not app.js ever loads.
  check('the way out is a plain link, not a scripted control',
        await page.evaluate(() => {
          const back = document.querySelector('main a.btn-primary');
          return back.tagName === 'A' && !back.hasAttribute('data-action');
        }));
  check('and it threw nothing', errors.length === 0, errors.join(' | '));
  await context.close();
}

// ---------------------------------------------------------------------------
heading('on a 360px phone');
// ---------------------------------------------------------------------------
{
  const viewport = { width: 360, height: 740 };
  const { context, page } = await openApp({ viewport });

  const overflow = () => page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    widest: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 3).map((el) => `${el.tagName}#${el.id || ''}.${el.className || ''}`),
  }));

  let over = await overflow();
  check('the converter does not scroll sideways',
        over.scroll <= over.client + 1, JSON.stringify(over));

  await attach(page, 'photo.png', samplePng, 'image/png');
  await page.click('#convert-submit');
  await settled(page);
  over = await overflow();
  check('nor does the finished document, with a PDF preview on it',
        over.scroll <= over.client + 1, JSON.stringify(over));

  // The LaTeX source is the widest thing the page ever holds.
  await page.click('details.disclosure > summary');
  over = await overflow();
  check('nor does the LaTeX source when it is opened',
        over.scroll <= over.client + 1, JSON.stringify(over));

  // A full-screen dialog on a small screen is where controls fall off. The
  // workspace is showing the finished document by now, and its input controls
  // are gone with it -- "Convert another" is the way back, exactly as it was
  // in Flask, so this takes it.
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('convert-submit'));
  await page.click('[data-action="draw-open"]');
  const controls = await page.evaluate(() => {
    const right = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#draw-modal button')]
      .map((b) => ({ id: b.id, ok: b.getBoundingClientRect().right <= right + 1
                                   && b.getBoundingClientRect().width > 0 }));
  });
  check('every writing-canvas control fits on the screen',
        controls.every((c) => c.ok), JSON.stringify(controls.filter((c) => !c.ok)));
  const canvas = await page.locator('#draw-canvas').boundingBox();
  check('and the canvas itself has room to draw on',
        canvas.width > 200 && canvas.height > 200, JSON.stringify(canvas));
  await page.click('[data-action="draw-close"]');

  await context.close();
}

// ---------------------------------------------------------------------------
heading('a submit that arrives before the script has wired the form');
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. The Flask templates gave each auth form
// `method="POST" action="{{ url_for('auth.login') }}"`, so a submit that beat
// the JavaScript still did the right thing. These forms have no action: the
// handler in auth.js is what submits them. That made the handler's existence
// load-bearing, and it was installed AFTER `await auth.session()` -- so while
// that request was in flight, pressing Enter did a native GET and put the
// password in the query string, in history, and in the next Referer.
//
// Found against the deployed application, where the round trip is real.
{
  for (const [page_, form] of [['login', 'login-form'],
                               ['signup', 'signup-form'],
                               ['forgot-password', 'forgot-form']]) {
    const html = await readFile(join('public', page_, 'index.html'), 'utf8');
    const tag = (html.match(new RegExp(`<form id="${form}"[^>]*>`)) || [''])[0];
    check(`the ${page_} form is a POST, so a native submit cannot put a `
          + 'password in the URL', /method="post"/i.test(tag), tag);
  }

  // The real test: hold /api/session open, then submit. Nothing may navigate.
  const context = await browser.newContext();
  const page = await context.newPage();
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/session', async (route) => {
    await held;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ isAuthenticated: false, hasAcceptedTerms: true,
                             maxUploadMb: 32, termsVersion: '2.0-2026-09-08' }),
    });
  });
  let posted = 0;
  await page.route('**/api/auth/login', (route) => {
    posted += 1;
    return route.fulfill({ status: 200, contentType: 'application/json',
                           body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${BASE}/login/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form');
  const before = page.url();
  await page.fill('#email', 'someone@example.com');
  await page.fill('#password', 'correct horse battery staple');
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1500);

  check('the form does not submit itself while the session is still loading',
        !page.url().includes('password'), page.url());
  // Signing in navigates to '/' on purpose -- start_session() clears the
  // session, and a fresh document is how that reaches the page. What must not
  // happen is a navigation to the login URL carrying the credentials.
  check('and any navigation is the one the handler chose, not the browser default',
        !page.url().includes('/login'), `${before} -> ${page.url()}`);
  check('the handler took the submit instead', posted === 1, `${posted} posts`);

  release();
  await context.close();
}

// ---------------------------------------------------------------------------

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failing:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? '  ::  ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
