// function displayFileName(input) {
//     const fileNameDisplay = document.getElementById('file-name');
//     if (input.files && input.files.length > 0) {
//         fileNameDisplay.textContent = input.files[0].name;
//     } else {
//         fileNameDisplay.textContent = 'No file chosen';
//     }
// }

// function displayFileName(input) {
//     const fileNameDisplay = document.getElementById('file-name');
//     // Reset camera preview if a file is chosen
//     const cameraPreview = document.getElementById('camera-preview');
//     if (cameraPreview) {
//         cameraPreview.src = '';
//         cameraPreview.style.display = 'none';
//     }
//     if (input.files && input.files.length > 0) {
//         fileNameDisplay.textContent = input.files[0].name;
//     } else {
//         fileNameDisplay.textContent = 'No file chosen';
//     }
// }

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

// function capturePhoto() {
//     const video = document.getElementById('camera-stream');
//     const canvas = document.createElement('canvas');
//     canvas.width = video.videoWidth;
//     canvas.height = video.videoHeight;
//     const ctx = canvas.getContext('2d');
//     ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
//     canvas.toBlob(function(blob) {
//         // Show preview
//         const preview = document.getElementById('camera-preview');
//         preview.src = URL.createObjectURL(blob);
//         preview.style.display = 'block';
//         // Set the blob as the file input value for form submission
//         const fileInput = document.getElementById('camera-upload');
//         const file = new File([blob], "captured_photo.png", { type: "image/png" });
//         // Use DataTransfer to set file input
//         const dt = new DataTransfer();
//         dt.items.add(file);
//         fileInput.files = dt.files;
//     }, 'image/png');
//     closeCameraModal();
// }

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

