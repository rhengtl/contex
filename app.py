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

        # Save file temporarily
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(file_path)

        try:
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
        finally:
            # Auto delete uploaded file after processing
            if os.path.exists(file_path):
                os.remove(file_path)
                print(f"DEBUG: Auto-deleted file: {file_path}")
        
        return redirect(url_for('home') + '#textract')

    return redirect(url_for('home'))

@app.route('/download-tex')
def download_tex():
    tex_path = os.path.join(app.config['UPLOAD_FOLDER'], 'output.tex')
    return send_file(tex_path, as_attachment=True)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        remember = request.form.get('remember')
        
        # TODO: Add actual authentication logic here
        # For now, just redirect to home
        print(f"DEBUG: Login attempt - Email: {email}")
        
        # Example: You would validate credentials here
        # if validate_user(email, password):
        #     session['user'] = email
        #     return redirect(url_for('home'))
        # else:
        #     return render_template('login.html', error="Invalid credentials")
        
        return redirect(url_for('home'))
    
    return render_template('login.html')

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        fullname = request.form.get('fullname')
        email = request.form.get('email')
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')
        terms = request.form.get('terms')
        
        # TODO: Add actual registration logic here
        print(f"DEBUG: Signup attempt - Name: {fullname}, Email: {email}")
        
        # Basic validation
        if password != confirm_password:
            return render_template('signup.html', error="Passwords do not match")
        
        if not terms:
            return render_template('signup.html', error="You must agree to the terms")
        
        # Example: You would create user account here
        # if create_user(fullname, email, password):
        #     return render_template('signup.html', success="Account created! Please login.")
        # else:
        #     return render_template('signup.html', error="Email already exists")
        
        return render_template('signup.html', success="Account created successfully! Please login.")
    
    return render_template('signup.html')

@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        email = request.form.get('email')
        
        # TODO: Add actual password reset logic here
        print(f"DEBUG: Password reset request - Email: {email}")
        
        # Example: You would send reset email here
        # if send_password_reset_email(email):
        #     return render_template('forgot_password.html', success="Password reset link sent to your email!")
        # else:
        #     return render_template('forgot_password.html', error="Email not found")
        
        return render_template('forgot_password.html', success="If an account exists with that email, you will receive a password reset link.")
    
    return render_template('forgot_password.html')

@app.route('/index')
def index():
    return redirect(url_for('home'))

if __name__ == "__main__":
    print("Server starting... PRG pattern active. Please restart the server if you don't see this message.")
    # Use Flask's built-in debug mode
    # We enable the reloader so code changes take effect immediately
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=True, host="0.0.0.0", port=port) 