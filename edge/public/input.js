/**
 * The ways a page gets into ConTeX -- the input half of static/scripts.js.
 *
 * Four of them: the file picker, drag-and-drop, the camera, and the writing
 * canvas. They all converge on ONE file, because the Flask app's rule holds
 * here too -- five input methods, one `name="file"`, and the user is never
 * asked which engine reads their page. That was always a question about our
 * implementation rather than about their document.
 *
 * WHY A MODULE AND NOT PART OF app.js. Two of these hold operating-system
 * resources: the camera holds a MediaStream, and the canvas holds an offscreen
 * sheet that grows. Both have to be released on every exit path -- cancel,
 * Escape, backdrop click, capture, a second dialog opening over the top -- and
 * a camera light that stays on after the dialog closes is the kind of bug that
 * costs the user's trust rather than their conversion.
 */

const el = (id) => document.getElementById(id);

// What the picker offers, mirrored from pages.js. Kept in sync there.
const ACCEPT = '.png,.jpg,.jpeg,.bmp,.tiff,.tif,.webp,.gif,.pdf';

// A capture or a drawing arrives as a Blob rather than through the picker, so
// it is held here and handed to app.js in place of the input's own file.
let captured = null;
let onChangeHandler = null;

function changed() {
  const file = selectedFile();
  el('clear-input').hidden = !file;
  if (onChangeHandler) onChangeHandler(file);
}

/**
 * The page about to be converted, whatever produced it.
 *
 * A capture wins over the picker: it is the more recent choice, and choosing
 * one clears the other, so the two can never both be set.
 */
export function selectedFile() {
  if (captured) return captured;
  return el('file').files[0] || null;
}

/** Show what is about to be converted. A drawing especially: it is easy to
 *  submit a blank sheet, and much easier to notice one in a thumbnail. */
function preview(file) {
  const figure = el('chosen');
  const image = el('chosen-image');
  if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  el('chosen-name').textContent = file ? file.name : '';
  // A PDF gets its name and no thumbnail. Leaving the <img> in place with no
  // src is not "no thumbnail", it is a broken-image icon next to the file the
  // user just chose.
  const thumbnail = Boolean(file) && file.type !== 'application/pdf'
    && !/\.pdf$/i.test(file.name || '');
  image.hidden = !thumbnail;
  if (thumbnail) image.src = URL.createObjectURL(file);
  else image.removeAttribute('src');
  figure.hidden = !file;
}

function adopt(blob, name) {
  captured = new File([blob], name, { type: blob.type || 'image/png' });
  el('file').value = '';
  preview(captured);
  changed();
}

export function clearInput() {
  captured = null;
  el('file').value = '';
  preview(null);
  changed();
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/**
 * Drop anywhere on the zone, not only on the input.
 *
 * dragenter/dragleave fire for every child element the pointer crosses, so a
 * naive listener flickers the highlight on and off across the label. Counting
 * enters against leaves is the standard fix and the only reason this is more
 * than four lines.
 */
function wireDrop() {
  const zone = el('drop');
  let depth = 0;

  const stop = (event) => { event.preventDefault(); event.stopPropagation(); };

  zone.addEventListener('dragenter', (event) => {
    stop(event);
    depth += 1;
    zone.classList.add('over');
  });
  zone.addEventListener('dragover', (event) => {
    stop(event);
    // Without this the browser's default is "move", and the drop is refused.
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (event) => {
    stop(event);
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (event) => {
    stop(event);
    depth = 0;
    zone.classList.remove('over');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    captured = null;
    // A DataTransfer is the only way to put a dropped file into a file input,
    // so the rest of the app sees a drop and a pick as the same thing.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    el('file').files = transfer.files;
    preview(file);
    changed();
  });

  // A file dropped anywhere ELSE would otherwise be opened by the browser,
  // replacing the app with the user's own image and losing their session.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (!zone.contains(event.target)) event.preventDefault();
    });
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

let stream = null;
let facing = 'environment';

function stopCamera() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  const video = el('camera-stream');
  if (video) video.srcObject = null;
}

/**
 * Wait until the element actually has a frame.
 *
 * `play()` resolving is not the same as `videoWidth` being non-zero -- the
 * dimensions arrive with `loadedmetadata`, and capturing before that gives a
 * 0x0 canvas. Measured on the SECOND open: the first worked by luck of timing
 * and the second hung, because the element was still holding the previous
 * stream's ended state.
 */
function firstFrame(video) {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('loadeddata', done);
      resolve();
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('loadeddata', done);
    // Never hang the dialog on it. Capture reports "not ready yet" instead.
    setTimeout(done, 5000);
  });
}

async function startCamera() {
  stopCamera();
  const error = el('camera-error');
  error.hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        // Ask for something a page is legible at. The browser gives the
        // nearest it can rather than failing, so this is a preference and not
        // a requirement -- an exact constraint here is how a laptop webcam
        // ends up refusing outright.
        width: { ideal: 1920 }, height: { ideal: 1080 },
      },
      audio: false,
    });
    const video = el('camera-stream');
    // Cleared and reloaded before the new stream is attached: an element still
    // holding an ended stream does not always fire loadedmetadata for the next
    // one, which is what made reopening the dialog hang.
    video.srcObject = null;
    video.load();
    video.srcObject = stream;
    await video.play().catch(() => {});
    await firstFrame(video);
  } catch (err) {
    error.textContent = 'Could not use the camera: ' + (err?.message || err)
      + '. Check that this page has camera permission, then try again.';
    error.hidden = false;
  }
}

function wireCamera(toast) {
  const dialog = el('camera-modal');

  el('use-camera').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('This browser cannot use the camera.');
      return;
    }
    dialog.showModal();
    await startCamera();
  });

  el('camera-flip').addEventListener('click', async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    await startCamera();
  });

  el('camera-shoot').addEventListener('click', () => {
    const video = el('camera-stream');
    if (!video.videoWidth) { toast('The camera is not ready yet.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { toast('That photo could not be saved.'); return; }
      adopt(blob, 'captured_photo.jpg');
      dialog.close();
    }, 'image/jpeg', 0.92);
  });

  el('camera-cancel').addEventListener('click', () => dialog.close());
  // close fires for the button, for Escape, and for a form submit -- one
  // listener covers every way out, which is what keeps the light off.
  dialog.addEventListener('close', stopCamera);
}

// ---------------------------------------------------------------------------
// The writing canvas
// ---------------------------------------------------------------------------
//
// The visible canvas is a window onto a much larger sheet. Panning moves the
// window; the sheet grows to meet it. Strokes are drawn to the offscreen sheet
// and mirrored onto the view, so a pan never loses ink and the sheet can be
// bigger than any canvas the device would allow on screen.

const SHEET_STEP = 512;          // how much the sheet grows at a time
const MAX_SHEET = 4096;          // and how far it may grow, in either axis
const PEN_WIDTH = 3;
const ERASER_WIDTH = 24;

let sheet = null;                // offscreen: every stroke ever drawn
let view = null;                 // the on-screen canvas
let origin = { x: 0, y: 0 };     // top-left of the view within the sheet
let tool = 'pen';
let drawing = false;
let last = null;
let dirty = false;

function sheetContext() { return sheet.getContext('2d'); }

function newSheet(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // White, not transparent. preprocess.js composites a transparent PNG onto
  // white anyway, but a drawing that LOOKS white and exports transparent is
  // how the Python app got a black page: PIL's convert('L') drops alpha
  // instead of compositing, and the ink mask then flags every pixel.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function growSheet(width, height) {
  const target = newSheet(Math.min(Math.max(sheet.width, width), MAX_SHEET),
                          Math.min(Math.max(sheet.height, height), MAX_SHEET));
  target.getContext('2d').drawImage(sheet, 0, 0);
  sheet = target;
}

function redraw() {
  const ctx = view.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.drawImage(sheet, -origin.x, -origin.y);
  el('canvas-size').textContent =
    `Sheet ${sheet.width}×${sheet.height}. Showing from ` +
    `${Math.round(origin.x)}, ${Math.round(origin.y)}.`;
}

function pointOf(event) {
  const rect = view.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (view.width / rect.width) + origin.x,
    y: (event.clientY - rect.top) * (view.height / rect.height) + origin.y,
  };
}

function strokeTo(point) {
  const ctx = sheetContext();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (tool === 'eraser') {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = ERASER_WIDTH;
  } else {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = PEN_WIDTH;
  }
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  last = point;
  dirty = true;
  redraw();
}

function setTool(next) {
  tool = next;
  for (const [id, name] of [['draw-pen', 'pen'], ['draw-eraser', 'eraser'],
                            ['draw-pan', 'pan']]) {
    el(id).setAttribute('aria-pressed', String(name === next));
  }
  el('canvas-hint').textContent = next === 'pan'
    ? 'Drag to move around the sheet; it grows as you go.'
    : '';
}

function openCanvas() {
  const dialog = el('draw-modal');
  dialog.showModal();

  view = el('draw-canvas');
  const wrap = el('canvas-wrap');
  // Sized to the space it actually has, after layout. A canvas sized before
  // the dialog is shown is sized against a zero-height box.
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.width = Math.max(320, Math.floor(rect.width * dpr));
  view.height = Math.max(240, Math.floor(rect.height * dpr));

  sheet = newSheet(Math.max(view.width, 1024), Math.max(view.height, 1024));
  origin = { x: 0, y: 0 };
  dirty = false;
  setTool('pen');
  redraw();
}

function wireCanvas(toast) {
  const dialog = el('draw-modal');
  el('use-draw').addEventListener('click', openCanvas);
  el('draw-pen').addEventListener('click', () => setTool('pen'));
  el('draw-eraser').addEventListener('click', () => setTool('eraser'));
  el('draw-pan').addEventListener('click', () => setTool('pan'));
  el('draw-cancel').addEventListener('click', () => dialog.close());
  el('draw-clear').addEventListener('click', () => {
    sheet = newSheet(sheet.width, sheet.height);
    dirty = false;
    redraw();
  });

  el('draw-canvas').addEventListener('pointerdown', (event) => {
    event.preventDefault();
    el('draw-canvas').setPointerCapture(event.pointerId);
    drawing = true;
    last = pointOf(event);
  });

  el('draw-canvas').addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const point = pointOf(event);
    if (tool === 'pan') {
      origin.x = Math.max(0, origin.x - (point.x - last.x));
      origin.y = Math.max(0, origin.y - (point.y - last.y));
      // Panning past the edge is a request for more paper.
      if (origin.x + view.width > sheet.width - SHEET_STEP / 2 ||
          origin.y + view.height > sheet.height - SHEET_STEP / 2) {
        growSheet(origin.x + view.width + SHEET_STEP,
                  origin.y + view.height + SHEET_STEP);
      }
      origin.x = Math.min(origin.x, Math.max(0, sheet.width - view.width));
      origin.y = Math.min(origin.y, Math.max(0, sheet.height - view.height));
      redraw();
      return;
    }
    strokeTo(point);
  });

  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    el('draw-canvas').addEventListener(type, () => { drawing = false; last = null; });
  }

  el('draw-done').addEventListener('click', () => {
    if (!dirty) { toast('Nothing has been drawn yet.'); return; }
    // Export the ink, not the sheet: a 4096-square canvas of which the user
    // used a corner is a mostly-blank page, and a mostly-blank page is one the
    // recognisers have to be told to ignore most of.
    const bounds = inkBounds();
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const out = newSheet(width, height);
    out.getContext('2d').drawImage(sheet, bounds.left, bounds.top, width, height,
                                  0, 0, width, height);
    out.toBlob((blob) => {
      if (!blob) { toast('That drawing could not be saved.'); return; }
      adopt(blob, 'drawing.png');
      dialog.close();
    }, 'image/png');
  });

  dialog.addEventListener('close', () => {
    // Let the sheet go. It is up to 64 megapixels of RGBA, and holding it
    // after the dialog closes is 64 MB kept for nothing.
    sheet = null;
    drawing = false;
  });
}

/** The bounding box of everything drawn, with a margin. */
function inkBounds() {
  const { data } = sheetContext().getImageData(0, 0, sheet.width, sheet.height);
  let left = sheet.width;
  let top = sheet.height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      // Anything darker than paper. The pen is #111 and the eraser paints
      // #fff, so this finds strokes and ignores everything erased.
      if (data[(y * sheet.width + x) * 4] < 200) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left) return { left: 0, top: 0, right: sheet.width, bottom: sheet.height };
  const margin = 24;
  return {
    left: Math.max(0, left - margin), top: Math.max(0, top - margin),
    right: Math.min(sheet.width, right + margin + 1),
    bottom: Math.min(sheet.height, bottom + margin + 1),
  };
}

// ---------------------------------------------------------------------------

/** Wire every input method. `onChange` is told whenever the chosen file moves. */
export function init({ toast, onChange } = {}) {
  onChangeHandler = onChange;
  const say = toast || (() => {});
  el('file').setAttribute('accept', ACCEPT);
  el('file').addEventListener('change', () => {
    captured = null;
    preview(el('file').files[0] || null);
    changed();
  });
  el('clear-input').addEventListener('click', clearInput);
  wireDrop();
  wireCamera(say);
  wireCanvas(say);
  changed();
}
