/* ===========================================================================
   ConTeX front end.

   One conversion form, five ways to fill it, and three things you can do with
   the result. The sections below are, in order:

     1. Input plumbing      which of the form's file inputs is the live one
     2. Terms gate          nothing is usable until this is accepted
     3. Legal modals        read the terms without leaving the page
     4. AI availability     warn before falling back, never after
     5. Camera              full-screen capture at the sensor's own resolution
     6. Writing canvas      an expandable sheet, pen / eraser / pan
     7. Output              PDF preview, copy, download
     8. History             the same three actions on a past conversion
   =========================================================================== */

var pageData = window.pageData || {};

/* ---------------------------------------------------------------------------
   1. Input plumbing

   A form submits whichever of its file inputs currently carries name="file" -
   that is how one <form> supports picking a file, taking a photo and drawing
   without three separate submit buttons.
   --------------------------------------------------------------------------- */
const INPUT_TARGETS = {
    convert: {
        file: 'convert-file-upload',
        camera: 'convert-camera-upload',
        draw: 'convert-draw-upload',
        cameraPreview: 'convert-camera-preview',
        drawPreview: 'convert-draw-preview',
        nameLabel: 'convert-file-name',
        nameDisplay: 'convert-file-display'
    }
};

let activeTarget = 'convert';

/* Give name="file" to exactly one input in this target's group. */
function chooseInput(target, which, label) {
    const group = INPUT_TARGETS[target];
    if (!group) return;
    ['file', 'camera', 'draw'].forEach(function (kind) {
        const element = document.getElementById(group[kind]);
        if (!element) return;
        if (kind === which) {
            element.setAttribute('name', 'file');
        } else {
            element.removeAttribute('name');
        }
    });

    // Clear the previews that no longer represent the chosen input.
    if (which !== 'camera') hidePreview(group.cameraPreview);
    if (which !== 'draw') hidePreview(group.drawPreview);

    if (!label) {
        const input = document.getElementById(group[which]);
        label = (input && input.files && input.files.length)
            ? input.files[0].name : 'No file chosen';
    }
    const nameLabel = document.getElementById(group.nameLabel);
    if (nameLabel) nameLabel.textContent = label;
    const display = document.getElementById(group.nameDisplay);
    if (display) display.classList.remove('hidden');
}

function hidePreview(id) {
    const preview = id && document.getElementById(id);
    if (preview) {
        preview.src = '';
        preview.classList.add('hidden');
        preview.style.display = 'none';
    }
}

function showPreview(id, source) {
    const preview = id && document.getElementById(id);
    if (preview) {
        // A blob URL is held until it is revoked, and this element is the only
        // thing referring to it. Retaking a photo four times would otherwise
        // pin four full-resolution captures in memory for the tab's lifetime.
        if (preview.src && preview.src.indexOf('blob:') === 0) {
            URL.revokeObjectURL(preview.src);
        }
        preview.src = source;
        preview.classList.remove('hidden');
        preview.style.display = 'block';
    }
}

/* Put a generated blob into a target's input as if the user had picked it. */
function attachBlob(target, which, blob, filename) {
    const group = INPUT_TARGETS[target];
    if (!group) return;
    const input = document.getElementById(group[which]);
    if (!input) return;
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    chooseInput(target, which, filename);
}

function clearConvertFile() {
    const group = INPUT_TARGETS.convert;
    ['file', 'camera', 'draw'].forEach(function (kind) {
        const element = document.getElementById(group[kind]);
        if (element) {
            element.value = '';
            element.removeAttribute('name');
        }
    });
    // The file picker stays the default submitter for an empty form.
    const picker = document.getElementById(group.file);
    if (picker) picker.setAttribute('name', 'file');
    hidePreview(group.cameraPreview);
    hidePreview(group.drawPreview);
    const display = document.getElementById(group.nameDisplay);
    if (display) display.classList.add('hidden');
}

function hasFileChosen() {
    const group = INPUT_TARGETS.convert;
    return ['file', 'camera', 'draw'].some(function (kind) {
        const element = document.getElementById(group[kind]);
        return element && element.getAttribute('name') === 'file'
            && element.files && element.files.length > 0;
    });
}


/* ---------------------------------------------------------------------------
   2. Terms gate

   The checkbox enables the controls; the server checks the session again on
   every POST. Disabling the fieldset is a courtesy, not the enforcement.
   --------------------------------------------------------------------------- */

function setupTermsGate() {
    const box = document.getElementById('terms-checkbox');
    if (!box) return;

    box.addEventListener('change', function () {
        const error = document.getElementById('terms-error');
        if (error) error.classList.add('hidden');

        if (!box.checked) {
            lockControls(true);
            return;
        }
        box.disabled = true;

        const body = new URLSearchParams();
        body.set('version', box.dataset.version || pageData.termsVersion || '');

        fetch(pageData.acceptTermsUrl || '/accept-terms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        }).then(function (response) {
            return response.json().catch(function () { return { ok: false }; });
        }).then(function (data) {
            if (data && data.ok) {
                lockControls(false);
                const gate = document.getElementById('terms-gate');
                if (gate) gate.classList.add('hidden');
                toast('Thanks - you can now convert a document.');
            } else {
                box.checked = false;
                box.disabled = false;
                showTermsError((data && data.error)
                    || 'Could not record your acceptance. Please try again.');
            }
        }).catch(function () {
            box.checked = false;
            box.disabled = false;
            showTermsError('Could not reach the server. Please try again.');
        });
    });
}

function showTermsError(message) {
    const error = document.getElementById('terms-error');
    if (!error) return;
    error.textContent = message;
    error.classList.remove('hidden');
}

function lockControls(locked) {
    const controls = document.getElementById('convert-controls');
    if (!controls) return;
    controls.disabled = locked;
    controls.classList.toggle('opacity-50', locked);
    controls.classList.toggle('pointer-events-none', locked);
}


/* ---------------------------------------------------------------------------
   3. Legal modals
   --------------------------------------------------------------------------- */

const LEGAL_TITLES = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
let legalCache = {};

function openLegal(which) {
    const modal = document.getElementById('legal-modal');
    const body = document.getElementById('legal-body');
    const title = document.getElementById('legal-title');
    if (!modal || !body) return;

    if (title) title.textContent = LEGAL_TITLES[which] || 'Legal';
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    if (legalCache[which]) {
        body.innerHTML = legalCache[which];
        return;
    }
    body.innerHTML = '<p class="text-sm text-forest-600">Loading&hellip;</p>';

    const urls = pageData.legalUrls || {};
    fetch(urls[which] || ('/legal/' + which))
        .then(function (response) {
            if (!response.ok) throw new Error('unavailable');
            return response.text();
        })
        .then(function (html) {
            legalCache[which] = html;
            body.innerHTML = html;
        })
        .catch(function () {
            body.innerHTML = '<p class="text-sm text-red-700">This document '
                + 'could not be loaded. Please try again.</p>';
        });
}

function closeLegal() {
    const modal = document.getElementById('legal-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
}


/* ---------------------------------------------------------------------------
   4. AI availability

   Checked immediately before a conversion starts, never after. A user who is
   about to get a materially worse result is told so while they can still
   decide not to.
   --------------------------------------------------------------------------- */

let pendingSubmit = false;

function setupAvailabilityGate() {
    const form = document.getElementById('convert-form');
    if (!form) return;

    form.addEventListener('submit', function (event) {
        if (pendingSubmit) return;          // the user already answered
        if (!hasFileChosen()) {
            event.preventDefault();
            toast('Choose a file, take a photo, or write something first.');
            return;
        }
        event.preventDefault();

        setSubmitting(true, 'Checking…');
        fetch(pageData.aiStatusUrl || '/api/ai-status')
            .then(function (response) { return response.json(); })
            .then(function (status) {
                if (status && status.available) {
                    pendingSubmit = true;
                    setSubmitting(true, 'Converting…');
                    form.submit();
                } else {
                    setSubmitting(false);
                    showAiModal(status);
                }
            })
            .catch(function () {
                // The status endpoint is part of this app; if it cannot be
                // reached the server is not going to convert anything either.
                setSubmitting(false);
                showAiModal({
                    available: false,
                    reason: 'This server could not be reached to check whether '
                          + 'AI conversion is available.',
                    services: [],
                    recovery: { known: false,
                                text: 'No estimated recovery time is currently available.' }
                });
            });
    });
}

function showAiModal(status) {
    const modal = document.getElementById('ai-modal');
    if (!modal) return;
    status = status || {};

    setText('ai-modal-reason', status.reason
        || 'The AI conversion service is currently unavailable.');

    const services = (status.services || []).map(function (service) {
        const models = (service.models || []).join(', ');
        return models ? (service.name + ' (' + models + ')') : service.name;
    });
    setText('ai-modal-services', services.length ? services.join('; ')
        : 'The affected service could not be identified.');

    const recovery = status.recovery || {};
    setText('ai-modal-recovery', recovery.text
        || 'No estimated recovery time is currently available.');
    const source = document.getElementById('ai-modal-recovery-source');
    if (source) {
        source.textContent = recovery.source ? ('Source: ' + recovery.source) : '';
        source.classList.toggle('hidden', !recovery.source);
    }

    setText('ai-modal-checked', status.checked_at
        ? ('Checked at ' + status.checked_at) : '');

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function hideAiModal() {
    const modal = document.getElementById('ai-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

/* Re-check, so a warning cannot outlive the outage that produced it. */
function recheckAi() {
    const button = document.getElementById('ai-modal-recheck');
    if (button) { button.disabled = true; button.textContent = 'Checking…'; }

    fetch(pageData.aiStatusUrl || '/api/ai-status')
        .then(function (response) { return response.json(); })
        .then(function (status) {
            if (status && status.available) {
                hideAiModal();
                toast('AI conversion is available again. Converting…');
                pendingSubmit = true;
                setSubmitting(true, 'Converting…');
                document.getElementById('convert-form').submit();
            } else {
                showAiModal(status);
                toast('Still unavailable.');
            }
        })
        .catch(function () { toast('Could not check right now.'); })
        .finally(function () {
            if (button) { button.disabled = false; button.textContent = 'Check again'; }
        });
}

function continueWithFallback() {
    const flag = document.getElementById('allow-fallback');
    if (flag) flag.value = '1';
    hideAiModal();
    pendingSubmit = true;
    setSubmitting(true, 'Converting without AI…');
    document.getElementById('convert-form').submit();
}

function cancelConversion() {
    const flag = document.getElementById('allow-fallback');
    if (flag) flag.value = '';
    hideAiModal();
    setSubmitting(false);
    toast('Cancelled. Your document was not converted.');
}

function setSubmitting(busy, label) {
    const button = document.getElementById('convert-submit');
    if (!button) return;
    button.disabled = !!busy;
    if (busy && label) {
        button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
        button.textContent = label;
    } else if (!busy && button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel;
    }
}


/* ---------------------------------------------------------------------------
   5. Camera

   Full-screen preview, native-resolution capture. The preview is cropped to
   fill the screen (object-fit: cover) because a letterboxed preview makes a
   page harder to line up; the captured frame is never cropped, because
   trimming the document to match a screen shape would cost real accuracy.
   --------------------------------------------------------------------------- */

let cameraStream = null;
let cameraFacing = 'environment';

function openCameraModal(target) {
    activeTarget = target || 'convert';
    const modal = document.getElementById('camera-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'block';
    startCamera();
}

function startCamera() {
    const video = document.getElementById('camera-stream');
    const error = document.getElementById('camera-error');
    if (error) error.classList.add('hidden');

    stopCameraTracks();

    const constraints = {
        video: {
            facingMode: cameraFacing,
            // Ask for the most detail the device will give us. A document photo
            // is read by an OCR engine, and resolution is the one thing it
            // cannot recover later.
            width: { ideal: 3840 },
            height: { ideal: 2160 }
        },
        audio: false
    };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
            cameraStream = stream;
            if (video) video.srcObject = stream;
        })
        .catch(function (err) {
            if (error) {
                error.textContent = 'Could not access the camera: ' + err.message
                    + '. Check that this page has camera permission.';
                error.classList.remove('hidden');
            }
        });
}

function switchCamera() {
    cameraFacing = (cameraFacing === 'environment') ? 'user' : 'environment';
    startCamera();
}

function stopCameraTracks() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(function (track) { track.stop(); });
        cameraStream = null;
    }
}

function closeCameraModal() {
    const modal = document.getElementById('camera-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    const video = document.getElementById('camera-stream');
    stopCameraTracks();
    if (video) video.srcObject = null;
}

function capturePhoto() {
    const video = document.getElementById('camera-stream');
    if (!video || !video.videoWidth) {
        toast('The camera is not ready yet.');
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const target = activeTarget;
    // JPEG, not PNG: a 4K photograph as PNG is tens of megabytes and would hit
    // the upload limit for no gain - photographs have no flat colour to keep.
    canvas.toBlob(function (blob) {
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
let activePointers = new Map();
let inkBounds = null;           // rough extent of drawn strokes, in sheet coords

function openDrawModal(target) {
    activeTarget = target || 'convert';
    const modal = document.getElementById('draw-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    if (!sheet) createSheet(SHEET_START_W, SHEET_START_H);
    // Wait for layout so the canvas can be sized to the space it actually has.
    requestAnimationFrame(function () {
        resizeView();
        render();
    });
}

function closeDrawModal() {
    const modal = document.getElementById('draw-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
    hideBrushCursor();
}

function createSheet(width, height) {
    sheet = document.createElement('canvas');
    sheet.width = width;
    sheet.height = height;
    sheetCtx = sheet.getContext('2d');
    // Paint the page white rather than leaving it transparent. A transparent
    // PNG loses its background when converted to greyscale, which made an
    // entire drawing read as solid ink to every OCR engine.
    sheetCtx.fillStyle = '#ffffff';
    sheetCtx.fillRect(0, 0, width, height);
    origin = { x: 0, y: 0 };
    inkBounds = null;
}

/* Grow the sheet, keeping everything already on it. */
function growSheet(right, down) {
    const grown = document.createElement('canvas');
    grown.width = sheet.width + right;
    grown.height = sheet.height + down;
    const ctx = grown.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, grown.width, grown.height);
    ctx.drawImage(sheet, 0, 0);
    sheet = grown;
    sheetCtx = ctx;
    updateSizeLabel();
}

function resizeView() {
    view = document.getElementById('draw-canvas');
    if (!view) return;
    const wrap = document.getElementById('canvas-wrap');
    const ratio = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    view.style.width = width + 'px';
    view.style.height = height + 'px';
    view.width = Math.round(width * ratio);
    view.height = Math.round(height * ratio);
    viewCtx = view.getContext('2d');
    viewCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
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

function updateSizeLabel() {
    const label = document.getElementById('canvas-size');
    if (label && sheet) {
        label.textContent = sheet.width + ' × ' + sheet.height;
    }
}

function setTool(next) {
    tool = next;
    [['pen', 'tool-pen'], ['eraser', 'tool-eraser'], ['pan', 'tool-pan']]
        .forEach(function (pair) {
            const button = document.getElementById(pair[1]);
            if (!button) return;
            const active = (pair[0] === next);
            button.className = 'px-3 py-2 rounded text-sm '
                + (active ? 'bg-cream-100 text-forest-900 font-medium'
                          : 'bg-forest-600 text-cream-100');
        });
    const hint = document.getElementById('canvas-hint');
    if (hint) {
        hint.textContent = (next === 'pan')
            ? 'Drag to move around the sheet.'
            : 'Drag to write. Hold space, use the middle button, or two fingers to pan.';
    }
    updateBrushCursorStyle();
}

/* The cursor indicator: exactly the footprint the tool will affect. */
function updateBrushCursorStyle() {
    const cursor = document.getElementById('brush-cursor');
    if (!cursor) return;
    const diameter = Math.max(brushSize, 4);
    cursor.style.width = diameter + 'px';
    cursor.style.height = diameter + 'px';
    cursor.style.marginLeft = (-diameter / 2) + 'px';
    cursor.style.marginTop = (-diameter / 2) + 'px';
    if (tool === 'eraser') {
        cursor.style.borderColor = '#BF5C72';
        cursor.style.background = 'rgba(255,255,255,0.35)';
    } else {
        cursor.style.borderColor = '#2B4C3F';
        cursor.style.background = 'rgba(43,76,63,0.15)';
    }
    cursor.classList.toggle('hidden', tool === 'pan');
}

function moveBrushCursor(x, y) {
    const cursor = document.getElementById('brush-cursor');
    if (!cursor || tool === 'pan') return;
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    cursor.classList.remove('hidden');
}

function hideBrushCursor() {
    const cursor = document.getElementById('brush-cursor');
    if (cursor) cursor.classList.add('hidden');
}

function pointInView(event) {
    const rect = view.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function toSheet(point) {
    return { x: point.x + origin.x, y: point.y + origin.y };
}

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
    const settings = function (ctx) {
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
    let right = 0, down = 0;
    if (point.x > sheet.width - EDGE_MARGIN) right = SHEET_GROW;
    if (point.y > sheet.height - EDGE_MARGIN) down = SHEET_GROW;
    if (right || down) growSheet(right, down);
}

/* Scroll the window when the pointer nears its edge, so a stroke can run past
   the visible area without the user stopping to pan. */
function maybeAutoPan(point) {
    const size = viewSize();
    let dx = 0, dy = 0;
    if (point.x > size.w - AUTOPAN_MARGIN) dx = point.x - (size.w - AUTOPAN_MARGIN);
    if (point.x < AUTOPAN_MARGIN) dx = point.x - AUTOPAN_MARGIN;
    if (point.y > size.h - AUTOPAN_MARGIN) dy = point.y - (size.h - AUTOPAN_MARGIN);
    if (point.y < AUTOPAN_MARGIN) dy = point.y - AUTOPAN_MARGIN;
    if (!dx && !dy) return false;

    origin.x += dx * 0.35;
    origin.y += dy * 0.35;
    clampOrigin();
    render();
    return true;
}

function setupCanvas() {
    const canvas = document.getElementById('draw-canvas');
    if (!canvas) return;
    view = canvas;

    canvas.addEventListener('pointerdown', function (event) {
        canvas.setPointerCapture(event.pointerId);
        activePointers.set(event.pointerId, pointInView(event));

        const wantsPan = tool === 'pan' || spaceHeld || event.button === 1
            || activePointers.size > 1;
        if (wantsPan) {
            drawing = false;
            panning = true;
            panStart = { point: pointInView(event),
                         origin: { x: origin.x, y: origin.y } };
            return;
        }
        drawing = true;
        last = toSheet(pointInView(event));
        maybeGrow(last);
        // A tap with no movement should still leave a mark.
        strokeSegment(last, { x: last.x + 0.01, y: last.y });
    });

    canvas.addEventListener('pointermove', function (event) {
        const point = pointInView(event);
        moveBrushCursor(point.x, point.y);
        if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, point);

        if (panning && panStart) {
            origin.x = panStart.origin.x - (point.x - panStart.point.x);
            origin.y = panStart.origin.y - (point.y - panStart.point.y);
            clampOrigin();
            render();
            return;
        }
        if (!drawing) return;

        const scrolled = maybeAutoPan(point);
        const here = toSheet(point);
        maybeGrow(here);
        strokeSegment(last, here);
        last = here;
        if (scrolled) render();
    });

    ['pointerup', 'pointercancel'].forEach(function (name) {
        canvas.addEventListener(name, function (event) {
            activePointers.delete(event.pointerId);
            if (activePointers.size === 0) { drawing = false; panning = false; panStart = null; }
        });
    });

    canvas.addEventListener('pointerleave', function () { hideBrushCursor(); });
    canvas.addEventListener('pointerenter', function () { updateBrushCursorStyle(); });

    document.addEventListener('keydown', function (event) {
        if (event.code === 'Space') spaceHeld = true;
        if (event.key === 'Escape') { closeLegal(); closeDrawModal(); closeCameraModal(); }
    });
    document.addEventListener('keyup', function (event) {
        if (event.code === 'Space') spaceHeld = false;
    });

    const slider = document.getElementById('brush-size');
    if (slider) {
        slider.addEventListener('input', function () {
            brushSize = parseInt(slider.value, 10) || 1;
            setText('size-label', 'Size ' + brushSize);
            updateBrushCursorStyle();
        });
    }

    window.addEventListener('resize', function () {
        const modal = document.getElementById('draw-modal');
        if (modal && !modal.classList.contains('hidden')) {
            resizeView();
            render();
        }
    });

    setTool('pen');
}

function clearCanvas() {
    if (!confirm('Clear everything you have written? This cannot be undone.')) {
        return;
    }
    createSheet(SHEET_START_W, SHEET_START_H);
    resizeView();
    render();
    toast('Canvas cleared.');
}

/* Find the true extent of the ink, so a mostly-empty sheet is not exported. */
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
    const data = sheetCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
    return { x: x0 + minX, y: y0 + minY,
             w: (maxX - minX) + 1, h: (maxY - minY) + 1 };
}

function saveDrawing() {
    if (!sheet) { toast('Nothing to save yet.'); return; }
    const ink = measureInk();
    if (!ink) {
        toast('The canvas is empty - write something first.');
        return;
    }

    // Export only the region that was actually written on, with a margin. A
    // 3000-pixel sheet that is 95% blank costs upload size and gives the OCR
    // engines a page of nothing to search through.
    const margin = 32;
    const out = document.createElement('canvas');
    out.width = Math.round(ink.w + margin * 2);
    out.height = Math.round(ink.h + margin * 2);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(sheet, ink.x, ink.y, ink.w, ink.h, margin, margin, ink.w, ink.h);

    const target = activeTarget;
    out.toBlob(function (blob) {
        if (!blob) { toast('Could not save that drawing.'); return; }
        attachBlob(target, 'draw', blob, 'drawing.png');
        showPreview(INPUT_TARGETS[target].drawPreview, out.toDataURL('image/png'));
        toast('Drawing ready to convert.');
    }, 'image/png');

    closeDrawModal();
}


/* ---------------------------------------------------------------------------
   7. Output: preview, copy, download
   --------------------------------------------------------------------------- */

/* Show the compiled document as page images.

   The preview is deliberately not a PDF. A browser never lets the page have
   one: Chromium routes an application/pdf response to its own viewer before
   script can read it - fetch() comes back empty - and a download manager
   extension takes it away from the page altogether. Either way the panel ends
   up blank while the server has done everything right.

   So the server rasterises the compiled document and this asks for two things
   a browser has no special handling for: a JSON page count, and images. The
   real PDF is still one click away, for anyone who wants the file itself.

   Keep PREVIEW_TIMEOUT_MS above LATEX_COMPILE_TIMEOUT in latex_tools.py, so a
   slow compile is given the chance to finish and explain itself. */
const PREVIEW_TIMEOUT_MS = 150000;

let previewTimer = null;

/* Reload preview has to actually re-request, and a cached error must never
   outlive the document it was about. */
function freshUrl(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
}

function loadPreview() {
    const panel = document.getElementById('preview-panel');
    if (!panel) return;
    const pages = document.getElementById('preview-pages');
    const loading = document.getElementById('preview-loading');
    const error = document.getElementById('preview-error');
    if (!pages) return;

    if (loading) loading.classList.remove('hidden');
    setText('preview-loading-text', 'Compiling your document…');
    if (error) error.classList.add('hidden');
    pages.classList.add('hidden');
    pages.innerHTML = '';

    fetchPages(panel.dataset.pagesUrl).then(function (outcome) {
        if (loading) loading.classList.add('hidden');
        if (!outcome.ok) {
            showPreviewError(outcome);
            return;
        }
        fillPages(pages, panel.dataset.pageUrl, outcome.pages);
        pages.classList.remove('hidden');
    });
}

/* Ask the server to render the document, and report how many pages it has.
   Resolves to {ok: true, pages: n} or {ok: false, reason, errors, missing}. */
function fetchPages(url) {
    const controller = ('AbortController' in window) ? new AbortController() : null;
    const state = { timedOut: false };
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
        state.timedOut = true;
        if (controller) controller.abort();
    }, PREVIEW_TIMEOUT_MS);

    return fetch(freshUrl(url), controller ? { signal: controller.signal } : undefined)
        .then(function (response) {
            return response.json().catch(function () { return {}; });
        })
        .then(function (data) {
            clearTimeout(previewTimer);
            if (data && data.ok && data.pages > 0) {
                return { ok: true, pages: data.pages };
            }
            return {
                ok: false,
                reason: (data && data.reason) || 'The document could not be rendered.',
                errors: (data && data.errors) || '',
                missing: (data && data.missing_packages) || []
            };
        })
        .catch(function () {
            clearTimeout(previewTimer);
            return {
                ok: false,
                reason: state.timedOut
                    ? 'This document was still rendering after '
                      + Math.round(PREVIEW_TIMEOUT_MS / 1000)
                      + ' seconds, so the preview was stopped.'
                    : 'The preview could not be reached. If the server was '
                      + 'restarted, reload the page; otherwise use Reload '
                      + 'preview to try again.',
                errors: '', missing: []
            };
        });
}

/* One image per page. Only the first is loaded eagerly: a long document should
   not pull down every page before the user has looked at the first one. */
function fillPages(container, pageUrl, total) {
    container.innerHTML = '';
    for (let number = 1; number <= total; number += 1) {
        const image = document.createElement('img');
        image.className = 'w-full bg-white shadow-sm border border-gray-300';
        image.alt = 'Page ' + number + ' of ' + total;
        image.loading = number === 1 ? 'eager' : 'lazy';
        image.src = pageUrl + (pageUrl.indexOf('?') === -1 ? '?' : '&')
                  + 'n=' + number;
        container.appendChild(image);
    }
}

function showPreviewError(outcome) {
    const error = document.getElementById('preview-error');
    if (!error) return;
    setText('preview-error-reason', outcome.reason);
    const detail = document.getElementById('preview-error-detail');
    if (detail) {
        let text = outcome.errors || '';
        if (outcome.missing && outcome.missing.length) {
            text += (text ? '\n\n' : '') + 'Missing packages: ' + outcome.missing.join(', ');
        }
        detail.textContent = text;
        detail.classList.toggle('hidden', !text);
    }
    error.classList.remove('hidden');
}

/* Open the compiled document in a new tab, in the browser's own PDF viewer.

   The obvious way - a link straight to the PDF - does not do it. The response
   already carries Content-Disposition: inline, so that is not what decides
   this: an application/pdf response simply never reaches the page. The browser
   routes it to its own machinery, and a download manager extension takes it
   and saves it to disk instead of showing it.

   So the bytes are fetched under a content type nothing claims, labelled as a
   PDF here, and handed to the tab as a blob. A blob never crosses the network,
   so there is nothing in the way to intercept it, and the viewer opens it as
   it would any other PDF.

   The plain link stays on the element as the fallback: if any of this is
   unavailable, the click goes through as an ordinary navigation. */
let openedPdfUrl = null;

function openPdf(link) {
    const source = link.getAttribute('data-document-url');
    if (!source || !window.fetch || !window.Blob) {
        return true;                      // let the plain link handle it
    }

    // Opened now, while the click is still being handled, so the browser does
    // not treat it as an unsolicited pop-up once the fetch resolves.
    const tab = window.open('', '_blank');
    if (!tab) return true;

    fetch(freshUrl(source))
        .then(function (response) {
            if (!response.ok) throw new Error('preview unavailable');
            return response.arrayBuffer();
        })
        .then(function (buffer) {
            if (!buffer || !buffer.byteLength) throw new Error('empty document');
            if (openedPdfUrl) URL.revokeObjectURL(openedPdfUrl);
            openedPdfUrl = URL.createObjectURL(
                new Blob([buffer], { type: 'application/pdf' }));
            tab.location = openedPdfUrl;
        })
        .catch(function () {
            // Whatever went wrong, the direct link is still better than a tab
            // left sitting empty.
            tab.location = link.href;
        });
    return false;
}

/* Copy any rendered LaTeX block to the clipboard. */
function copyTex(elementId, button) {
    const block = document.getElementById(elementId);
    if (!block) { return; }
    writeClipboard(block.textContent, button);
}

function writeClipboard(text, button) {
    const done = function () {
        toast('LaTeX copied to clipboard.');
        if (button) {
            const original = button.dataset.label || button.textContent;
            button.dataset.label = original;
            button.textContent = 'Copied';
            setTimeout(function () { button.textContent = original; }, 1600);
        }
    };
    const failed = function () { toast('Could not copy. Select the text and copy it manually.'); };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, failed);
        return;
    }
    // Clipboard API needs a secure context; this path covers plain http://.
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        ok ? done() : failed();
    } catch (e) {
        failed();
    }
}


/* ---------------------------------------------------------------------------
   8. History

   A saved conversion offers the same three actions as a fresh one. For a
   signed-in user the .tex comes back from the server; for a guest it is
   already in the browser, and its token gives the preview something to
   compile.
   --------------------------------------------------------------------------- */

function copyHistory(docId, button) {
    fetch('/history/' + encodeURIComponent(docId) + '/tex')
        .then(function (response) { return response.json(); })
        .then(function (data) {
            if (!data.ok) { toast('That item could not be read.'); return; }
            writeClipboard(data.tex, button);
            if (data.truncated) {
                toast('Copied - note this saved copy was truncated.');
            }
        })
        .catch(function () { toast('That item could not be read.'); });
}

function toggleHistoryPreview(docId, button) {
    const panel = document.getElementById('history-preview-' + docId);
    if (!panel) return;

    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        if (button) button.textContent = 'Preview PDF';
        return;
    }

    panel.classList.remove('hidden');
    if (button) button.textContent = 'Hide preview';
    showPagePreview(panel, panel.dataset.pagesUrl, panel.dataset.pageUrl);
}

/* Fill a panel with the compiled document, the same way the main preview does:
   a JSON page count, then one image per page. */
function showPagePreview(panel, pagesUrl, pageUrl) {
    panel.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'p-4 text-sm text-forest-600';
    note.textContent = 'Compiling…';
    panel.appendChild(note);

    fetchPages(pagesUrl).then(function (outcome) {
        panel.innerHTML = '';
        if (!outcome.ok) {
            const box = document.createElement('div');
            box.className = 'p-4 text-sm bg-red-50 text-red-800 text-left';
            const heading = document.createElement('p');
            heading.className = 'font-semibold mb-1';
            heading.textContent = 'The document could not be rendered';
            const reason = document.createElement('p');
            reason.textContent = outcome.reason;
            box.appendChild(heading);
            box.appendChild(reason);
            panel.appendChild(box);
            return;
        }
        const pages = document.createElement('div');
        pages.className = 'max-h-[60vh] overflow-y-auto bg-gray-100 p-3 space-y-3';
        panel.appendChild(pages);
        fillPages(pages, pageUrl, outcome.pages);
    });
}


/* ---------------------------------------------------------------------------
   Shared helpers
   --------------------------------------------------------------------------- */

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value || '';
}

let toastTimer = null;
function toast(message) {
    const element = document.getElementById('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        element.classList.add('hidden');
    }, 2600);
}

function toggleSidebar() {
    const sidebar = document.getElementById('mobile-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;

    if (sidebar.classList.contains('translate-x-full')) {
        sidebar.classList.remove('translate-x-full');
        overlay.classList.remove('hidden');
    } else {
        sidebar.classList.add('translate-x-full');
        overlay.classList.add('hidden');
    }
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

/* Drag and drop. Routes through chooseInput() so a dropped file also wins
   name="file" from the camera and draw inputs. */
function setupConvertDragDrop() {
    const dropArea = document.getElementById('convert-drop-area');
    const fileInput = document.getElementById('convert-file-upload');
    if (!dropArea || !fileInput) return;

    dropArea.addEventListener('click', function () { fileInput.click(); });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (name) {
        dropArea.addEventListener(name, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(function (name) {
        dropArea.addEventListener(name, function () {
            dropArea.classList.add('border-forest-700', 'bg-forest-100/50');
        }, false);
    });
    ['dragleave', 'drop'].forEach(function (name) {
        dropArea.addEventListener(name, function () {
            dropArea.classList.remove('border-forest-700', 'bg-forest-100/50');
        }, false);
    });

    dropArea.addEventListener('drop', function (e) {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const valid = pageData.acceptedExtensions || [];
        const extension = '.' + files[0].name.split('.').pop().toLowerCase();
        if (valid.length && valid.indexOf(extension) === -1) {
            toast('Unsupported file type. Accepted: ' + valid.join(', '));
            return;
        }
        const transfer = new DataTransfer();
        transfer.items.add(files[0]);
        fileInput.files = transfer.files;
        chooseInput('convert', 'file', files[0].name);
    }, false);
}


/* ---------------------------------------------------------------------------
   Start-up
   --------------------------------------------------------------------------- */

window.addEventListener('DOMContentLoaded', function () {
    setupTermsGate();
    setupAvailabilityGate();
    setupConvertDragDrop();
    setupCanvas();
    updateBrushCursorStyle();

    if (document.getElementById('preview-panel')) {
        loadPreview();
    }

    if (pageData.showConvertResult || pageData.hasConvertResult
            || pageData.hasConvertError) {
        setTimeout(function () {
            const section = document.getElementById('convert');
            if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    }
});


/* =======================================================================
   Guest session history
   -----------------------------------------------------------------------
   Guests get a temporary history held in sessionStorage:
     - it survives the Post/Redirect/Get hop after a conversion,
     - it is wiped on a page refresh or a fresh visit,
     - the browser drops it entirely when the tab closes.
   Signed-in users never use this path; their history comes from Firestore,
   rendered server-side.

   Each entry keeps the result's token as well as its text, so Download and
   Preview work on it for as long as the server still holds the document.
   ======================================================================= */
(function () {
    var KEY = 'contex_guest_history';
    var MAX_ITEMS = 20;
    var data = window.pageData || {};

    function read() {
        try {
            return JSON.parse(sessionStorage.getItem(KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function write(items) {
        try {
            sessionStorage.setItem(KEY, JSON.stringify(items));
        } catch (e) {
            /* private mode / storage disabled - history is simply not kept */
        }
    }

    function clear() {
        try {
            sessionStorage.removeItem(KEY);
        } catch (e) { /* nothing to do */ }
    }

    // A signed-in user must never see leftovers from an earlier guest session
    // in the same tab.
    if (data.isAuthenticated) {
        clear();
        return;
    }

    window.addEventListener('DOMContentLoaded', function () {
        var list = document.getElementById('guest-history-list');
        var empty = document.getElementById('guest-history-empty');
        var clearBtn = document.getElementById('guest-history-clear');
        if (!list) { return; }

        // keepGuestHistory is true only on the redirect right after a
        // conversion. Anything else - F5, a typed URL, a fresh tab - starts
        // empty.
        var items = data.keepGuestHistory ? read() : [];
        if (!data.keepGuestHistory) { clear(); }

        if (data.latestEntry && data.latestEntry.result) {
            items.unshift({
                fileName: data.latestEntry.fileName,
                result: data.latestEntry.result,
                token: data.latestEntry.token || null,
                at: new Date().toLocaleString()
            });
            items = items.slice(0, MAX_ITEMS);
            write(items);
        }

        function render() {
            list.innerHTML = '';
            if (!items.length) {
                if (empty) { empty.classList.remove('hidden'); }
                if (clearBtn) { clearBtn.classList.add('hidden'); }
                return;
            }
            if (empty) { empty.classList.add('hidden'); }
            if (clearBtn) { clearBtn.classList.remove('hidden'); }

            items.forEach(function (item, index) {
                var li = document.createElement('li');
                li.className = 'border border-gray-300 rounded-lg p-3 bg-white';

                var head = document.createElement('div');
                head.className = 'flex items-center justify-between gap-2 flex-wrap';
                var name = document.createElement('span');
                name.className = 'text-sm text-forest-700 truncate font-medium';
                name.textContent = item.fileName || 'document';
                var when = document.createElement('span');
                when.className = 'text-xs text-forest-500';
                when.textContent = item.at || '';
                head.appendChild(name);
                head.appendChild(when);
                li.appendChild(head);

                var actions = document.createElement('div');
                actions.className = 'mt-2 flex flex-wrap gap-2';

                if (item.token) {
                    var download = document.createElement('a');
                    download.href = '/download-converted-tex?token='
                        + encodeURIComponent(item.token);
                    download.innerHTML = '<button type="button" class="bg-forest-800 '
                        + 'px-3 py-1.5 rounded text-cream-100 text-sm '
                        + 'hover:bg-forest-700 transition-colors">Download .tex</button>';
                    actions.appendChild(download);
                }

                var copy = document.createElement('button');
                copy.type = 'button';
                copy.className = 'bg-forest-800 px-3 py-1.5 rounded text-cream-100 '
                    + 'text-sm hover:bg-forest-700 transition-colors';
                copy.textContent = 'Copy LaTeX';
                copy.addEventListener('click', function () {
                    writeClipboard(item.result, copy);
                });
                actions.appendChild(copy);

                var previewId = 'guest-preview-' + index;
                if (item.token) {
                    var preview = document.createElement('button');
                    preview.type = 'button';
                    preview.className = 'bg-cream-100 border border-forest-600 px-3 '
                        + 'py-1.5 rounded text-forest-800 text-sm hover:bg-forest-100 '
                        + 'transition-colors';
                    preview.textContent = 'Preview PDF';
                    preview.addEventListener('click', function () {
                        var panel = document.getElementById(previewId);
                        if (!panel) return;
                        if (!panel.classList.contains('hidden')) {
                            panel.classList.add('hidden');
                            panel.innerHTML = '';
                            preview.textContent = 'Preview PDF';
                            return;
                        }
                        panel.classList.remove('hidden');
                        preview.textContent = 'Hide preview';
                        var token = encodeURIComponent(item.token);
                        showPagePreview(panel,
                                        '/preview/pages?token=' + token,
                                        '/preview/page.png?token=' + token);
                    });
                    actions.appendChild(preview);

                    var open = document.createElement('a');
                    open.href = '/preview.pdf?token=' + encodeURIComponent(item.token);
                    open.setAttribute(
                        'data-document-url',
                        '/preview/document?token=' + encodeURIComponent(item.token));
                    open.addEventListener('click', function (event) {
                        if (openPdf(open) === false) event.preventDefault();
                    });
                    open.target = '_blank';
                    open.rel = 'noopener';
                    open.innerHTML = '<button type="button" class="bg-cream-100 '
                        + 'border border-forest-600 px-3 py-1.5 rounded '
                        + 'text-forest-800 text-sm hover:bg-forest-100 '
                        + 'transition-colors">Open PDF in new tab</button>';
                    actions.appendChild(open);
                }
                li.appendChild(actions);

                var panel = document.createElement('div');
                panel.id = previewId;
                panel.className = 'hidden mt-3 border border-gray-300 rounded overflow-hidden';
                li.appendChild(panel);

                var source = document.createElement('details');
                source.className = 'mt-2';
                var summary = document.createElement('summary');
                summary.className = 'cursor-pointer text-xs text-forest-700';
                summary.textContent = 'LaTeX source';
                var pre = document.createElement('pre');
                pre.className = 'mt-2 bg-forest-100 p-3 rounded text-xs '
                    + 'whitespace-pre-wrap font-mono max-h-40 overflow-y-auto';
                pre.textContent = item.result;
                source.appendChild(summary);
                source.appendChild(pre);
                li.appendChild(source);

                list.appendChild(li);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                items = [];
                clear();
                render();
            });
        }

        render();
    });
})();
