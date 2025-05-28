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

function showCameraPreview(input) {
    const preview = document.getElementById('camera-preview');
    // Reset file name if a photo is taken
    const fileNameDisplay = document.getElementById('file-name');
    if (fileNameDisplay) {
        fileNameDisplay.textContent = 'No file chosen';
    }
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    } else {
        preview.src = '';
        preview.style.display = 'none';
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
    // Touch support
    canvas.ontouchstart = function(e) {
        if (e.touches.length === 1) {
            isDrawing = true;
            const rect = canvas.getBoundingClientRect();
            lastX = e.touches[0].clientX - rect.left;
            lastY = e.touches[0].clientY - rect.top;
        }
    };
    canvas.ontouchend = function() {
        isDrawing = false;
    };
    canvas.ontouchmove = function(e) {
        if (!isDrawing || e.touches.length !== 1) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.touches[0].clientX - rect.left;
        const y = e.touches[0].clientY - rect.top;
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.stroke();
        lastX = x;
        lastY = y;
        e.preventDefault();
    };
};

window.addEventListener('DOMContentLoaded', setupDrawing);

function copyInline() {
    const text = "$ " + document.getElementById('recognized-text').innerText + " $";
    navigator.clipboard.writeText(text).then(function() {
        alert('Recognized text copied to clipboard!');
    }, function(err) {
        alert('Failed to copy text: ' + err);
    });
}

function copyDisplay() {
    const text = "\\[\n" + document.getElementById('recognized-text').innerText + "\n\\]";
    navigator.clipboard.writeText(text).then(function() {
        alert('Recognized text copied to clipboard!');
    }, function(err) {
        alert('Failed to copy text: ' + err);
    });
}

