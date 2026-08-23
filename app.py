# app.py
import os
import io
import uuid
from flask import (Flask, request, render_template, redirect, url_for,
                   send_file, session)
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from textract_fast import extract_text_from_file, generate_tex_source
from equation import is_model_loaded, process_image_list
import ai_qa
import latex_tools
import tex_store
import firebase_config

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)
# ---------------------------------------------------------
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'supersecretkey')  # Required for session
# ---------------------------------------------------------
app.config['UPLOAD_FOLDER'] = os.getenv('UPLOAD_FOLDER', 'uploads')  # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

# Hard ceiling on request size. This stops an oversized body from being
# buffered at all, before any converter or reviewer sees it.
_MAX_UPLOAD_MB = int(os.getenv('MAX_UPLOAD_MB', '32'))
app.config['MAX_CONTENT_LENGTH'] = _MAX_UPLOAD_MB * 1024 * 1024


@app.errorhandler(413)
def upload_too_large(_error):
    """Turn Werkzeug's 413 into the same in-page error the routes use."""
    session['textract_error'] = (f"That file is too large. The limit is "
                                 f"{_MAX_UPLOAD_MB} MB.")
    return redirect(url_for('home') + '#textract'), 302

# NOTE: none of the OCR routes require a login. Every core feature of this app
# (/, /equation, /textract and the downloads) is usable by guests; signing in
# only adds persistent history.


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
    # A whole .tex document can be long; keep history rows a sane size.
    if result and len(result) > HISTORY_RESULT_LIMIT:
        result = result[:HISTORY_RESULT_LIMIT] + '\n... [truncated]'
    return firebase_config.save_ocr_history(uid, file_name, ocr_type, result)


# Longest result text stored in a history record.
HISTORY_RESULT_LIMIT = 60000


# How many generated results one session can hold at once (one per pipeline,
# plus a little slack). Older ones are deleted as new ones arrive.
_MAX_SESSION_TEX = 4


def remember_tex(payload):
    """
    Store a generated .tex result and bind it to THIS session.

    Returns the token. Only tokens listed in the caller's own session can be
    downloaded later, so one visitor can never fetch another's document.
    """
    token = tex_store.save(payload)
    tokens = list(session.get('tex_tokens', [])) + [token]
    for expired in tokens[:-_MAX_SESSION_TEX]:
        tex_store.discard(expired)
    session['tex_tokens'] = tokens[-_MAX_SESSION_TEX:]
    return token


def owns_token(token):
    """True when the current session generated this result."""
    return bool(token) and token in session.get('tex_tokens', [])


def owned_tex(token):
    """Return a stored result only if the current session owns that token."""
    if not owns_token(token):
        return None
    return tex_store.read(token)


@app.route('/', methods=['GET'])
def home():
    # ---------------------------------------------------------
    # Retrieve and clear session data (Post/Redirect/Get pattern)
    # This ensures data is shown once, and cleared on reload.
    #
    # Both converters store their result server-side and keep only the token
    # in the session: a page of OCR text - let alone a whole .tex document
    # plus its QA report - does not fit in a 4KB session cookie.
    # ---------------------------------------------------------

    # Equation data
    equation_token = session.pop('equation_token', None)
    uploaded_image_name = session.pop('uploaded_image_name', None)
    show_equation_result = session.pop('show_equation_result', False)
    equation_error = session.pop('equation_error', None)
    equation_result = owned_tex(equation_token) if equation_token else None

    # Textract data
    textract_token = session.pop('textract_job_token', None)
    show_textract_result = session.pop('show_textract_result', False)
    textract_error = session.pop('textract_error', None)
    textract_result = owned_tex(textract_token) if textract_token else None
    recognized_textract = textract_result['text'] if textract_result else None
    tex_file = textract_token if textract_result else None

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
                           equation_result=equation_result,
                           equation_token=equation_token if equation_result else None,
                           uploaded_image_name=uploaded_image_name,
                           show_equation_result=show_equation_result,
                           error_message=equation_error,
                           recognized_textract=recognized_textract,
                           textract_result=textract_result,
                           tex_file=tex_file,
                           show_textract_result=show_textract_result,
                           error=textract_error,
                           history=history,
                           is_authenticated=bool(uid),
                           keep_guest_history=keep_guest_history,
                           qa=ai_qa.provider_info(),
                           latex_engine=latex_tools.engine_name(
                               latex_tools.find_engine()))


@app.route('/equation', methods=['GET', 'POST'])
def upload_and_process():
    """
    Equation converter, then AI QA.

        image -> pix2text-mfr -> [eq 1, eq 2, ...] -> AI review -> .tex

    The converter lists every equation it finds separately, in reading order.
    It deliberately does not try to work out how they relate or how they should
    be laid out - that judgement needs the original image, and it is what the
    review stage is for. If the review is unavailable the equations are still
    returned, one displayed equation each.
    """
    if not is_model_loaded():
        session['equation_error'] = "Error: OCR Model not loaded. Please check server logs."
        return redirect(url_for('home') + '#equation')

    if request.method != 'POST':
        return redirect(url_for('home'))

    file = request.files.get('file')
    if not file or file.filename == '':
        session['equation_error'] = "No file selected."
        return redirect(url_for('home') + '#equation')

    try:
        image_bytes = file.read()
        equations = process_image_list(image_bytes)
    except Exception as e:
        print(f"Error during equation recognition: {e}")
        session['equation_error'] = f"An error occurred: {e}"
        return redirect(url_for('home') + '#equation')

    # QA never blocks the result: any failure returns the converter's own
    # list, laid out without the AI's help.
    review = ai_qa.review_equations(image_bytes, file.filename, equations)

    token = remember_tex({
        'tex': review['tex'],
        'text': review['tex'],
        'file_name': file.filename,
        'source': 'equation',
        'detected': equations,
        'qa': _qa_payload(review),
    })

    session['equation_token'] = token
    session['uploaded_image_name'] = file.filename
    session['show_equation_result'] = True
    session['just_processed'] = True

    # Signed-in users get this saved to Firestore; guests do not.
    record_history(file.filename, 'equation', review['tex'])

    return redirect(url_for('home') + '#equation')


@app.route('/textract', methods=['GET', 'POST'])
def textract_route():
    """
    Textract converter, then AI QA.

        image/PDF -> Tesseract -> .tex -> AI review -> .tex

    Tesseract remains the OCR engine. The reviewer sees the original upload
    beside the generated LaTeX and corrects what the image proves is wrong.
    """
    if request.method != 'POST':
        return redirect(url_for('home'))

    file = request.files.get('file')
    if not file or file.filename == '':
        session['textract_error'] = "No file selected."
        return redirect(url_for('home') + '#textract')

    file_bytes = file.read()

    # Save the upload under a name we generate. Using the browser-supplied
    # filename directly let a crafted name escape the upload folder.
    file_path = os.path.join(app.config['UPLOAD_FOLDER'],
                             unique_upload_name(file.filename))
    with open(file_path, 'wb') as handle:
        handle.write(file_bytes)

    try:
        result_text = extract_text_from_file(file_path)
    finally:
        # Auto delete uploaded file after processing
        if os.path.exists(file_path):
            os.remove(file_path)

    draft_tex = generate_tex_source(result_text)

    # QA never blocks the result: any failure returns Tesseract's own .tex.
    review = ai_qa.review_document(file_bytes, file.filename, draft_tex)

    token = remember_tex({
        'tex': review['tex'],
        'text': result_text,
        'draft_tex': draft_tex,
        'file_name': file.filename,
        'source': 'textract',
        'qa': _qa_payload(review),
    })

    session['textract_job_token'] = token
    session['show_textract_result'] = True
    session['just_processed'] = True

    # Signed-in users get this saved to Firestore; guests do not.
    record_history(file.filename, 'textract', result_text)

    return redirect(url_for('home') + '#textract')


def _qa_payload(review):
    """The parts of a QA result the page needs (no credentials, no bulk)."""
    return {
        'status': review['status'],
        'message': review['message'],
        'findings': review['findings'],
        'equations': review['equations'],
        'summary': review['summary'],
        'compile': review['compile'],
        'model': review['model'],
        'provider': review['provider'],
        'usage': review['usage'],
    }


def unique_upload_name(filename):
    """A collision-free, traversal-free name for a temporarily saved upload."""
    safe = secure_filename(filename or '') or 'upload'
    return f"{uuid.uuid4().hex}_{safe}"


def send_tex(token, fallback_name):
    """
    Serve a stored .tex file, but only to the session that generated it.

    The file is streamed from memory so no extra copy is left in the upload
    folder, and an unknown or expired token is a 404 rather than someone
    else's document.
    """
    job = owned_tex(token)
    if not job:
        return ("That download link has expired or does not belong to this "
                "session. Please run the conversion again."), 404

    name = job.get('file_name') or fallback_name
    base = os.path.splitext(secure_filename(name) or fallback_name)[0] or 'document'
    return send_file(
        io.BytesIO(job['tex'].encode('utf-8')),
        mimetype='application/x-tex',
        as_attachment=True,
        download_name=f'{base}.tex')


@app.route('/download-tex')
def download_tex():
    """Download the Textract-generated .tex for this session."""
    token = request.args.get('token') or _latest_token('textract')
    return send_tex(token, 'textract-output')


@app.route('/download-equation-tex')
def download_equation_tex():
    """Download the reviewed equation .tex for this session."""
    token = request.args.get('token') or _latest_token('equation')
    return send_tex(token, 'equations')


def _latest_token(source):
    """Most recent token in this session that came from the given pipeline."""
    for token in reversed(session.get('tex_tokens', [])):
        stored = tex_store.read(token)
        if stored and stored.get('source') == source:
            return token
    return None


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
    port = int(os.getenv("PORT", 5000))
    debug_mode = os.getenv("FLASK_DEBUG", "True").lower() == "true"
    app.run(debug=debug_mode, host="0.0.0.0", port=port) 