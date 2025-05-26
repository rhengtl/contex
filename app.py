# app.py
import os
from flask import Flask, request, render_template, redirect, url_for, send_file
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq
import io
from textract import extract_text_from_file, generate_tex_file
from equation import is_model_loaded, process_image



# Initialize Flask app
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads' # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

@app.route('/', methods=['GET'])
def home():
    return render_template('home.html')


@app.route('/equation', methods=['GET', 'POST'])
def upload_and_process():
    if not is_model_loaded():
        return "Error: OCR Model not loaded. Please check server logs.", 500

    if request.method == 'POST':
        file = request.files.get('file')
        if not file or file.filename == '':
            return redirect(request.url)

        try:
            image_bytes = file.read()
            final_text = process_image(image_bytes)
            return render_template('equation.html', recognized_text=final_text, uploaded_image_name=file.filename)
        except Exception as e:
            print(f"Error during OCR processing: {e}")
            return render_template('equation.html', error_message=f"An error occurred: {e}")

    return render_template('equation.html', recognized_text=None)

@app.route('/textract', methods=['GET', 'POST'])
def textract_route():
    if request.method == 'POST':
        file = request.files.get('file')
        if not file or file.filename == '':
            return render_template('textract.html', error="No file selected.")

        # Save file
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(file_path)

        result_text = extract_text_from_file(file_path)

        tex_file_path = os.path.join(app.config['UPLOAD_FOLDER'], 'output.tex')
        generate_tex_file(result_text, tex_file_path)

        return render_template('textract.html', recognized_text=result_text, tex_file = True)

    return render_template('textract.html')

@app.route('/download-tex')
def download_tex():
    tex_path = os.path.join(app.config['UPLOAD_FOLDER'], 'output.tex')
    return send_file(tex_path, as_attachment=True)


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)