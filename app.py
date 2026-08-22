# app.py
import os
from flask import Flask, request, render_template, redirect, url_for, send_file, session
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq
import io
from dotenv import load_dotenv
from textract_fast import extract_text_from_file, generate_tex_file
from equation import is_model_loaded, process_image
import firebase_config
from functools import wraps

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)
# ---------------------------------------------------------
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'supersecretkey')  # Required for session
# ---------------------------------------------------------
app.config['UPLOAD_FOLDER'] = os.getenv('UPLOAD_FOLDER', 'uploads')  # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

# ===========================
# Authentication Decorator
# ===========================
def login_required(f):
    """
    Decorator to require login for routes.

    NOTE: deliberately NOT applied to the OCR routes. Every core feature of
    this app (/, /equation, /textract, /download-tex) is usable by guests.
    Logging in only adds persistent history.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function


def current_user_uid():
    """
    Return the signed-in user's Firebase UID, or None for a guest.

    The UID always comes from the server-side session (set only after Firebase
    verified a password or an ID token). It is never read from the request, so
    a client cannot target another user's history by forging a uid field.
    """
    user = session.get('user')
    return user.get('uid') if isinstance(user, dict) else None


def record_history(file_name, ocr_type, result):
    """
    Persist one OCR result for signed-in users only.

    Guests are intentionally skipped here: their history is kept client-side
    in sessionStorage so it disappears with the tab and never touches
    Firestore. Returns True if the record was written.
    """
    uid = current_user_uid()
    if not uid:
        return False
    return firebase_config.save_ocr_history(uid, file_name, ocr_type, result)


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

    # ---------------------------------------------------------
    # History
    # Signed in  -> read the persistent list back from Firestore.
    # Guest      -> nothing server-side; the browser holds it in sessionStorage.
    # ---------------------------------------------------------
    uid = current_user_uid()
    history = firebase_config.get_user_ocr_history(uid, limit=20) if uid else []

    # One-shot flag set by an OCR POST. It survives exactly one redirect, so we
    # can tell the Post/Redirect/Get landing apart from a real page refresh:
    # on the PRG landing we keep the guest's session history, on a refresh or a
    # fresh visit we tell the browser to wipe it.
    keep_guest_history = session.pop('just_processed', False)

    return render_template('home.html',
                           recognized_equation=recognized_equation,
                           uploaded_image_name=uploaded_image_name,
                           show_equation_result=show_equation_result,
                           error_message=equation_error,
                           recognized_textract=recognized_textract,
                           tex_file=tex_file,
                           show_textract_result=show_textract_result,
                           error=textract_error,
                           history=history,
                           is_authenticated=bool(uid),
                           keep_guest_history=keep_guest_history)


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
            session['just_processed'] = True
            # ---------------------------------------------------------

            # Signed-in users get this saved to Firestore; guests do not.
            record_history(file.filename, 'equation', final_text)

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
            session['just_processed'] = True
            # ---------------------------------------------------------

            # Signed-in users get this saved to Firestore; guests do not.
            record_history(file.filename, 'textract', result_text)
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
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('home'))
    
    if request.method == 'POST':
        # Check if this is a Firebase ID token login (from Google/Facebook)
        id_token = request.form.get('idToken')
        
        if id_token:
            # Verify Firebase ID token
            decoded_token = firebase_config.verify_id_token(id_token)
            if decoded_token:
                uid = decoded_token['uid']
                user = firebase_config.get_user_by_uid(uid)
                
                if user:
                    # Federated users skip create_user(), so make sure they
                    # still have a users/ profile document.
                    firebase_config.upsert_user_profile(
                        user['uid'], user['email'], user['displayName'])

                    session['user'] = {
                        'uid': user['uid'],
                        'email': user['email'],
                        'displayName': user['displayName']
                    }
                    session.permanent = True
                    print(f"DEBUG: Google login successful - UID: {uid}")
                    return redirect(url_for('home'))
            
            return render_template('auth/login.html', error="Authentication failed")
        
        # Regular email/password login
        email = request.form.get('email')
        password = request.form.get('password')
        remember = request.form.get('remember')
        
        if not email or not password:
            return render_template('auth/login.html', error="Please provide email and password")
        
        # Verify user with Firebase
        result = firebase_config.verify_user(email, password)
        
        if result['success']:
            user = result['user']
            # Store user info in session
            session['user'] = {
                'uid': user.uid,
                'email': user.email,
                'displayName': user.display_name
            }
            session.permanent = bool(remember)
            print(f"DEBUG: Login successful - UID: {user.uid}")
            return redirect(url_for('home'))
        else:
            return render_template('auth/login.html', error=result.get('error', 'Invalid credentials'))
    
    # Pass Firebase config to template
    firebase_config_data = {
        'apiKey': os.getenv('FIREBASE_API_KEY'),
        'authDomain': os.getenv('FIREBASE_AUTH_DOMAIN'),
        'projectId': os.getenv('FIREBASE_PROJECT_ID')
    }
    return render_template('auth/login.html', firebase_config=firebase_config_data)

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('home'))
    
    if request.method == 'POST':
        fullname = request.form.get('fullname')
        email = request.form.get('email')
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')
        terms = request.form.get('terms')
        
        # Basic validation
        if not all([fullname, email, password, confirm_password]):
            return render_template('auth/signup.html', error="All fields are required")
        
        if password != confirm_password:
            return render_template('auth/signup.html', error="Passwords do not match")
        
        if len(password) < 6:
            return render_template('auth/signup.html', error="Password must be at least 6 characters")
        
        if not terms:
            return render_template('auth/signup.html', error="You must agree to the terms and conditions")
        
        # Create user in Firebase
        result = firebase_config.create_user(email, password, fullname)
        
        if result['success']:
            print(f"DEBUG: User created - UID: {result['uid']}")
            return render_template('auth/signup.html', success="Account created successfully! Please login.")
        else:
            return render_template('auth/signup.html', error=result.get('error', 'Failed to create account'))
    
    return render_template('auth/signup.html')

@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        email = request.form.get('email')
        
        if not email:
            return render_template('auth/forgot_password.html', error="Please provide your email address")
        
        # Send password reset email via Firebase
        result = firebase_config.send_password_reset(email)
        
        if result['success']:
            print(f"DEBUG: Password reset link sent to: {email}")
            # For security, always show success message
            return render_template('auth/forgot_password.html', 
                                 success="If an account exists with that email, you will receive a password reset link.")
        else:
            return render_template('auth/forgot_password.html', 
                                 error=result.get('error', 'An error occurred'))
    
    return render_template('auth/forgot_password.html')

@app.route('/logout')
def logout():
    """Logout user and clear session"""
    session.clear()
    return redirect(url_for('login'))


@app.route('/index')
def index():
    return redirect(url_for('home'))

if __name__ == "__main__":
    print("Server starting... PRG pattern active. Please restart the server if you don't see this message.")
    # Use Flask's built-in debug mode
    # We enable the reloader so code changes take effect immediately
    port = int(os.getenv("PORT", 5000))
    debug_mode = os.getenv("FLASK_DEBUG", "True").lower() == "true"
    app.run(debug=debug_mode, host="0.0.0.0", port=port) 