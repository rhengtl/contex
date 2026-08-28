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
     8. History              the same three actions on a past conversion
     9. Dialogs              one implementation, so no two can behave
                             differently from one another
    10. Chrome               mobile navigation, toasts, drag and drop
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
    if (display) display.classList.replace('hidden', 'flex');

    revealSubmit();
}

/* On a phone the Convert button sits below the fold while the input controls
   are on screen, so choosing a file leaves the next step out of sight. Only
   scrolls when it actually is out of sight, and only as far as it has to. */
function revealSubmit() {
    const button = document.getElementById('convert-submit');
    if (!button) return;
    const box = button.getBoundingClientRect();
    if (box.bottom <= window.innerHeight - 8) return;
    button.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function hidePreview(id) {
    const preview = id && document.getElementById(id);
    if (preview) {
        // removeAttribute, not src = ''. An empty src resolves to the
        // current page, so clearing a preview that way makes the browser
        // fetch the whole document again in order to fail to decode it.
        preview.removeAttribute('src');
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
    if (display) display.classList.replace('flex', 'hidden');
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
    controls.classList.toggle('opacity-40', locked);
    controls.classList.toggle('pointer-events-none', locked);
}


/* ---------------------------------------------------------------------------
   9. Dialogs

   Every dialog in the application goes through these, so they can no longer
   differ from one another. Each one previously opened itself by removing
   .hidden and assigning style.display directly, and not one of them could be
   closed with Escape, kept focus inside itself, or gave focus back to whatever
   had opened it.
   --------------------------------------------------------------------------- */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openDialogs = [];

function openDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog) return null;
    if (openDialogs.some(function (entry) { return entry.dialog === dialog; })) {
        return dialog;
    }

    openDialogs.push({ dialog: dialog, restoreTo: document.activeElement });

    dialog.classList.remove('hidden');
    // .dialog centres itself through .is-open; the full-bleed camera and
    // canvas surfaces are laid out by their own utilities and only need the
    // display switched on.
    dialog.classList.add(dialog.classList.contains('dialog') ? 'is-open' : 'flex');

    // The page behind must not scroll while something is over it.
    document.documentElement.style.overflow = 'hidden';

    const first = dialog.querySelector('[data-dialog-initial]')
        || dialog.querySelector(FOCUSABLE);
    if (first) {
        // After the class change, so the element is actually visible by the
        // time it is asked to take focus.
        requestAnimationFrame(function () { first.focus(); });
    }
    return dialog;
}

function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    const index = openDialogs.findIndex(function (entry) {
        return entry.dialog === dialog;
    });
    const entry = index >= 0 ? openDialogs.splice(index, 1)[0] : null;

    dialog.classList.remove('is-open', 'flex');
    dialog.classList.add('hidden');

    if (!openDialogs.length) {
        document.documentElement.style.overflow = '';
    }
    if (entry && entry.restoreTo && entry.restoreTo.focus) {
        entry.restoreTo.focus();
    }
}

function topDialog() {
    return openDialogs.length ? openDialogs[openDialogs.length - 1] : null;
}

/* Ask before doing something that cannot be undone.

   Replaces window.confirm(), which was the one dialog in this application that
   looked and behaved like none of the others. */
let confirmHandler = null;

function confirmAction(title, body, label, onConfirm) {
    const accept = document.getElementById('confirm-accept');
    const cancel = document.getElementById('confirm-cancel');
    if (!accept || !cancel) {
        // No dialog on this page: do not silently swallow the action.
        onConfirm();
        return;
    }
    setText('confirm-title', title);
    setText('confirm-body', body);
    accept.textContent = label;
    confirmHandler = onConfirm;
    openDialog('confirm-modal');
}

function resolveConfirm(accepted) {
    const handler = confirmHandler;
    confirmHandler = null;
    closeDialog('confirm-modal');
    if (accepted && handler) handler();
}

/* Escape and a backdrop click both mean "close", but what closing means
   differs: dismissing the outage dialog has to record that the conversion was
   cancelled, not just hide the box. */
function dismissDialog(id) {
    if (id === 'confirm-modal') { resolveConfirm(false); return; }
    if (id === 'legal-modal') { closeLegal(); return; }
    if (id === 'ai-modal') { cancelConversion(); return; }
    if (id === 'camera-modal') { closeCameraModal(); return; }
    if (id === 'draw-modal') { closeDrawModal(); return; }
    closeDialog(id);
}

document.addEventListener('keydown', function (event) {
    const top = topDialog();

    if (event.key === 'Escape') {
        if (top) {
            event.preventDefault();
            dismissDialog(top.dialog.id);
        } else if (isSidebarOpen()) {
            event.preventDefault();
            toggleSidebar();
        }
        return;
    }

    if (event.key !== 'Tab' || !top) return;

    // Keep focus inside the dialog. Without this, tabbing walks straight out
    // into the page behind it, which is still there and still full of
    // controls the reader cannot see.
    const items = Array.prototype.filter.call(
        top.dialog.querySelectorAll(FOCUSABLE),
        function (element) { return element.offsetParent !== null; });
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

/* A click on the backdrop itself - not on the panel sitting on it. */
document.addEventListener('click', function (event) {
    const target = event.target;
    if (!target.classList || !target.classList.contains('dialog')) return;
    const top = topDialog();
    if (top && top.dialog === target) dismissDialog(target.id);
});


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
    openDialog('legal-modal');

    if (legalCache[which]) {
        body.innerHTML = legalCache[which];
        return;
    }
    body.innerHTML = '<p class="text-sm text-ink-500">Loading&hellip;</p>';

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
            body.innerHTML = '<div class="note-alarm"><p class="note-title">'
                + 'This document could not be loaded</p><p>Please check your '
                + 'connection and try again.</p></div>';
        });
}

function closeLegal() {
    closeDialog('legal-modal');
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
                    startConversion('Converting your document');
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

    openDialog('ai-modal');
}

function hideAiModal() {
    closeDialog('ai-modal');
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
                toast('AI conversion is available again.');
                startConversion('Converting your document');
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
    // Named for what it is. Someone who agreed to the lower-quality path
    // should be able to see, while they wait, that that is what is running.
    startConversion('Converting without AI',
                    'The AI service is unavailable, so this is being converted '
                    + 'on the server. Quality will be lower.');
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
   The processing screen

   A conversion runs inside an ordinary form POST that can take anything from
   ten seconds to several minutes. Before this existed, the submit button
   relabelled itself and the browser then sat on a motionless page for the
   whole of that time, on the one action the application is for.

   There is no progress bar here on purpose. The server does not report how far
   through a document it is, so a bar drawn on this screen would be measuring
   nothing at all. Everything shown instead is true: which file is being read,
   how long it has actually been running, and an honest range for how long that
   usually takes.

   The browser keeps painting the current document until the response to the
   POST arrives, so this stays up for exactly as long as the conversion does
   and is then replaced by the result.
   --------------------------------------------------------------------------- */

let processingTimer = null;
let processingStartedAt = 0;

/* Said once, when the elapsed time has passed the point where the honest
   expectation set at the start no longer covers it. */
const PROCESSING_LONG_MS = 120000;
const PROCESSING_LONG_NOTE =
    'Still working. Long or dense documents take longer, and the conversion '
    + 'is not lost - please keep this tab open.';

function chosenFileName() {
    const group = INPUT_TARGETS.convert;
    const kinds = ['file', 'camera', 'draw'];
    for (let i = 0; i < kinds.length; i += 1) {
        const element = document.getElementById(group[kinds[i]]);
        if (element && element.getAttribute('name') === 'file'
                && element.files && element.files.length) {
            return element.files[0].name;
        }
    }
    return '';
}

function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function showProcessing(detail) {
    const screen = document.getElementById('processing');
    if (!screen) return;

    setText('processing-detail', detail);

    processingStartedAt = Date.now();
    setText('processing-elapsed', '0:00');
    clearInterval(processingTimer);
    processingTimer = setInterval(function () {
        const elapsed = Date.now() - processingStartedAt;
        setText('processing-elapsed', formatElapsed(elapsed));
        if (elapsed >= PROCESSING_LONG_MS) {
            const note = document.getElementById('processing-note');
            if (note && note.textContent !== PROCESSING_LONG_NOTE) {
                note.textContent = PROCESSING_LONG_NOTE;
            }
        }
    }, 1000);

    screen.classList.remove('hidden');
    screen.classList.add('flex');
    document.documentElement.style.overflow = 'hidden';
}

function hideProcessing() {
    const screen = document.getElementById('processing');
    clearInterval(processingTimer);
    processingTimer = null;
    if (!screen) return;
    screen.classList.add('hidden');
    screen.classList.remove('flex');
    if (!openDialogs.length) document.documentElement.style.overflow = '';
}

/* Submit for real, with the screen up. */
function startConversion(headline, detail) {
    const form = document.getElementById('convert-form');
    if (!form) return;
    pendingSubmit = true;
    if (headline) setText('processing-title', headline);
    showProcessing(detail || describeConversion());
    form.submit();
}

function describeConversion() {
    const name = chosenFileName();
    return name
        ? 'Reading ' + name + ' and writing the LaTeX for it.'
        : 'Reading your page and writing the LaTeX for it.';
}

/* Coming back to this page through the browser's history restores it from the
   back/forward cache exactly as it was left - which, right after a conversion
   was started, is with the processing screen up over a page that is no longer
   doing anything. */
window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    pendingSubmit = false;
    hideProcessing();
    setSubmitting(false);
});


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
    if (!document.getElementById('camera-modal')) return;
    openDialog('camera-modal');
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
                error.textContent = 'Could not use the camera: ' + err.message
                    + '. Check that this page has camera permission, then try '
                    + 'again - or write the page by hand instead.';
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
    closeDialog('camera-modal');
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
    if (!document.getElementById('draw-modal')) return;
    openDialog('draw-modal');

    if (!sheet) createSheet(SHEET_START_W, SHEET_START_H);
    // Wait for layout so the canvas can be sized to the space it actually has.
    requestAnimationFrame(function () {
        resizeView();
        render();
    });
}

function closeDrawModal() {
    closeDialog('draw-modal');
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

/* Panning used to repaint the whole sheet once per pointer event. A pen or a
   trackpad reports far more often than the screen refreshes, so most of those
   repaints were overwritten before anyone saw them. This collapses them to one
   per frame, which is all a display can show anyway. */
let renderQueued = false;

function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
        renderQueued = false;
        render();
    });
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
            // Component classes, so the toolbar cannot drift away from every
            // other control in the application. Written as whole literal
            // strings because that is what Tailwind's scanner reads.
            button.className = active ? 'toolbtn-active' : 'toolbtn';
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
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
        // burgundy-400 and paper, against the ink-900 canvas surround.
        cursor.style.borderColor = '#BF5C72';
        cursor.style.background = 'rgba(251,250,248,0.32)';
    } else {
        cursor.style.borderColor = '#FBFAF8';
        cursor.style.background = 'rgba(251,250,248,0.18)';
    }
    cursor.classList.toggle('hidden', tool === 'pan');
}

/* Moved with a transform rather than left/top: a transform is handled by the
   compositor and does not invalidate layout, so following the pen costs the
   main thread nothing. */
function moveBrushCursor(x, y) {
    const cursor = document.getElementById('brush-cursor');
    if (!cursor || tool === 'pan') return;
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    cursor.classList.remove('hidden');
}

function hideBrushCursor() {
    const cursor = document.getElementById('brush-cursor');
    if (cursor) cursor.classList.add('hidden');
}

/* The canvas's position on screen, remembered between pointer events.

   getBoundingClientRect() forces the browser to settle pending layout before
   it can answer. Calling it inside pointermove - which also writes to the
   brush cursor's style - made every single move event a forced synchronous
   layout, on the one code path that has to keep up with a pen. The rect only
   changes when the window or the modal does, so it is recomputed there. */
let viewRect = null;

function refreshViewRect() {
    viewRect = view ? view.getBoundingClientRect() : null;
}

function pointInView(event) {
    if (!viewRect) refreshViewRect();
    const rect = viewRect || { left: 0, top: 0 };
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
    requestRender();
    return true;
}

function setupCanvas() {
    const canvas = document.getElementById('draw-canvas');
    if (!canvas) return;
    view = canvas;

    canvas.addEventListener('pointerdown', function (event) {
        canvas.setPointerCapture(event.pointerId);
        // Once per stroke rather than once per move: cheap here, and it means
        // the cached rect cannot go stale if anything moved the canvas without
        // a resize event.
        refreshViewRect();
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
            requestRender();
            return;
        }
        if (!drawing) return;

        const scrolled = maybeAutoPan(point);

        // Every position the pen reported since the last event, not just the
        // one the browser chose to deliver. A fast stroke can cover several
        // hundred pixels between frames; drawing only the endpoints turns a
        // curve into a chord. This is finer input, not coarser - the stroke
        // the model reads is closer to what was written.
        const moves = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
        const points = (moves && moves.length) ? moves.map(pointInView) : [point];
        for (let i = 0; i < points.length; i += 1) {
            const here = toSheet(points[i]);
            maybeGrow(here);
            strokeSegment(last, here);
            last = here;
        }
        if (scrolled) requestRender();
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
    confirmAction(
        'Clear the canvas?',
        'Everything you have written will be thrown away. This cannot be undone.',
        'Clear everything',
        function () {
            createSheet(SHEET_START_W, SHEET_START_H);
            resizeView();
            render();
            toast('Canvas cleared.');
        });
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
        // The same bytes the blob already holds, rather than encoding the
        // canvas to PNG a second time and base64-ing the result. showPreview
        // revokes the URL when the preview is replaced.
        showPreview(INPUT_TARGETS[target].drawPreview, URL.createObjectURL(blob));
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
        image.className = 'pagesheet';
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
    note.className = 'p-4 text-sm text-ink-500';
    note.textContent = 'Compiling…';
    panel.appendChild(note);

    fetchPages(pagesUrl).then(function (outcome) {
        panel.innerHTML = '';
        if (!outcome.ok) {
            const box = document.createElement('div');
            box.className = 'note-alarm m-3';
            const heading = document.createElement('p');
            heading.className = 'note-title';
            heading.textContent = 'The document could not be rendered';
            const reason = document.createElement('p');
            reason.textContent = outcome.reason;
            box.appendChild(heading);
            box.appendChild(reason);
            panel.appendChild(box);
            return;
        }
        const pages = document.createElement('div');
        pages.className = 'pagestack max-h-[60vh]';
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
    const text = document.getElementById('toast-text');
    if (!element || !text) return;
    text.textContent = message;
    element.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        element.classList.add('hidden');
    }, 2600);
}


/* ---------------------------------------------------------------------------
   10. Chrome
   --------------------------------------------------------------------------- */

function isSidebarOpen() {
    const sidebar = document.getElementById('mobile-sidebar');
    return !!sidebar && !sidebar.classList.contains('translate-x-full');
}

function toggleSidebar() {
    const sidebar = document.getElementById('mobile-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const button = document.getElementById('menu-button');
    if (!sidebar || !overlay) return;

    const willOpen = !isSidebarOpen();
    sidebar.classList.toggle('translate-x-full', !willOpen);
    overlay.classList.toggle('hidden', !willOpen);
    document.documentElement.style.overflow = willOpen ? 'hidden' : '';
    if (button) button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');

    if (willOpen) {
        const first = sidebar.querySelector(FOCUSABLE);
        if (first) requestAnimationFrame(function () { first.focus(); });
    } else if (button) {
        // Give the keyboard back to the control that opened it, rather than
        // dropping focus to the top of the document.
        button.focus();
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

    // No click handler: the drop area is a <label> for the file input, so the
    // browser opens the picker itself. Adding one here would open it twice.

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (name) {
        dropArea.addEventListener(name, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(function (name) {
        dropArea.addEventListener(name, function () {
            dropArea.classList.add('is-dragging');
        }, false);
    });
    ['dragleave', 'drop'].forEach(function (name) {
        dropArea.addEventListener(name, function () {
            dropArea.classList.remove('is-dragging');
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
    const accept = document.getElementById('confirm-accept');
    const cancel = document.getElementById('confirm-cancel');
    if (accept) accept.addEventListener('click', function () { resolveConfirm(true); });
    if (cancel) cancel.addEventListener('click', function () { resolveConfirm(false); });

    setupTermsGate();
    setupAvailabilityGate();
    setupConvertDragDrop();
    setupCanvas();
    updateBrushCursorStyle();

    if (document.getElementById('preview-panel')) {
        loadPreview();
    }

    // The workspace no longer scrolls itself anywhere. The result and the
    // error both render at the top of the page now, in the place the input
    // panel occupied, so there is nothing to scroll to. Moving focus is still
    // worth doing: it puts a screen reader and a keyboard on what actually
    // changed instead of back at the top of the document.
    if (pageData.hasConvertResult || pageData.hasConvertError) {
        const main = document.getElementById('main');
        if (main) main.focus();
    }
});


/* =======================================================================
   Guest session history
   -----------------------------------------------------------------------
   Guests get a temporary history held in sessionStorage:
     - it survives the Post/Redirect/Get hop after a conversion,
     - it is wiped when the page is refreshed,
     - the browser drops it entirely when the tab closes.
   Signed-in users never use this path; their history comes from Firestore,
   rendered server-side.

   It now spans two routes: entries are WRITTEN on the workspace, where a
   conversion lands, and RENDERED on /history. So "should this be kept?" can
   no longer be answered by "is this the page that just converted something",
   the way it was when both jobs happened on the same page - moving between
   the two would have thrown the list away every time.

   What the Privacy Policy promises a guest is that results are cleared when
   they refresh or close the tab. That is now implemented literally, by asking
   the browser what kind of navigation this was, rather than approximated by
   clearing on every load that was not the redirect after a conversion. A
   refresh still wipes it; walking between Convert and History no longer does.

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

    /* The same shape the server renders a saved conversion with - '%d %b %Y,
       %H:%M' in app.py - so the two kinds of history entry do not disagree
       about what a date looks like. */
    function formatWhen(value) {
        if (!value) return '';
        var when = new Date(value);
        if (isNaN(when.getTime())) return value;   // an entry from before this
        try {
            return when.toLocaleString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
        } catch (e) {
            return when.toISOString().slice(0, 16).replace('T', ' ');
        }
    }

    /* True only for an actual reload - F5, the reload button, location.reload.
       An ordinary link, a typed URL and the back button all report their own
       navigation types and are not this. */
    function isReload() {
        try {
            var entries = performance.getEntriesByType('navigation');
            if (entries && entries.length) return entries[0].type === 'reload';
            /* The old interface, for browsers without the Level 2 timeline. */
            return !!(performance.navigation
                      && performance.navigation.type === 1);
        } catch (e) {
            return false;
        }
    }

    // A signed-in user must never see leftovers from an earlier guest session
    // in the same tab.
    if (data.isAuthenticated) {
        clear();
        return;
    }

    // keepGuestHistory is true on the redirect right after a conversion, which
    // must never be treated as a refresh even though the browser has just
    // loaded the page again.
    if (!data.keepGuestHistory && isReload()) {
        clear();
    }

    var items = read();

    // The workspace writes; /history only reads.
    if (data.latestEntry && data.latestEntry.result) {
        items.unshift({
            fileName: data.latestEntry.fileName,
            result: data.latestEntry.result,
            token: data.latestEntry.token || null,
            at: new Date().toISOString()
        });
        items = items.slice(0, MAX_ITEMS);
        write(items);
    }

    window.addEventListener('DOMContentLoaded', function () {
        var list = document.getElementById('guest-history-list');
        var empty = document.getElementById('guest-history-empty');
        var clearBtn = document.getElementById('guest-history-clear');
        if (!list) { return; }

        function action(label, className, onClick) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = label;
            button.addEventListener('click', onClick);
            return button;
        }

        function render() {
            list.innerHTML = '';
            var any = items.length > 0;
            list.classList.toggle('hidden', !any);
            if (empty) { empty.classList.toggle('hidden', any); }
            if (clearBtn) { clearBtn.classList.toggle('hidden', !any); }
            if (!any) { return; }

            items.forEach(function (item, index) {
                var li = document.createElement('li');
                li.className = 'p-4 sm:p-5';

                var head = document.createElement('div');
                head.className = 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1';
                var name = document.createElement('h2');
                name.className = 'min-w-0 flex-1 truncate font-poppins text-[0.9375rem] font-medium text-ink-900';
                name.textContent = item.fileName || 'document';
                var when = document.createElement('time');
                when.className = 'flex-shrink-0 text-xs tabular-nums text-ink-400';
                when.dateTime = item.at || '';
                when.textContent = formatWhen(item.at);
                head.appendChild(name);
                head.appendChild(when);
                li.appendChild(head);

                var actions = document.createElement('div');
                actions.className = 'mt-3 flex flex-wrap gap-2';

                if (item.token) {
                    var download = document.createElement('a');
                    download.href = '/download-converted-tex?token='
                        + encodeURIComponent(item.token);
                    download.className = 'btn-secondary btn-sm';
                    download.textContent = 'Download .tex';
                    actions.appendChild(download);
                }

                actions.appendChild(action('Copy LaTeX', 'btn-secondary btn-sm',
                    function (event) {
                        writeClipboard(item.result, event.currentTarget);
                    }));

                var previewId = 'guest-preview-' + index;
                if (item.token) {
                    actions.appendChild(action('Preview PDF', 'btn-quiet btn-sm',
                        function (event) {
                            var button = event.currentTarget;
                            var panel = document.getElementById(previewId);
                            if (!panel) return;
                            if (!panel.classList.contains('hidden')) {
                                panel.classList.add('hidden');
                                panel.innerHTML = '';
                                button.textContent = 'Preview PDF';
                                return;
                            }
                            panel.classList.remove('hidden');
                            button.textContent = 'Hide preview';
                            var token = encodeURIComponent(item.token);
                            showPagePreview(panel,
                                            '/preview/pages?token=' + token,
                                            '/preview/page.png?token=' + token);
                        }));

                    var open = document.createElement('a');
                    open.href = '/preview.pdf?token=' + encodeURIComponent(item.token);
                    open.className = 'btn-quiet btn-sm';
                    open.setAttribute(
                        'data-document-url',
                        '/preview/document?token=' + encodeURIComponent(item.token));
                    open.addEventListener('click', function (event) {
                        if (openPdf(open) === false) event.preventDefault();
                    });
                    open.target = '_blank';
                    open.rel = 'noopener';
                    open.textContent = 'Open PDF in new tab';
                    actions.appendChild(open);
                }
                li.appendChild(actions);

                var panel = document.createElement('div');
                panel.id = previewId;
                panel.className = 'mt-3 hidden overflow-hidden rounded-md border border-paper-300';
                li.appendChild(panel);

                var source = document.createElement('details');
                source.className = 'disclosure mt-3';
                var summary = document.createElement('summary');
                summary.textContent = 'LaTeX source';
                var body = document.createElement('div');
                body.className = 'p-3';
                var pre = document.createElement('pre');
                pre.className = 'tex-source max-h-40';
                pre.textContent = item.result;
                body.appendChild(pre);
                source.appendChild(summary);
                source.appendChild(body);
                li.appendChild(source);

                list.appendChild(li);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                items = [];
                clear();
                render();
                toast('Session history cleared.');
            });
        }

        render();
    });
})();


/* ---------------------------------------------------------------------------
   Declarative actions
   ---------------------------------------------------------------------------

   Every control used to carry its behaviour in an onclick= attribute. That
   works, and it costs the whole Content-Security-Policy: an inline handler is
   inline script, so allowing them means script-src 'unsafe-inline', and
   'unsafe-inline' means an injected <img onerror=...> runs too. There is no
   nonce or hash that covers attribute handlers - only removing them does.

   So markup now says what a control IS, not what it runs:

       <button data-action="legal" data-arg="terms">Terms of Service</button>

   ONE delegated listener, not one per element, and that is not a
   micro-optimisation. The legal dialog fetches /legal/terms and drops the
   markup straight into the page, and that markup contains a control of its
   own - the Privacy Policy link inside the Terms. Anything bound at load
   would miss it. Delegation catches it because the listener is on the
   document, not on the button. The same goes for any control rendered later.

   A handler returning exactly false calls preventDefault(), which is how the
   two "open in a new tab" links keep their real href as the fallback when
   fetch or Blob is unavailable.
   --------------------------------------------------------------------------- */

var ACTIONS = {
    /* Navigation and the shell */
    'toggle-sidebar':   function ()          { toggleSidebar(); },

    /* Legal */
    'legal':            function (el)        { openLegal(el.dataset.arg); },
    'legal-close':      function ()          { closeLegal(); },

    /* Choosing what to convert */
    'camera-open':      function (el)        { openCameraModal(el.dataset.arg); },
    'camera-close':     function ()          { closeCameraModal(); },
    'camera-switch':    function ()          { switchCamera(); },
    'camera-capture':   function ()          { capturePhoto(); },
    'draw-open':        function (el)        { openDrawModal(el.dataset.arg); },
    'draw-close':       function ()          { closeDrawModal(); },
    'draw-tool':        function (el)        { setTool(el.dataset.arg); },
    'draw-clear':       function ()          { clearCanvas(); },
    'draw-save':        function ()          { saveDrawing(); },
    'file-clear':       function ()          { clearConvertFile(); },

    /* The AI-unavailable dialog */
    'ai-recheck':       function ()          { recheckAi(); },
    'ai-cancel':        function ()          { cancelConversion(); },
    'ai-fallback':      function ()          { continueWithFallback(); },

    /* The result */
    'copy-tex':         function (el)        { copyTex(el.dataset.arg, el); },
    'preview-load':     function ()          { loadPreview(); },
    'open-pdf':         function (el)        { return openPdf(el); },

    /* Saved history */
    'history-copy':     function (el)        { copyHistory(el.dataset.arg, el); },
    'history-preview':  function (el)        { toggleHistoryPreview(el.dataset.arg, el); }
};

var CHANGE_ACTIONS = {
    'choose-file': function (el) { chooseInput(el.dataset.arg, 'file'); }
};

function runAction(table, event) {
    var el = event.target.closest && event.target.closest('[data-action]');
    if (!el) { return; }
    var handler = table[el.getAttribute('data-action')];
    if (!handler) { return; }
    // Exactly false, not merely falsy: a handler that returns nothing is the
    // common case and must not cancel the event.
    if (handler(el, event) === false) { event.preventDefault(); }
}

document.addEventListener('click', function (event) {
    runAction(ACTIONS, event);
});

document.addEventListener('change', function (event) {
    runAction(CHANGE_ACTIONS, event);
});
