function displayFileName(input) {
    const fileNameDisplay = document.getElementById('file-name');
    const cameraPreview = document.getElementById('camera-preview');
    // Remove name from camera-upload, add to file-upload
    document.getElementById('camera-upload').removeAttribute('name');
    input.setAttribute('name', 'file');
    if (cameraPreview) {
        cameraPreview.src = '';
        cameraPreview.style.display = 'none';
    }
    if (input.files && input.files.length > 0) {
        fileNameDisplay.textContent = input.files[0].name;
    } else {
        fileNameDisplay.textContent = 'No file chosen';
    }
}

let cameraStream = null;

function openCameraModal() {
    const modal = document.getElementById('camera-modal');
    modal.style.display = 'flex';
    const video = document.getElementById('camera-stream');
    navigator.mediaDevices.getUserMedia({ video: true })
        .then(function(stream) {
            cameraStream = stream;
            video.srcObject = stream;
        })
        .catch(function(err) {
            alert('Could not access camera: ' + err);
            closeCameraModal();
        });
}

function closeCameraModal() {
    const modal = document.getElementById('camera-modal');
    modal.style.display = 'none';
    const video = document.getElementById('camera-stream');
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    video.srcObject = null;
}

function capturePhoto() {
    const video = document.getElementById('camera-stream');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function(blob) {
        // Show preview
        const preview = document.getElementById('camera-preview');
        preview.src = URL.createObjectURL(blob);
        preview.style.display = 'block';
        // Set the blob as the file input value for form submission
        const fileInput = document.getElementById('camera-upload');
        const file = new File([blob], "captured_photo.png", { type: "image/png" });
        // Use DataTransfer to set file input
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        // Remove name from file-upload, add to camera-upload
        document.getElementById('file-upload').removeAttribute('name');
        fileInput.setAttribute('name', 'file');
    }, 'image/png');
    closeCameraModal();
}

// Drawing modal logic
let isDrawing = false;
let lastX = 0;
let lastY = 0;

function openDrawModal() {
    document.getElementById('draw-modal').style.display = 'flex';
    const canvas = document.getElementById('draw-canvas');
    const ctx = canvas.getContext('2d');
    
    // Set responsive canvas size based on viewport and orientation
    const isLandscape = window.innerWidth > window.innerHeight;
    const maxWidth = Math.min(window.innerWidth * 0.85, 1000);
    const maxHeight = isLandscape 
        ? Math.min(window.innerHeight * 0.7, 500)  // More height for landscape
        : Math.min(window.innerHeight * 0.6, 500);
    
    canvas.width = maxWidth;
    canvas.height = maxHeight;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function closeDrawModal() {
    document.getElementById('draw-modal').style.display = 'none';
}

function clearCanvas() {
    const canvas = document.getElementById('draw-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function saveDrawing() {
    const canvas = document.getElementById('draw-canvas');
    const dataURL = canvas.toDataURL('image/png');
    // Show preview
    const preview = document.getElementById('draw-preview');
    preview.src = dataURL;
    preview.style.display = 'block';

    // Convert dataURL to Blob and set as file input
    fetch(dataURL)
        .then(res => res.blob())
        .then(blob => {
            const fileInput = document.getElementById('draw-upload');
            const file = new File([blob], "drawing.png", { type: "image/png" });
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            // Remove name from other file inputs, add to draw-upload
            document.getElementById('file-upload').removeAttribute('name');
            document.getElementById('camera-upload').removeAttribute('name');
            fileInput.setAttribute('name', 'file');
        });
    closeDrawModal();
}

// Drawing events
const setupDrawing = () => {
    const canvas = document.getElementById('draw-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Mouse events
    canvas.onmousedown = function(e) {
        isDrawing = true;
        [lastX, lastY] = [e.offsetX, e.offsetY];
    };
    canvas.onmouseup = function() {
        isDrawing = false;
    };
    canvas.onmouseout = function() {
        isDrawing = false;
    };
    canvas.onmousemove = function(e) {
        if (!isDrawing) return;
        ctx.strokeStyle = "#111827"; // Tailwind gray-900
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(e.offsetX, e.offsetY);
        ctx.stroke();
        [lastX, lastY] = [e.offsetX, e.offsetY];
    };

    // --- IMPROVED MOBILE TOUCH SUPPORT ---
    let isTouching = false;

    // Helper function to get correct touch position
    function getTouchPos(canvasDom, touchEvent) {
        var rect = canvasDom.getBoundingClientRect();
        return {
            x: (touchEvent.touches[0].clientX - rect.left) * (canvasDom.width / rect.width),
            y: (touchEvent.touches[0].clientY - rect.top) * (canvasDom.height / rect.height)
        };
    }

    // Touch Start
    canvas.addEventListener("touchstart", function (e) {
        if (e.target == canvas) {
            e.preventDefault(); // Prevent scrolling
        }
        var mousePos = getTouchPos(canvas, e);
        var touch = e.touches[0];
        
        // Dispatch mouse event for compatibility
        var mouseEvent = new MouseEvent("mousedown", {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
        
        // Manual drawing fallback
        isTouching = true;
        lastX = mousePos.x;
        lastY = mousePos.y;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
    }, { passive: false });

    // Touch Move
    canvas.addEventListener("touchmove", function (e) {
        if (e.target == canvas) {
            e.preventDefault(); // Prevent scrolling
        }
        var touch = e.touches[0];
        
        // Dispatch mouse event
        var mouseEvent = new MouseEvent("mousemove", {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);

        // Manual drawing fallback
        if (isTouching) {
            var pos = getTouchPos(canvas, e);
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 3;
            ctx.lineCap = "round";
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            lastX = pos.x;
            lastY = pos.y;
        }
    }, { passive: false });

    // Touch End
    canvas.addEventListener("touchend", function (e) {
        var mouseEvent = new MouseEvent("mouseup", {});
        canvas.dispatchEvent(mouseEvent);
        isTouching = false;
    }, { passive: false });
};

window.addEventListener('DOMContentLoaded', setupDrawing);

// Auto-scroll to results when page loads with results
window.addEventListener('DOMContentLoaded', function() {
    console.log('Page loaded, checking for results...');
    console.log('Page data available:', window.pageData);
    
    // Use the flags passed from the template
    if (window.pageData) {
        if (window.pageData.showEquationResult || window.pageData.hasEquationResult) {
            console.log('Has equation result, scrolling to #equation');
            setTimeout(() => {
                const section = document.getElementById('equation');
                if (section) {
                    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
            return;
        }
        
        if (window.pageData.showTextractResult || window.pageData.hasTextractResult) {
            console.log('Has textract result, scrolling to #textract');
            setTimeout(() => {
                const section = document.getElementById('textract');
                if (section) {
                    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
            return;
        }
    }
    
    console.log('No results found');
});

// Textract Drag and Drop functionality
/* Both pipelines make an API call after the converter runs, so a submit can
   take some seconds. Show that rather than leaving a dead-looking button. */
function markBusy(form, button, label) {
    if (!form || !button) { return; }
    form.addEventListener('submit', function () {
        if (form.querySelector('input[type=file]') &&
            !form.querySelector('input[type=file][name=file]')) { return; }
        button.disabled = true;
        button.textContent = label;
        var notice = document.createElement('p');
        notice.className = 'mt-3 text-sm text-forest-700';
        notice.textContent = 'Converting, then checking the result against your document…';
        button.parentNode.appendChild(notice);
    });
}

window.addEventListener('DOMContentLoaded', function () {
    var textractForm = document.getElementById('textract-form');
    markBusy(textractForm, textractForm && textractForm.querySelector('button[type=submit]'),
             'Processing…');
    var equationForm = document.getElementById('equation-form');
    markBusy(equationForm, equationForm && equationForm.querySelector('button[type=submit]'),
             'Processing…');
});

function setupTextractDragDrop() {
    const dropArea = document.getElementById('textract-drop-area');
    const fileInput = document.getElementById('textract-file');
    const fileDisplay = document.getElementById('textract-file-display');
    const fileName = document.getElementById('textract-file-name');

    if (!dropArea || !fileInput) return;

    // Click to upload
    dropArea.addEventListener('click', () => {
        fileInput.click();
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleTextractFiles(e.target.files);
        }
    });

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    // Highlight drop area when dragging over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => {
            dropArea.classList.add('border-forest-700', 'bg-forest-100/50');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => {
            dropArea.classList.remove('border-forest-700', 'bg-forest-100/50');
        }, false);
    });

    // Handle dropped files
    dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleTextractFiles(files);
    }, false);

    function handleTextractFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            const validTypes = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.pdf'];
            const fileExt = '.' + file.name.split('.').pop().toLowerCase();
            
            if (validTypes.includes(fileExt)) {
                // Create a new DataTransfer to set the file
                const dt = new DataTransfer();
                dt.items.add(file);
                fileInput.files = dt.files;
                
                // Show file name
                fileName.textContent = file.name;
                fileDisplay.classList.remove('hidden');
            } else {
                alert('Please upload a valid file type: ' + validTypes.join(', '));
            }
        }
    }
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function clearTextractFile() {
    const fileInput = document.getElementById('textract-file');
    const fileDisplay = document.getElementById('textract-file-display');
    
    if (fileInput) {
        fileInput.value = '';
    }
    if (fileDisplay) {
        fileDisplay.classList.add('hidden');
    }
}

// Initialize textract drag and drop when DOM is loaded
window.addEventListener('DOMContentLoaded', setupTextractDragDrop);


/* Copy any rendered LaTeX block to the clipboard. */
function copyTex(elementId) {
    var block = document.getElementById(elementId);
    if (!block) { return; }
    navigator.clipboard.writeText(block.innerText).then(function () {
        alert('LaTeX source copied to clipboard!');
    }, function (err) {
        alert('Failed to copy: ' + err);
    });
}

function toggleSidebar() {
    const sidebar = document.getElementById('mobile-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    if (sidebar.classList.contains('translate-x-full')) {
        // Open sidebar
        sidebar.classList.remove('translate-x-full');
        overlay.classList.remove('hidden');
    } else {
        // Close sidebar
        sidebar.classList.add('translate-x-full');
        overlay.classList.add('hidden');
    }
}



/* =======================================================================
   Guest session history
   -----------------------------------------------------------------------
   Guests get a temporary history held in sessionStorage:
     - it survives the Post/Redirect/Get hop after an OCR run,
     - it is wiped on a page refresh or a fresh visit,
     - the browser drops it entirely when the tab closes.
   Signed-in users never use this path; their history comes from Firestore,
   rendered server-side.
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

    var list = document.getElementById('guest-history-list');
    var empty = document.getElementById('guest-history-empty');
    var clearBtn = document.getElementById('guest-history-clear');
    if (!list) { return; }

    // keepGuestHistory is true only on the redirect right after an OCR POST.
    // Anything else - F5, a typed URL, a fresh tab - starts empty.
    var items = data.keepGuestHistory ? read() : [];
    if (!data.keepGuestHistory) { clear(); }

    if (data.latestEntry && data.latestEntry.result) {
        items.unshift({
            ocrType: data.latestEntry.ocrType,
            fileName: data.latestEntry.fileName,
            result: data.latestEntry.result,
            at: new Date().toLocaleString()
        });
        items = items.slice(0, MAX_ITEMS);
        write(items);
    }

    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
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

        items.forEach(function (it) {
            var badge = it.ocrType === 'equation'
                ? 'bg-burgundy-600 text-cream-100'
                : 'bg-forest-600 text-cream-100';
            var li = document.createElement('li');
            li.className = 'border border-gray-300 rounded-lg p-3 bg-white';
            li.innerHTML =
                '<div class="flex items-center justify-between gap-2 flex-wrap">' +
                    '<span class="text-xs font-semibold uppercase px-2 py-1 rounded ' + badge + '">' +
                        escapeHtml(it.ocrType) +
                    '</span>' +
                    '<span class="text-sm text-forest-700 truncate">' + escapeHtml(it.fileName) + '</span>' +
                    '<span class="text-xs text-forest-500">' + escapeHtml(it.at) + '</span>' +
                '</div>' +
                '<pre class="mt-2 bg-forest-100 p-3 rounded text-xs whitespace-pre-wrap font-mono ' +
                    'max-h-40 overflow-y-auto">' + escapeHtml(it.result) + '</pre>';
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
})();
