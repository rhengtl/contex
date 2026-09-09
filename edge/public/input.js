/**
 * The four ways a page gets in: the file picker, drag-and-drop, the camera,
 * and the writing canvas.
 *
 * Sections 1, 5 and 6 of static/scripts.js, carried across. The mechanism is
 * the original's and so is the behaviour -- including the parts that look
 * incidental and are not: the sheet that grows when a stroke nears its edge,
 * the coalesced pointer events that keep a fast stroke a curve rather than a
 * chord, and the cached bounding rect that stops every pointermove forcing a
 * synchronous layout.
 *
 * ONE THING IS NOT THE ORIGINAL'S. Flask submitted a <form>, so which input
 * carried name="file" decided what was uploaded. Here nothing is submitted --
 * app.js reads the bytes and converts them in this tab. The name juggling is
 * kept anyway, because it is still the cleanest answer to "which of these
 * three inputs is the live one", and selectedFile() asks exactly that.
 */

import { el, toast, openDialog, closeDialog, onDismiss, confirmAction, setText, on }
  from '/ui.js';

/* ---------------------------------------------------------------------------
   1. Input plumbing
   --------------------------------------------------------------------------- */

const INPUT_TARGETS = {
  convert: {
    file: 'convert-file-upload',
    camera: 'convert-camera-upload',
    draw: 'convert-draw-upload',
    cameraPreview: 'convert-camera-preview',
    drawPreview: 'convert-draw-preview',
    nameLabel: 'convert-file-name',
    nameDisplay: 'convert-file-display',
  },
};

const KINDS = ['file', 'camera', 'draw'];

let activeTarget = 'convert';
let onChange = () => {};

/** Give name="file" to exactly one input in this target's group. */
function chooseInput(target, which, label) {
  const group = INPUT_TARGETS[target];
  if (!group) return;
  for (const kind of KINDS) {
    const element = el(group[kind]);
    if (!element) continue;
    if (kind === which) element.setAttribute('name', 'file');
    else element.removeAttribute('name');
  }

  // Clear the previews that no longer represent the chosen input.
  if (which !== 'camera') hidePreview(group.cameraPreview);
  if (which !== 'draw') hidePreview(group.drawPreview);

  if (!label) {
    const input = el(group[which]);
    label = (input && input.files && input.files.length)
      ? input.files[0].name : 'No file chosen';
  }
  setText(group.nameLabel, label);
  const display = el(group.nameDisplay);
  if (display) display.classList.replace('hidden', 'flex');

  revealSubmit();
  onChange();
}

/**
 * On a phone the Convert button sits below the fold while the input controls
 * are on screen, so choosing a file leaves the next step out of sight. Only
 * scrolls when it actually is out of sight, and only as far as it has to.
 */
function revealSubmit() {
  const button = el('convert-submit');
  if (!button) return;
  const box = button.getBoundingClientRect();
  if (box.bottom <= window.innerHeight - 8) return;
  button.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function hidePreview(id) {
  const preview = id && el(id);
  if (!preview) return;
  // removeAttribute, not src = ''. An empty src resolves to the current page,
  // so clearing a preview that way makes the browser fetch the whole document
  // again in order to fail to decode it.
  if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.removeAttribute('src');
  preview.classList.add('hidden');
  preview.style.display = 'none';
}

function showPreview(id, source) {
  const preview = id && el(id);
  if (!preview) return;
  // A blob URL is held until it is revoked, and this element is the only thing
  // referring to it. Retaking a photo four times would otherwise pin four
  // full-resolution captures in memory for the tab's lifetime.
  if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.src = source;
  preview.classList.remove('hidden');
  preview.style.display = 'block';
}

/** Put a generated blob into a target's input as if the user had picked it. */
function attachBlob(target, which, blob, filename) {
  const group = INPUT_TARGETS[target];
  if (!group) return;
  const input = el(group[which]);
  if (!input) return;
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  chooseInput(target, which, filename);
}

export function clearInput() {
  const group = INPUT_TARGETS.convert;
  for (const kind of KINDS) {
    const element = el(group[kind]);
    if (element) { element.value = ''; element.removeAttribute('name'); }
  }
  // The file picker stays the default for an empty form.
  const picker = el(group.file);
  if (picker) picker.setAttribute('name', 'file');
  hidePreview(group.cameraPreview);
  hidePreview(group.drawPreview);
  const display = el(group.nameDisplay);
  if (display) display.classList.replace('flex', 'hidden');
  onChange();
}

/** The live input's file, or null. */
export function selectedFile() {
  const group = INPUT_TARGETS.convert;
  for (const kind of KINDS) {
    const element = el(group[kind]);
    if (element && element.getAttribute('name') === 'file'
        && element.files && element.files.length) {
      return element.files[0];
    }
  }
  return null;
}

export function hasFileChosen() { return selectedFile() !== null; }
export function chosenFileName() { return selectedFile()?.name || ''; }

/* ---------------------------------------------------------------------------
   5. Camera

   Full-screen preview, native-resolution capture. The preview is cropped to
   fill the screen (object-fit: cover) because a letterboxed preview makes a
   page harder to line up; the captured frame is never cropped, because
   trimming the document to match a screen shape would cost real accuracy.
   --------------------------------------------------------------------------- */

let cameraStream = null;
let cameraFacing = 'environment';

/**
 * WHICH CAMERA, which the Flask version never asked.
 *
 * It had one control, Flip, which toggles facingMode between "environment"
 * and "user". That is a phone's two cameras and it is the whole vocabulary
 * getUserMedia offers without naming devices. On a desktop the operating
 * system decides what "environment" means, and Windows hands over a phone
 * paired through Phone Link ahead of the built-in webcam -- so a laptop with
 * a phone nearby quietly photographs through the phone, with nothing on
 * screen saying so and no way to ask for the other one.
 *
 * `cameraDeviceId` is the explicit answer, and it is remembered for the rest
 * of the session: someone who has said "the webcam, not my phone" once should
 * not have to say it again on the next page they convert.
 */
let cameraDevices = [];
let cameraDeviceId = null;

function openCameraModal(target) {
  activeTarget = target || 'convert';
  if (!el('camera-modal')) return;
  openDialog('camera-modal');
  startCamera();
}

/**
 * List the cameras, and mark the live one.
 *
 * AFTER getUserMedia, never before. enumerateDevices() fills in labels only
 * once permission has been granted; before that every entry is an unnamed
 * "videoinput", and a chooser offering three of those is not a chooser.
 */
async function refreshCameraList() {
  const select = el('camera-device');
  if (!select || !navigator.mediaDevices?.enumerateDevices) return;

  try {
    cameraDevices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'videoinput');
  } catch {
    return;   // a browser that will not enumerate simply gets Flip
  }

  // What is actually streaming, which is not necessarily what was asked for:
  // a constraint is a preference and the browser may answer with another
  // camera entirely.
  const live = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId
    || cameraDeviceId;

  select.replaceChildren();
  cameraDevices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    // Firefox names only the default device. Numbering the rest beats
    // offering a list of blank rows.
    option.textContent = device.label || `Camera ${index + 1}`;
    select.appendChild(option);
  });
  if (live && cameraDevices.some((device) => device.deviceId === live)) {
    select.value = live;
  }
  cameraDeviceId = select.value || null;
  select.title = select.selectedOptions[0]?.textContent || '';
  select.classList.toggle('hidden', cameraDevices.length < 2);
}

function startCamera() {
  const video = el('camera-stream');
  const error = el('camera-error');
  if (error) error.classList.add('hidden');

  stopCameraTracks();
  // The element holds the previous, now-ended stream until it is told
  // otherwise, and a <video> given a dead track never fires loadedmetadata
  // again -- which is what made reopening the camera hang.
  if (video) { video.srcObject = null; video.load(); }

  const wanted = {
    // Ask for the most detail the device will give us. A document photo is
    // read by an OCR engine, and resolution is the one thing it cannot
    // recover later.
    width: { ideal: 3840 },
    height: { ideal: 2160 },
  };
  // `exact`, so a chosen camera is honoured rather than treated as a hint --
  // the whole point of choosing is that the browser stops deciding. The
  // failure that buys is handled below.
  if (cameraDeviceId) wanted.deviceId = { exact: cameraDeviceId };
  else wanted.facingMode = cameraFacing;

  navigator.mediaDevices.getUserMedia({ video: wanted, audio: false })
    .then(async (stream) => {
      cameraStream = stream;
      if (video) video.srcObject = stream;
      await refreshCameraList();
    })
    .catch((err) => {
      // The remembered camera is gone -- the phone was unpaired, the webcam
      // unplugged. Forget it and take whatever there is rather than showing
      // an error about a device the user is no longer holding.
      if (cameraDeviceId) {
        cameraDeviceId = null;
        startCamera();
        return;
      }
      if (!error) return;
      error.textContent = `Could not use the camera: ${err.message}`
        + '. Check that this page has camera permission, then try again - or '
        + 'write the page by hand instead.';
      error.classList.remove('hidden');
    });
}

/** The next camera along, or the other way round when there is no list. */
function switchCamera() {
  if (cameraDevices.length > 1) {
    const at = cameraDevices.findIndex((device) => device.deviceId === cameraDeviceId);
    cameraDeviceId = cameraDevices[(at + 1) % cameraDevices.length].deviceId;
  } else {
    cameraDeviceId = null;
    cameraFacing = (cameraFacing === 'environment') ? 'user' : 'environment';
  }
  startCamera();
}

/** The picker's own answer, which is the one that overrides everything. */
function chooseCamera(deviceId) {
  if (!deviceId || deviceId === cameraDeviceId) return;
  cameraDeviceId = deviceId;
  startCamera();
}

function stopCameraTracks() {
  if (!cameraStream) return;
  for (const track of cameraStream.getTracks()) track.stop();
  cameraStream = null;
}

function closeCameraModal() {
  closeDialog('camera-modal');
  const video = el('camera-stream');
  stopCameraTracks();
  if (video) video.srcObject = null;
}

function capturePhoto() {
  const video = el('camera-stream');
  if (!video || !video.videoWidth) { toast('The camera is not ready yet.'); return; }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  const target = activeTarget;
  // JPEG, not PNG: a 4K photograph as PNG is tens of megabytes and would hit
  // the upload limit for no gain - photographs have no flat colour to keep.
  canvas.toBlob((blob) => {
    if (!blob) { toast('Could not capture that photo.'); return; }
    attachBlob(target, 'camera', blob, 'captured_photo.jpg');
    showPreview(INPUT_TARGETS[target].cameraPreview, URL.createObjectURL(blob));
    toast('Photo captured.');
  }, 'image/jpeg', 0.92);

  closeCameraModal();
}

/* ---------------------------------------------------------------------------
   6. Writing canvas

   The visible canvas is a window onto a much larger sheet. Panning moves the
   window; the sheet grows when a stroke nears its edge, copying the existing
   ink into the larger surface so nothing written is ever lost. Nobody has to
   choose how much room they need before they start writing.
   --------------------------------------------------------------------------- */

const SHEET_START_W = 2200;
const SHEET_START_H = 1500;
const SHEET_GROW = 900;         // added when a stroke approaches an edge
const EDGE_MARGIN = 140;        // how close to the edge triggers growth
const AUTOPAN_MARGIN = 70;      // how close to the view edge starts scrolling

let sheet = null;               // offscreen canvas: every stroke ever drawn
let sheetCtx = null;
let view = null;                // the on-screen canvas
let viewCtx = null;
let origin = { x: 0, y: 0 };    // top-left of the view, in sheet coordinates
let tool = 'pen';
let brushSize = 3;
let drawing = false;
let panning = false;
let spaceHeld = false;
let last = { x: 0, y: 0 };
let panStart = null;
const activePointers = new Map();
let inkBounds = null;           // rough extent of drawn strokes, in sheet coords

function openDrawModal(target) {
  activeTarget = target || 'convert';
  if (!el('draw-modal')) return;
  openDialog('draw-modal');

  if (!sheet) createSheet(SHEET_START_W, SHEET_START_H);
  // Wait for layout so the canvas can be sized to the space it actually has.
  requestAnimationFrame(() => { resizeView(); render(); });
}

function closeDrawModal() {
  closeDialog('draw-modal');
  hideBrushCursor();
}

function createSheet(width, height) {
  sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  sheetCtx = sheet.getContext('2d', { willReadFrequently: true });
  // Paint the page white rather than leaving it transparent. A transparent PNG
  // loses its background when converted to greyscale, which made an entire
  // drawing read as solid ink to every OCR engine.
  sheetCtx.fillStyle = '#ffffff';
  sheetCtx.fillRect(0, 0, width, height);
  origin = { x: 0, y: 0 };
  inkBounds = null;
}

/** Grow the sheet, keeping everything already on it. */
function growSheet(right, down) {
  const grown = document.createElement('canvas');
  grown.width = sheet.width + right;
  grown.height = sheet.height + down;
  const ctx = grown.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, grown.width, grown.height);
  ctx.drawImage(sheet, 0, 0);
  sheet = grown;
  sheetCtx = ctx;
  updateSizeLabel();
}

function resizeView() {
  view = el('draw-canvas');
  if (!view) return;
  const wrap = el('canvas-wrap');
  const ratio = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  view.style.width = `${width}px`;
  view.style.height = `${height}px`;
  view.width = Math.round(width * ratio);
  view.height = Math.round(height * ratio);
  viewCtx = view.getContext('2d');
  viewCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  refreshViewRect();
  clampOrigin();
  updateSizeLabel();
}

function viewSize() {
  if (!view) return { w: 0, h: 0 };
  const ratio = window.devicePixelRatio || 1;
  return { w: view.width / ratio, h: view.height / ratio };
}

function clampOrigin() {
  const size = viewSize();
  origin.x = Math.max(0, Math.min(origin.x, Math.max(0, sheet.width - size.w)));
  origin.y = Math.max(0, Math.min(origin.y, Math.max(0, sheet.height - size.h)));
}

function render() {
  if (!viewCtx) return;
  const size = viewSize();
  viewCtx.fillStyle = '#ffffff';
  viewCtx.fillRect(0, 0, size.w, size.h);
  viewCtx.drawImage(sheet, -origin.x, -origin.y);
}

/**
 * Panning used to repaint the whole sheet once per pointer event. A pen or a
 * trackpad reports far more often than the screen refreshes, so most of those
 * repaints were overwritten before anyone saw them. This collapses them to one
 * per frame, which is all a display can show anyway.
 */
let renderQueued = false;

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function updateSizeLabel() {
  if (sheet) setText('canvas-size', `${sheet.width} × ${sheet.height}`);
}

function setTool(next) {
  tool = next;
  for (const [name, id] of [['pen', 'tool-pen'], ['eraser', 'tool-eraser'],
                            ['pan', 'tool-pan']]) {
    const button = el(id);
    if (!button) continue;
    const active = (name === next);
    // Component classes, so the toolbar cannot drift away from every other
    // control in the application. Written as whole literal strings because
    // that is what Tailwind's scanner reads.
    button.className = active ? 'toolbtn-active' : 'toolbtn';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  setText('canvas-hint', next === 'pan'
    ? 'Drag to move around the sheet.'
    : 'Drag to write. Hold space, use the middle button, or two fingers to pan.');
  updateBrushCursorStyle();
}

/** The cursor indicator: exactly the footprint the tool will affect. */
function updateBrushCursorStyle() {
  const cursor = el('brush-cursor');
  if (!cursor) return;
  const diameter = Math.max(brushSize, 4);
  cursor.style.width = `${diameter}px`;
  cursor.style.height = `${diameter}px`;
  cursor.style.marginLeft = `${-diameter / 2}px`;
  cursor.style.marginTop = `${-diameter / 2}px`;
  if (tool === 'eraser') {
    // burgundy-400 and paper, against the ink-900 canvas surround.
    cursor.style.borderColor = '#BF5C72';
    cursor.style.background = 'rgba(251,250,248,0.32)';
  } else {
    cursor.style.borderColor = '#FBFAF8';
    cursor.style.background = 'rgba(251,250,248,0.18)';
  }
  cursor.classList.toggle('hidden', tool === 'pan');
}

/**
 * Moved with a transform rather than left/top: a transform is handled by the
 * compositor and does not invalidate layout, so following the pen costs the
 * main thread nothing.
 */
function moveBrushCursor(x, y) {
  const cursor = el('brush-cursor');
  if (!cursor || tool === 'pan') return;
  cursor.style.transform = `translate(${x}px,${y}px)`;
  cursor.classList.remove('hidden');
}

function hideBrushCursor() {
  const cursor = el('brush-cursor');
  if (cursor) cursor.classList.add('hidden');
}

/**
 * The canvas's position on screen, remembered between pointer events.
 *
 * getBoundingClientRect() forces the browser to settle pending layout before
 * it can answer. Calling it inside pointermove - which also writes to the
 * brush cursor's style - made every single move event a forced synchronous
 * layout, on the one code path that has to keep up with a pen. The rect only
 * changes when the window or the modal does, so it is recomputed there.
 */
let viewRect = null;

function refreshViewRect() { viewRect = view ? view.getBoundingClientRect() : null; }

function pointInView(event) {
  if (!viewRect) refreshViewRect();
  const rect = viewRect || { left: 0, top: 0 };
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function toSheet(point) { return { x: point.x + origin.x, y: point.y + origin.y }; }

function noteInk(point) {
  if (!inkBounds) {
    inkBounds = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
    return;
  }
  inkBounds.minX = Math.min(inkBounds.minX, point.x);
  inkBounds.minY = Math.min(inkBounds.minY, point.y);
  inkBounds.maxX = Math.max(inkBounds.maxX, point.x);
  inkBounds.maxY = Math.max(inkBounds.maxY, point.y);
}

function strokeSegment(from, to) {
  const settings = (ctx) => {
    ctx.strokeStyle = (tool === 'eraser') ? '#ffffff' : '#111827';
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  settings(sheetCtx);
  sheetCtx.beginPath();
  sheetCtx.moveTo(from.x, from.y);
  sheetCtx.lineTo(to.x, to.y);
  sheetCtx.stroke();

  // Mirror onto the visible canvas so a stroke appears immediately, without
  // redrawing the whole sheet on every pointer move.
  if (viewCtx) {
    settings(viewCtx);
    viewCtx.beginPath();
    viewCtx.moveTo(from.x - origin.x, from.y - origin.y);
    viewCtx.lineTo(to.x - origin.x, to.y - origin.y);
    viewCtx.stroke();
  }

  if (tool !== 'eraser') { noteInk(from); noteInk(to); }
}

function maybeGrow(point) {
  let right = 0;
  let down = 0;
  if (point.x > sheet.width - EDGE_MARGIN) right = SHEET_GROW;
  if (point.y > sheet.height - EDGE_MARGIN) down = SHEET_GROW;
  if (right || down) growSheet(right, down);
}

/**
 * Scroll the window when the pointer nears its edge, so a stroke can run past
 * the visible area without the user stopping to pan.
 */
function maybeAutoPan(point) {
  const size = viewSize();
  let dx = 0;
  let dy = 0;
  if (point.x > size.w - AUTOPAN_MARGIN) dx = point.x - (size.w - AUTOPAN_MARGIN);
  if (point.x < AUTOPAN_MARGIN) dx = point.x - AUTOPAN_MARGIN;
  if (point.y > size.h - AUTOPAN_MARGIN) dy = point.y - (size.h - AUTOPAN_MARGIN);
  if (point.y < AUTOPAN_MARGIN) dy = point.y - AUTOPAN_MARGIN;
  if (!dx && !dy) return false;

  origin.x += dx * 0.35;
  origin.y += dy * 0.35;
  clampOrigin();
  requestRender();
  return true;
}

function setupCanvas() {
  const canvas = el('draw-canvas');
  if (!canvas) return;
  view = canvas;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    // Once per stroke rather than once per move: cheap here, and it means the
    // cached rect cannot go stale if anything moved the canvas without a
    // resize event.
    refreshViewRect();
    activePointers.set(event.pointerId, pointInView(event));

    const wantsPan = tool === 'pan' || spaceHeld || event.button === 1
      || activePointers.size > 1;
    if (wantsPan) {
      drawing = false;
      panning = true;
      panStart = { point: pointInView(event), origin: { x: origin.x, y: origin.y } };
      return;
    }
    drawing = true;
    last = toSheet(pointInView(event));
    maybeGrow(last);
    // A tap with no movement should still leave a mark.
    strokeSegment(last, { x: last.x + 0.01, y: last.y });
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = pointInView(event);
    moveBrushCursor(point.x, point.y);
    if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, point);

    if (panning && panStart) {
      origin.x = panStart.origin.x - (point.x - panStart.point.x);
      origin.y = panStart.origin.y - (point.y - panStart.point.y);
      clampOrigin();
      requestRender();
      return;
    }
    if (!drawing) return;

    const scrolled = maybeAutoPan(point);

    // Every position the pen reported since the last event, not just the one
    // the browser chose to deliver. A fast stroke can cover several hundred
    // pixels between frames; drawing only the endpoints turns a curve into a
    // chord. This is finer input, not coarser - the stroke the model reads is
    // closer to what was written.
    const moves = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
    const points = (moves && moves.length) ? moves.map(pointInView) : [point];
    for (const raw of points) {
      const here = toSheet(raw);
      maybeGrow(here);
      strokeSegment(last, here);
      last = here;
    }
    if (scrolled) requestRender();
  });

  for (const name of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(name, (event) => {
      activePointers.delete(event.pointerId);
      if (activePointers.size === 0) { drawing = false; panning = false; panStart = null; }
    });
  }

  canvas.addEventListener('pointerleave', hideBrushCursor);
  canvas.addEventListener('pointerenter', updateBrushCursorStyle);

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') spaceHeld = true;
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') spaceHeld = false;
  });

  const slider = el('brush-size');
  if (slider) {
    slider.addEventListener('input', () => {
      brushSize = parseInt(slider.value, 10) || 1;
      setText('size-label', `Size ${brushSize}`);
      updateBrushCursorStyle();
    });
  }

  window.addEventListener('resize', () => {
    const modal = el('draw-modal');
    if (modal && !modal.classList.contains('hidden')) { resizeView(); render(); }
  });

  setTool('pen');
}

function clearCanvas() {
  confirmAction(
    'Clear the canvas?',
    'Everything you have written will be thrown away. This cannot be undone.',
    'Clear everything',
    () => {
      createSheet(SHEET_START_W, SHEET_START_H);
      resizeView();
      render();
      toast('Canvas cleared.');
    });
}

/** Find the true extent of the ink, so a mostly-empty sheet is not exported. */
function measureInk() {
  if (!inkBounds) return null;
  const pad = 4;
  const x0 = Math.max(0, Math.floor(inkBounds.minX - pad));
  const y0 = Math.max(0, Math.floor(inkBounds.minY - pad));
  const x1 = Math.min(sheet.width, Math.ceil(inkBounds.maxX + pad));
  const y1 = Math.min(sheet.height, Math.ceil(inkBounds.maxY + pad));
  if (x1 <= x0 || y1 <= y0) return null;

  // The tracked bounds only ever grow, so after erasing they can describe an
  // area with nothing left in it. Scan the pixels to get the real answer.
  const { data } = sheetCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const width = x1 - x0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) continue;
    const pixel = i / 4;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { x: x0 + minX, y: y0 + minY, w: (maxX - minX) + 1, h: (maxY - minY) + 1 };
}

function saveDrawing() {
  if (!sheet) { toast('Nothing to save yet.'); return; }
  const ink = measureInk();
  if (!ink) { toast('The canvas is empty - write something first.'); return; }

  // Export only the region that was actually written on, with a margin. A
  // 3000-pixel sheet that is 95% blank costs upload size and gives the
  // recognisers a page of nothing to search through.
  const margin = 32;
  const out = document.createElement('canvas');
  out.width = Math.round(ink.w + margin * 2);
  out.height = Math.round(ink.h + margin * 2);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(sheet, ink.x, ink.y, ink.w, ink.h, margin, margin, ink.w, ink.h);

  const target = activeTarget;
  out.toBlob((blob) => {
    if (!blob) { toast('Could not save that drawing.'); return; }
    attachBlob(target, 'draw', blob, 'drawing.png');
    // The same bytes the blob already holds, rather than encoding the canvas
    // to PNG a second time and base64-ing the result.
    showPreview(INPUT_TARGETS[target].drawPreview, URL.createObjectURL(blob));
    toast('Drawing ready to convert.');
  }, 'image/png');

  closeDrawModal();
}

/* ---------------------------------------------------------------------------
   Drag and drop

   Routes through chooseInput() so a dropped file also wins name="file" from
   the camera and draw inputs.
   --------------------------------------------------------------------------- */

function preventDefaults(event) {
  event.preventDefault();
  event.stopPropagation();
}

function setupDragDrop(accepted) {
  const dropArea = el('convert-drop-area');
  const fileInput = el('convert-file-upload');
  if (!dropArea || !fileInput) return;

  // No click handler: the drop area is a <label> for the file input, so the
  // browser opens the picker itself. Adding one here would open it twice.

  for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    dropArea.addEventListener(name, preventDefaults, false);
  }

  // AND ON THE WINDOW, which the original did not do. A file dropped anywhere
  // outside the zone is handled by the browser, which navigates to it -- so a
  // near miss replaces the application with the user's own image, taking the
  // session and any converted document on screen with it. There is nothing to
  // recover afterwards, which is why this is prevented rather than reproduced.
  for (const name of ['dragover', 'drop']) {
    window.addEventListener(name, (event) => {
      if (dropArea.contains(event.target)) return;
      event.preventDefault();
    }, false);
  }

  // COUNTED, not toggled, which is the one change from the original's version.
  // dragenter and dragleave both fire for every child the pointer crosses, and
  // the spec fires the new target's dragenter before the old target's
  // dragleave -- so add/remove on the bare events leaves the zone dark while
  // the pointer is over the icon inside it, and the highlight flickers all the
  // way across. The depth counter is what makes "still inside" mean it.
  let depth = 0;
  dropArea.addEventListener('dragenter', () => {
    depth += 1;
    dropArea.classList.add('is-dragging');
  }, false);
  dropArea.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dropArea.classList.remove('is-dragging');
  }, false);
  dropArea.addEventListener('drop', () => {
    depth = 0;
    dropArea.classList.remove('is-dragging');
  }, false);

  dropArea.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    const extension = `.${files[0].name.split('.').pop().toLowerCase()}`;
    if (accepted.length && !accepted.includes(extension)) {
      toast(`Unsupported file type. Accepted: ${accepted.join(', ')}`);
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(files[0]);
    fileInput.files = transfer.files;
    chooseInput('convert', 'file', files[0].name);
  }, false);
}

/* ---------------------------------------------------------------------------
   Wiring
   --------------------------------------------------------------------------- */

export function init({ accepted = [], onChange: changed = () => {} } = {}) {
  onChange = changed;
  if (!el('convert-form')) return;

  setupDragDrop(accepted);
  setupCanvas();
  updateBrushCursorStyle();

  onDismiss('camera-modal', closeCameraModal);
  onDismiss('draw-modal', closeDrawModal);

  on({
    'camera-open': (element) => openCameraModal(element.dataset.arg),
    'camera-close': () => closeCameraModal(),
    'camera-switch': () => switchCamera(),
    'camera-capture': () => capturePhoto(),
    'draw-open': (element) => openDrawModal(element.dataset.arg),
    'draw-close': () => closeDrawModal(),
    'draw-tool': (element) => setTool(element.dataset.arg),
    'draw-clear': () => clearCanvas(),
    'draw-save': () => saveDrawing(),
    'file-clear': () => clearInput(),
  });
  on({
    'choose-file': (element) => chooseInput(element.dataset.arg, 'file'),
    'camera-device': (element) => chooseCamera(element.value),
  }, null, 'change');

  // A phone paired or unpaired while the camera is open changes the list
  // under the user. Only while it is open: enumerating otherwise is a
  // question about their hardware that nothing on the page is asking.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (cameraStream) refreshCameraList();
  });
}
