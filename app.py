# app.py
import os
from flask import Flask, request, render_template, redirect, url_for, send_file, session
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq
import io
from textract_fast import extract_text_from_file, generate_tex_file
from equation import is_model_loaded, process_image
 # Initialize Flask app
app = Flask(__name__)
# ---------------------------------------------------------
app.secret_key = 'supersecretkey' # Required for session
# ---------------------------------------------------------
app.config['UPLOAD_FOLDER'] = 'uploads' # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

@app.route('/', methods=['GET'])
def home():
    # ---------------------------------------------------------
    # Retrieve and clear session data (Post/Redirect/Get pattern)
    # This ensures data is shown once, and cleared on reload
    # ---------------------------------------------------------
    
    # Equation data
    recognized_equation = session.pop('recognized_equation', None)
    uploaded_image_name = session.pop('uploaded_image_name', None)
    show_equation_result = session.pop('show_equation_result', False)
    equation_error = session.pop('equation_error', None)
    
    # Textract data
    recognized_textract = session.pop('recognized_textract', None)
    tex_file = session.pop('tex_file', False)
    show_textract_result = session.pop('show_textract_result', False)
    textract_error = session.pop('textract_error', None)

    return render_template('home.html', 
                           recognized_equation=recognized_equation,
                           uploaded_image_name=uploaded_image_name,
                           show_equation_result=show_equation_result,
                           error_message=equation_error,
                           recognized_textract=recognized_textract,
                           tex_file=tex_file,
                           show_textract_result=show_textract_result,
                           error=textract_error)


@app.route('/equation', methods=['GET', 'POST'])
def upload_and_process():
    if not is_model_loaded():
        #edit
        session['equation_error'] = "Error: OCR Model not loaded. Please check server logs."
        return redirect(url_for('home') + '#equation')

    if request.method == 'POST':
        print("DEBUG: Equation POST request received")
        print(f"DEBUG: Files in request: {list(request.files.keys())}")
        file = request.files.get('file')
        print(f"DEBUG: File object: {file}, filename: {file.filename if file else 'None'}")
        if not file or file.filename == '':
            print("DEBUG: No file or empty filename, redirecting")
            #edit
            return redirect(url_for('home') + '#equation')

        try:
            image_bytes = file.read()
            final_text = process_image(image_bytes)
            print(f"DEBUG: Equation result: {final_text}")
            #edit
            # ---------------------------------------------------------
            # Store in session
            session['recognized_equation'] = final_text
            session['uploaded_image_name'] = file.filename
            session['show_equation_result'] = True
            # ---------------------------------------------------------
            
            return redirect(url_for('home') + '#equation')
            #edit
        except Exception as e:
            print(f"Error during OCR processing: {e}")
            #edit
            session['equation_error'] = f"An error occurred: {e}"
            return redirect(url_for('home') + '#equation')

    return redirect(url_for('home'))
            #edit
@app.route('/textract', methods=['GET', 'POST'])
def textract_route():
    if request.method == 'POST':
        print("DEBUG: Textract POST request received")
        print(f"DEBUG: Files in request: {list(request.files.keys())}")
        file = request.files.get('file')
        print(f"DEBUG: File object: {file}, filename: {file.filename if file else 'None'}")
        if not file or file.filename == '':
            print("DEBUG: No file or empty filename")
            #edit
            session['textract_error'] = "No file selected."
            return redirect(url_for('home') + '#textract')

        # Save file
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(file_path)

        result_text = extract_text_from_file(file_path)
        print(f"DEBUG: Textract result: {result_text}")

        tex_file_path = os.path.join(app.config['UPLOAD_FOLDER'], 'output.tex')
        generate_tex_file(result_text, tex_file_path)

        # ---------------------------------------------------------
        # Store in session
        session['recognized_textract'] = result_text
        session['tex_file'] = True
        session['show_textract_result'] = True
        # ---------------------------------------------------------
        
        return redirect(url_for('home') + '#textract')

    return redirect(url_for('home'))

@app.route('/download-tex')
def download_tex():
    tex_path = os.path.join(app.config['UPLOAD_FOLDER'], 'output.tex')
    return send_file(tex_path, as_attachment=True)


if __name__ == "__main__":
    print("Server starting... PRG pattern active. Please restart the server if you don't see this message.")
    # Use Flask's built-in debug mode
    # We enable the reloader so code changes take effect immediately
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=True, use_reloader=True, host="0.0.0.0", port=port) 