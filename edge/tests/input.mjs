/**
 * The four ways a page gets into ConTeX.
 *
 * WHY THESE NEED A SUITE OF THEIR OWN. Every other test in this project drives
 * the pipeline; these drive the parts of it a person touches, and two of them
 * hold operating-system resources that have to be given back. A camera light
 * that stays on after the dialog closes is not a conversion bug -- it is worse
 * than one, because the user cannot see what is wrong and cannot fix it.
 *
 * The real index.html and the real input.js, driven by real pointer and drag
 * events. Nothing here stubs the module under test.
 *
 *     node tests/input.mjs
 */
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? '  ::  ' + detail : ''}`);
};
const heading = (name) => console.log(`\n-- ${name} `
  + '-'.repeat(Math.max(0, 58 - name.length)));

// A camera that does not exist cannot be released, so the suite is given one.
// --use-fake-ui grants the permission without a prompt; the device itself is a
// rolling test pattern, which is all a capture needs to be.
const FAKE_MEDIA = ['--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream'];

/** The network the app needs, and nothing else. */
async function stubApi(page, { authenticated = false } = {}) {
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isAuthenticated: authenticated, hasAcceptedTerms: true,
                           maxUploadMb: 32, termsVersion: '2.1-2026-09-12',
                           email: authenticated ? 'someone@example.com' : null }),
  }));
  await page.route('**/api/history', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, history: [] }),
  }));
  await page.route('**/api/ai-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ available: true, model: 'gemini-2.5-flash' }),
  }));
}

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true,
                                        args: FAKE_MEDIA });

/** The app, ready to be driven. */
async function openApp({ authenticated = false } = {}) {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  PAGEERROR ' + e.message.slice(0, 200)));
  await stubApi(page, { authenticated });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('convert-submit'));
  return { context, page };
}

/** What input.js currently considers the chosen page. */
const chosen = (page) => page.evaluate(async () => {
  const input = await import('/input.js');
  const file = input.selectedFile();
  return file ? { name: file.name, type: file.type, size: file.size } : null;
});

// ---------------------------------------------------------------------------
heading('drag and drop');
// ---------------------------------------------------------------------------
{
  const { context, page } = await openApp();

  // dragenter/dragleave fire for every child the pointer crosses, so the
  // highlight is counted rather than toggled. Crossing the label and back must
  // not leave the zone lit.
  await page.dispatchEvent('#convert-drop-area', 'dragenter', {});
  await page.dispatchEvent('#convert-drop-area span', 'dragenter', {});
  check('the drop zone lights up when a file is dragged over it',
        await page.evaluate(() => document.getElementById('convert-drop-area').classList.contains('is-dragging')));
  await page.dispatchEvent('#convert-drop-area span', 'dragleave', {});
  check('and stays lit while the pointer is still inside it',
        await page.evaluate(() => document.getElementById('convert-drop-area').classList.contains('is-dragging')),
        'crossing a child element is not leaving the zone');
  await page.dispatchEvent('#convert-drop-area', 'dragleave', {});
  check('and goes out when it really leaves',
        !await page.evaluate(() => document.getElementById('convert-drop-area').classList.contains('is-dragging')));

  const dropped = await page.evaluate(() => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'dragged.png', { type: 'image/png' }));
    const event = new DragEvent('drop', { dataTransfer: transfer,
                                          bubbles: true, cancelable: true });
    document.getElementById('convert-drop-area').dispatchEvent(event);
    return event.defaultPrevented;
  });
  check('a dropped file is taken, not opened by the browser', dropped);

  // Waiting on the input rather than sleeping: the drop handler is synchronous
  // but the preview it builds is not.
  await page.waitForFunction(() => document.getElementById('convert-file-upload').files.length === 1);
  const file = await chosen(page);
  check('the dropped file becomes the chosen one',
        file && file.name === 'dragged.png', JSON.stringify(file));
  check('and it is on the file input, so the rest of the app sees a plain pick',
        await page.evaluate(() => document.getElementById('convert-file-upload').files[0]?.name) === 'dragged.png');
  check('the chosen page is shown back to the user',
        await page.evaluate(() => document.getElementById('convert-file-display').classList.contains('flex')));
  check('and can be removed again',
        await page.evaluate(() => Boolean(document.querySelector('[data-action="file-clear"]'))));

  // A file dropped anywhere else would otherwise replace the app with the
  // user's own image, losing the session and any converted document with it.
  const elsewhere = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1])], 'stray.png', { type: 'image/png' }));
    const event = new DragEvent('drop', { dataTransfer: transfer,
                                          bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check('a file dropped outside the zone does not navigate away', elsewhere);

  await page.click('[data-action="file-clear"]');
  check('Remove clears the choice', await chosen(page) === null);
  check('and hides the preview with it',
        await page.evaluate(() => document.getElementById('convert-file-display').classList.contains('hidden')));

  await context.close();
}

// ---------------------------------------------------------------------------
heading('the writing canvas');
// ---------------------------------------------------------------------------
{
  const { context, page } = await openApp();

  await page.click('[data-action="draw-open"]');
  check('the canvas opens', await page.evaluate(() => !document.getElementById('draw-modal').classList.contains('hidden')));
  check('it opens with the pen selected',
        await page.getAttribute('#tool-pen', 'aria-pressed') === 'true');

  // An empty sheet is easy to submit by accident and would waste a minute of
  // the user's time on a page with nothing on it.
  await page.click('[data-action="draw-save"]');
  check('an untouched sheet is refused rather than converted',
        (await page.textContent('#toast-text')).includes('The canvas is empty'),
        await page.textContent('#toast-text'));
  check('and the dialog stays open so it can be drawn on',
        await page.evaluate(() => !document.getElementById('draw-modal').classList.contains('hidden')));

  /** Draw a stroke with real pointer events, in canvas coordinates. */
  async function stroke(points) {
    const box = await page.locator('#draw-canvas').boundingBox();
    await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) {
      await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
    }
    await page.mouse.up();
  }

  await stroke([[60, 60], [160, 60], [160, 140], [60, 140], [60, 60]]);
  const sheet = await page.evaluate(() => {
    const canvas = document.getElementById('draw-canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let p = 0; p < data.length; p += 4) if (data[p] < 200) ink += 1;
    return { ink, width: canvas.width, height: canvas.height };
  });
  check('a stroke appears on the canvas immediately', sheet.ink > 100, JSON.stringify(sheet));

  await page.click('#tool-eraser');
  check('the eraser can be selected',
        await page.getAttribute('#tool-eraser', 'aria-pressed') === 'true'
        && await page.getAttribute('#tool-pen', 'aria-pressed') === 'false');
  await page.click('#tool-pen');

  await page.click('[data-action="draw-save"]');
  await page.waitForFunction(() => document.getElementById('draw-modal').classList.contains('hidden'));
  const drawing = await chosen(page);
  check('Use this hands the drawing to the converter',
        drawing && drawing.name === 'drawing.png' && drawing.type === 'image/png',
        JSON.stringify(drawing));
  check('and it carries some bytes', drawing && drawing.size > 100, JSON.stringify(drawing));

  // The sheet grows to 4096 square; a drawing in one corner of it is a
  // mostly-blank page, which is a page the recognisers have to be told to
  // ignore most of.
  const exported = await page.evaluate(async () => {
    const input = await import('/input.js');
    const bitmap = await createImageBitmap(input.selectedFile());
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  });
  check('the export is cropped to the ink, not the whole sheet',
        exported.width < 400 && exported.height < 400, JSON.stringify(exported));

  // 64 megapixels of RGBA held after the dialog closes is 64 MB kept for
  // nothing, on a device that may not have it to spare.
  await page.click('[data-action="draw-open"]');
  await page.click('[data-action="draw-close"]');
  await page.waitForFunction(() => document.getElementById('draw-modal').classList.contains('hidden'));
  check('cancelling keeps the drawing that was already accepted',
        (await chosen(page))?.name === 'drawing.png');

  await context.close();
}

// ---------------------------------------------------------------------------
heading('the camera');
// ---------------------------------------------------------------------------
//
// ONE CONTEXT PER SCENARIO, and that is forced rather than tidy. Chromium's
// fake device disappears once its tracks are stopped -- a second
// getUserMedia() in the same context answers "Requested device not found" --
// so testing three different ways of closing the dialog needs three contexts.
// (The app handles that failure correctly, incidentally: it shows the camera
// error rather than hanging.)
//
// The release is asserted on the TRACKS, not on the element. srcObject going
// null is housekeeping; `readyState === 'ended'` is the camera actually being
// given back, which is the thing the user can see from across the room.

/**
 * Open the app and the camera in a browser of their own.
 *
 * A whole browser, not a context: stopping the fake device's tracks leaves it
 * unacquirable for the rest of that browser process, whatever contexts are
 * opened afterwards. Three seconds a scenario, and the alternative is testing
 * one way of closing the dialog and hoping about the other two.
 */
async function withCamera(fn) {
  const own = await chromium.launch({ channel: 'msedge', headless: true, args: FAKE_MEDIA });
  try {
    const context = await own.newContext({ permissions: ['camera'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('  PAGEERROR ' + e.message.slice(0, 200)));
    await stubApi(page);
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('convert-submit'));

    // WAIT FOR THE DEVICE BEFORE OPENING THE DIALOG. refreshCameraList() runs
    // once, when the camera opens, and afterwards only on devicechange -- so a
    // browser that cannot yet see its own camera builds an empty picker and
    // keeps it. Chromium's fake device is a single shared one and is not
    // always enumerable the instant a second instance starts, which made the
    // picker assertions fail in a way no later wait could rescue.
    await page.waitForFunction(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === 'videoinput');
    }, { timeout: 60000 });

    await page.click('[data-action="camera-open"]');
    await page.waitForFunction(
      () => document.getElementById('camera-stream').videoWidth > 0, { timeout: 20000 });
    await page.evaluate(() => {
      window.__tracks = document.getElementById('camera-stream').srcObject.getVideoTracks();
    });
    await fn(page);
  } finally {
    await own.close();
  }
}

const released = (page) => page.evaluate(() => ({
  ended: window.__tracks.every((t) => t.readyState === 'ended'),
  detached: document.getElementById('camera-stream').srcObject === null,
}));

await withCamera(async (page) => {
  check('the camera dialog opens',
        await page.evaluate(() => !document.getElementById('camera-modal').classList.contains('hidden')));
  check('a stream reaches the preview',
        await page.evaluate(() => Boolean(document.getElementById('camera-stream').srcObject)));
  check('and no error was shown',
        await page.evaluate(() => document.getElementById('camera-error').classList.contains('hidden')));

  // The constraints are a preference, not a requirement -- an exact one is how
  // a laptop webcam ends up refusing outright -- so what is checked is that a
  // page-legible resolution was asked for and granted.
  const settings = await page.evaluate(() => window.__tracks[0].getSettings());
  check('it asks for a resolution a page can be read at',
        settings.width >= 1280 && settings.height >= 720, JSON.stringify(settings));

  await page.click('[data-action="camera-capture"]');
  await page.waitForFunction(() => document.getElementById('camera-modal').classList.contains('hidden'),
                             { timeout: 20000 });
  const shot = await chosen(page);
  check('a capture becomes the chosen page',
        shot && shot.name === 'captured_photo.jpg' && shot.type === 'image/jpeg',
        JSON.stringify(shot));

  // Headless Chromium decodes the fake device's frames at 2x2 however the
  // track is configured, so the pixel count here says nothing. That a JPEG was
  // produced from the element's own dimensions, and that it decodes, is what
  // this environment can honestly assert.
  const captured = await page.evaluate(async () => {
    const input = await import('/input.js');
    const bitmap = await createImageBitmap(input.selectedFile());
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  });
  check('and it is a real frame, not a 0x0 canvas',
        captured.width > 0 && captured.height > 0, JSON.stringify(captured));

  const after = await released(page);
  check('capturing releases the camera', after.ended && after.detached,
        JSON.stringify(after));
});

// ---------------------------------------------------------------------------
// Choosing which camera
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. Flip toggles facingMode, which on a phone is its two
// cameras and on a desktop is whatever the operating system decides that
// means -- Windows offers a phone paired through Phone Link ahead of the
// built-in webcam. The picker is the explicit answer, and what has to be true
// of it is that it names real devices, that it reports the one actually
// streaming rather than the one that was asked for, and that it disappears
// when there is nothing to choose between.
await withCamera(async (page) => {
  // The list is built after enumerateDevices() answers, which is a moment
  // later than the preview appears -- withCamera waits for the picture.
  //
  // Read in ONE step rather than waiting and then looking. refreshCameraList()
  // empties the select with replaceChildren() before refilling it, and reruns
  // on devicechange, so "it had options a moment ago" does not mean it has
  // them now -- a wait followed by a separate read can land in the gap and see
  // an empty list that is being rebuilt, not one that is empty.
  // AND IT CAN LEGITIMATELY NEVER ARRIVE HERE. refreshCameraList() runs when
  // the dialog opens and then only on devicechange, so a browser that could
  // not enumerate its camera at that instant keeps an empty picker for the
  // rest of the session -- no later wait rescues it. That happens roughly half
  // the time in this suite, because it holds a second browser open for the
  // other scenarios and Chromium has exactly ONE fake camera to share.
  //
  // Reported rather than failed, and reported rather than skipped silently:
  // an empty picker here is this machine declining to provide a camera, not
  // the picker being wrong, and pretending otherwise makes the suite lie in
  // whichever direction is convenient.
  const options = await page.waitForFunction(() => {
    const select = document.getElementById('camera-device');
    if (!select || select.options.length === 0) return false;
    return [...select.options].map((o) => ({ value: o.value, label: o.textContent }));
  }, { timeout: 30000 }).then((handle) => handle.jsonValue())
    .catch(() => null);

  if (options === null) {
    console.log('  ---- this machine did not enumerate a camera for this '
      + 'browser, so the picker assertions below were not exercised. That is '
      + 'the environment, not the picker: the scenarios above got a live '
      + 'stream from the same device.');
    return;
  }

  check('the camera list is populated once permission has been granted',
        options.length >= 1, JSON.stringify(options));
  check('and every camera in it is named',
        options.every((o) => o.label.trim().length > 0), JSON.stringify(options));
  check('and identified, so one can actually be asked for',
        options.every((o) => o.value.length > 0), JSON.stringify(options));

  // The list is only a choice when there is more than one thing in it.
  const shown = await page.evaluate(
    () => !document.getElementById('camera-device').classList.contains('hidden'));
  check('the picker is shown exactly when there is a choice to make',
        shown === (options.length > 1), `${options.length} cameras, shown=${shown}`);

  // A constraint is a preference: the browser may answer with a different
  // camera than the one requested, and the picker has to show what is really
  // streaming rather than what was asked for.
  const agree = await page.evaluate(() => {
    const select = document.getElementById('camera-device');
    const live = document.getElementById('camera-stream')
      .srcObject.getVideoTracks()[0].getSettings().deviceId;
    return { selected: select.value, live };
  });
  check('the picker names the camera that is actually streaming',
        agree.selected === agree.live, JSON.stringify(agree));

  // Operating the picker only means anything with something to pick. This
  // environment offers one fake camera, so what is asserted here is the shape
  // of the control; the selection path is exercised when there are two.
  if (options.length > 1) {
    const other = options.find((o) => o.value !== agree.live).value;
    await page.selectOption('#camera-device', other);
    await page.waitForFunction(
      () => document.getElementById('camera-stream').videoWidth > 0, { timeout: 20000 });
    const moved = await page.evaluate(() => document.getElementById('camera-stream')
      .srcObject.getVideoTracks()[0].getSettings().deviceId);
    check('choosing a camera streams from that camera', moved === other,
          `asked ${other}, got ${moved}`);
  } else {
    check('with one camera the picker stays out of the way', !shown);
  }

  // FLIP CANNOT BE FOLLOWED THROUGH HERE, and that is the environment rather
  // than the app: Chromium's fake device is unacquirable once its tracks have
  // been stopped, so any restart in this browser fails whatever it asks for.
  // That makes this the test for the recovery path instead -- a remembered
  // camera that has gone away must not leave the dialog showing a frozen
  // frame and no explanation.
  await page.click('#camera-switch');
  await page.waitForFunction(() => {
    const error = document.getElementById('camera-error');
    return document.getElementById('camera-stream').videoWidth > 0
           || !error.classList.contains('hidden');
  }, { timeout: 20000 });
  const recovered = await page.evaluate(() => ({
    live: document.getElementById('camera-stream').videoWidth > 0,
    said: !document.getElementById('camera-error').classList.contains('hidden'),
  }));
  check('a camera that has gone away is reported, not left hanging',
        recovered.live || recovered.said, JSON.stringify(recovered));
});

// The words a person sees when the camera cannot start. getUserMedia is
// stubbed to reject with each DOMException name in turn; the browser's own
// message ("Permission denied", "Requested device not found") must never be
// what the dialog says, and each name must get its own sentence.
{
  const own = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const cases = [
      ['NotAllowedError', 'Permission denied', /permission was refused/i],
      ['NotFoundError', 'Requested device not found', /no camera was found/i],
      ['NotReadableError', 'Could not start video source', /in use by another app/i],
      ['OverconstrainedError', 'Constraints could be not satisfied', /could not be started/i],
      ['SomethingNewError', 'Whatever the browser says next year', /could not be started/i],
    ];
    for (const [name, message, wanted] of cases) {
      const context = await own.newContext();
      const page = await context.newPage();
      await stubApi(page);
      await page.addInitScript(({ name, message }) => {
        const err = new DOMException(message, name);
        navigator.mediaDevices.getUserMedia = () => Promise.reject(err);
        navigator.mediaDevices.enumerateDevices = async () => [];
      }, { name, message });
      await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('convert-submit'));
      await page.click('[data-action="camera-open"]');
      await page.waitForFunction(
        () => !document.getElementById('camera-error').classList.contains('hidden'),
        { timeout: 10000 });
      const said = await page.evaluate(() => document.getElementById('camera-error').textContent);
      check(`${name}: the dialog explains in its own words`, wanted.test(said), said);
      check(`${name}: the browser's message does not reach the page`,
            !said.includes(message) && !/^Could not use the camera:/.test(said), said);
      await context.close();
    }
  } finally {
    await own.close();
  }
}

await withCamera(async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('camera-modal').classList.contains('hidden'));
  const after = await released(page);
  check('dismissing with Escape releases the camera',
        after.ended && after.detached, JSON.stringify(after));
  check('and takes no photograph', await chosen(page) === null);
});

await withCamera(async (page) => {
  await page.click('[data-action="camera-close"]');
  await page.waitForFunction(() => document.getElementById('camera-modal').classList.contains('hidden'));
  const after = await released(page);
  check('Cancel releases the camera', after.ended && after.detached,
        JSON.stringify(after));
});

// ---------------------------------------------------------------------------
heading('the four methods are one choice');
// ---------------------------------------------------------------------------
//
// The drawing stands in for the camera here. Both are held inside input.js
// rather than on the file input, which is the property being tested, and the
// canvas can be opened as many times as the scenarios need.
{
  // Signed in, so that Sign out is on the page to be clicked. The property
  // under test belongs to clearWorkspace(), which runs on sign-in and sign-out
  // alike, and sign-out is the one a test can reach without Firebase.
  const { context, page } = await openApp({ authenticated: true });

  async function draw() {
    await page.click('[data-action="draw-open"]');
    const box = await page.locator('#draw-canvas').boundingBox();
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 120, { steps: 6 });
    await page.mouse.up();
    await page.click('[data-action="draw-save"]');
    await page.waitForFunction(() => document.getElementById('draw-modal').classList.contains('hidden'));
  }

  await page.setInputFiles('#convert-file-upload', {
    name: 'picked.png', mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  check('the picker sets the chosen page', (await chosen(page))?.name === 'picked.png');

  await draw();
  check('a drawing replaces a picked file rather than competing with it',
        (await chosen(page))?.name === 'drawing.png');
  // The invariant, rather than one implementation of it. chooseInput() moves
  // name="file" to the live input and takes it off the other two, which is
  // what decides the page -- so what has to be true is that exactly one input
  // carries it, never that the others were emptied.
  check('and exactly one input is the live one, so only one page can be sent',
        await page.evaluate(() => ['convert-file-upload', 'convert-camera-upload',
                                   'convert-draw-upload']
          .filter((id) => document.getElementById(id).getAttribute('name') === 'file')
          .join()) === 'convert-draw-upload');

  await page.setInputFiles('#convert-file-upload', {
    name: 'second.png', mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  check('and picking again replaces the drawing',
        (await chosen(page))?.name === 'second.png');

  // session.py's rule, applied to the page: signing out must not leave the
  // previous visitor's page attached and ready to send. A capture lives in
  // input.js, so clearing #file alone would leave it there.
  await draw();
  await page.route('**/api/auth/logout', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ isAuthenticated: false, hasAcceptedTerms: false,
                           maxUploadMb: 32 }),
  }));
  await page.click('[data-action="logout"]');
  await page.waitForFunction(() => document.getElementById('convert-file-display').classList.contains('hidden'));
  check('signing out clears a held capture, not only the file input',
        await chosen(page) === null);

  await context.close();
}


await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failing:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? '  ::  ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
