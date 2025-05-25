# app.py
import os
from flask import Flask, request, render_template, redirect, url_for
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq
import io

# Initialize Flask app
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads' # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

try:
    print("Loading OCR model and processor...")
    processor = TrOCRProcessor.from_pretrained('breezedeus/pix2text-mfr')
    model = ORTModelForVision2Seq.from_pretrained('breezedeus/pix2text-mfr', use_cache=False)
    print("Model and processor loaded successfully.")
except Exception as e:
    print(f"Error loading model or processor: {e}")
    # Fallback or exit if model loading fails
    processor = None
    model = None

@app.route('/', methods=['GET', 'POST'])
def upload_and_process():

    if model is None or processor is None:
        return "Error: OCR Model not loaded. Please check server logs.", 500

    if request.method == 'POST':
        # Check if the post request has the file part
        if 'file' not in request.files:
            return redirect(request.url) # Or show an error message
        
        file = request.files['file']
        
        # If the user does not select a file, the browser submits an
        # empty file without a filename.
        if file.filename == '':
            return redirect(request.url) # Or show an error message

        if file:
            try:
                # Read image from in-memory buffer
                image_bytes = file.read()
                img = Image.open(io.BytesIO(image_bytes)).convert('RGB')
                
                # --- OCR Processing ---
                print("Processing image...")
                pixel_values = processor(images=img, return_tensors="pt").pixel_values

                generated_ids = model.generate(pixel_values)
                generated_text_list = processor.batch_decode(generated_ids, skip_special_tokens=True)
                
                final_text = '[No text recognized]'
                if generated_text_list and generated_text_list[0]:
                    final_text = generated_text_list[0]
                print(f"Generated text: {final_text}")

                return render_template('index.html', recognized_text=final_text, uploaded_image_name=file.filename)
            
            except Exception as e:
                print(f"Error during OCR processing: {e}")
                return render_template('index.html', error_message=f"An error occurred: {e}")

    # For GET request, just display the upload form
    return render_template('index.html', recognized_text=None)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)