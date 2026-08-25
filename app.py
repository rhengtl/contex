# app.py
"""
ConTeX - one document in, one .tex out.

There is a single conversion feature. Which engine reads a page is an
implementation detail the user is never asked about; the only choice they are
ever given is the one that actually costs them something, which is whether to
proceed on the local fallback when the AI is unavailable.

    accept terms -> provide input -> convert -> .tex -> preview / download / copy

Every input method (image, PDF, .docx, camera, canvas) posts the same `file`
field to /convert.
"""

import gzip
import hashlib
import io
import os

from flask import (Flask, jsonify, request, render_template, redirect,
                   url_for, send_file, session)
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

import ai_qa
import ai_status
import convert
import firebase_config
import latex_tools
import tex_store

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

# Static files are addressed with a ?v= stamp that changes when the file does
# (see add_static_version), so they can be cached hard and for a long time. A
# year is the usual choice for an immutable URL; an edited file simply gets a
# different URL rather than waiting for a cache to expire.
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 31536000


@app.url_defaults
def add_static_version(endpoint, values):
    """
    Stamp every static URL with the file's modification time.

    Without this the browser has to ask whether scripts.js changed on every
    single page load, and gets told "no" - a round trip to learn nothing. With
    it the answer is in the URL, so the file is taken from cache with no
    request at all, and a genuine edit is picked up immediately because the URL
    is different.
    """
    if endpoint != 'static' or 'filename' not in values:
        return
    try:
        path = os.path.join(app.static_folder, values['filename'])
        values['v'] = int(os.stat(path).st_mtime)
    except OSError:
        pass  # a missing file is the 404's problem, not this hook's


# Responses worth compressing: markup, styles, scripts and JSON. Everything
# else this app sends - PNG page images, PDFs - is already compressed, and
# running them through gzip would cost CPU to make them very slightly larger.
_COMPRESSIBLE = ('text/html', 'text/css', 'text/plain', 'application/javascript',
                 'text/javascript', 'application/json', 'application/x-tex',
                 'image/svg+xml')
_COMPRESS_MIN_BYTES = 1024

# Static files are streamed rather than buffered, so compressing one means
# reading it into memory first. That is fine for a stylesheet and pointless for
# anything large, hence the ceiling.
_COMPRESS_MAX_BYTES = 4 * 1024 * 1024


@app.after_request
def compress_response(response):
    """
    gzip text responses when the client asked for it.

    The home page is 28 KB of markup and scripts.js is 57 KB; both are mostly
    repeated class names and compress to roughly a fifth. On a phone that is
    the difference between one round trip and several.

    Only the types listed above: the page images and PDFs this app serves are
    compressed formats already, and running them through gzip would spend CPU
    to make them marginally larger.
    """
    if (response.status_code < 200 or response.status_code >= 300
            or 'Content-Encoding' in response.headers):
        return response
    if 'gzip' not in request.headers.get('Accept-Encoding', '').lower():
        return response
    if (response.mimetype or '') not in _COMPRESSIBLE:
        return response

    response.headers.add('Vary', 'Accept-Encoding')
    length = response.content_length
    if length is not None and not (_COMPRESS_MIN_BYTES <= length
                                   <= _COMPRESS_MAX_BYTES):
        return response
    if response.direct_passthrough:
        # A streamed file response. Turning passthrough off makes get_data()
        # read the file wrapper, which is what we need in order to compress it.
        response.direct_passthrough = False
    body = response.get_data()
    if not (_COMPRESS_MIN_BYTES <= len(body) <= _COMPRESS_MAX_BYTES):
        return response

    # mtime=0 so the same bytes always produce the same output, which keeps
    # ETags stable across restarts.
    packed = gzip.compress(body, compresslevel=6, mtime=0)
    if len(packed) >= len(body):
        return response
    response.set_data(packed)
    response.headers['Content-Encoding'] = 'gzip'
    response.headers['Content-Length'] = str(len(packed))
    return response

# Bump this whenever the terms or privacy policy change materially. Everyone -
# including users who already accepted an older version - is then asked again.
# It is deliberately not a date alone: the version is what was agreed to.
TERMS_VERSION = os.getenv('TERMS_VERSION', '1.0-2026-08-24')

# Extensions the upload control accepts, in one place so the route, the drop
# area and the file picker cannot drift apart.
ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif',
                       '.webp', '.gif', '.pdf', '.docx']


@app.errorhandler(413)
def upload_too_large(_error):
    """Turn Werkzeug's 413 into the same in-page error the route uses."""
    session['convert_error'] = (f"That file is too large. The limit is "
                                f"{_MAX_UPLOAD_MB} MB.")
    return redirect(url_for('home') + '#convert'), 302

# NOTE: conversion does not require a login. Every core feature of this app is
# usable by guests; signing in only adds persistent history.


def current_user_uid():
    """
    Return the signed-in user's Firebase UID, or None for a guest.

    The UID always comes from the server-side session (set only after Firebase
    verified a password or an ID token). It is never read from the request, so
    a client cannot target another user's history by forging a uid field.
    """
    user = session.get('user')
    return user.get('uid') if isinstance(user, dict) else None


# ---------------------------------------------------------------------------
# Terms of Service / Privacy Policy gate
# ---------------------------------------------------------------------------

def terms_accepted():
    """
    True when this visitor has accepted the current terms.

    Two stores, because the two kinds of visitor are different. A guest has
    nowhere durable to keep the answer, so it lives in their session and they
    are asked again next time. A signed-in user's acceptance is on their
    profile, so it survives signing out - being asked to re-accept on every
    login would be noise, not consent.
    """
    if session.get('terms_version') == TERMS_VERSION:
        return True
    uid = current_user_uid()
    if uid and firebase_config.get_terms_accepted(uid) == TERMS_VERSION:
        # Cache it in the session so the next request does not hit Firestore.
        session['terms_version'] = TERMS_VERSION
        return True
    return False


@app.route('/accept-terms', methods=['POST'])
def accept_terms():
    """Record acceptance of the current terms for this visitor."""
    version = request.form.get('version')
    if version is None and request.is_json:
        version = (request.get_json(silent=True) or {}).get('version')
    if version != TERMS_VERSION:
        return jsonify({'ok': False,
                        'error': 'Those terms are out of date. '
                                 'Please reload the page.'}), 409

    session['terms_version'] = TERMS_VERSION
    uid = current_user_uid()
    if uid:
        firebase_config.set_terms_accepted(uid, TERMS_VERSION)
    return jsonify({'ok': True, 'version': TERMS_VERSION})


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

# Longest result text stored in a history record.
HISTORY_RESULT_LIMIT = 60000

_TRUNCATION_MARK = '\n... [truncated]'


def record_history(file_name, result):
    """
    Persist one conversion for signed-in users only.

    Guests are intentionally skipped here: their history is kept client-side
    in sessionStorage so it disappears with the tab and never touches
    Firestore. Returns the document id, or None.
    """
    uid = current_user_uid()
    if not uid:
        return None
    # A whole .tex document can be long; keep history rows a sane size.
    truncated = bool(result) and len(result) > HISTORY_RESULT_LIMIT
    if truncated:
        result = result[:HISTORY_RESULT_LIMIT] + _TRUNCATION_MARK
    return firebase_config.save_ocr_history(uid, file_name, 'convert', result,
                                            truncated=truncated)


def _history_item(doc_id):
    """One history record belonging to the signed-in user, or None."""
    uid = current_user_uid()
    if not uid:
        return None
    return firebase_config.get_ocr_history_item(uid, doc_id)


def _history_pdf_token(doc_id):
    """
    A stable cache key for a history item's compiled preview.

    Derived from the document id so the same item reuses its PDF instead of
    recompiling on every visit. It is only ever used *after* the route has
    confirmed the item belongs to the signed-in user, so it grants no access of
    its own.
    """
    return hashlib.sha256(f'history:{doc_id}'.encode()).hexdigest()[:48]


# ---------------------------------------------------------------------------
# Generated results
# ---------------------------------------------------------------------------

# How many generated results one session can hold at once. Matched to the
# length of the guest history list, so that every entry a guest can still see
# is an entry they can still preview and download.
_MAX_SESSION_TEX = 20


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


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route('/', methods=['GET'])
def home():
    # ---------------------------------------------------------
    # Retrieve and clear session data (Post/Redirect/Get pattern)
    # This ensures data is shown once, and cleared on reload.
    #
    # The result is stored server-side and only its token is kept in the
    # session: a whole .tex document plus its QA report does not fit in a 4KB
    # session cookie.
    # ---------------------------------------------------------
    convert_token = session.pop('convert_token', None)
    show_convert_result = session.pop('show_convert_result', False)
    convert_error = session.pop('convert_error', None)
    convert_blocked = session.pop('convert_blocked', None)
    convert_result = owned_tex(convert_token) if convert_token else None

    # ---------------------------------------------------------
    # History
    # Signed in  -> read the persistent list back from Firestore.
    # Guest      -> nothing server-side; the browser holds it in sessionStorage.
    # ---------------------------------------------------------
    uid = current_user_uid()
    history = firebase_config.get_user_ocr_history(uid, limit=20) if uid else []
    for item in history:
        # Recorded when the row was written. Rows saved before that field
        # existed simply do not claim to be truncated; opening one still gets
        # the accurate explanation, because the routes that compile or copy a
        # document read the document itself and check it there.
        item['truncated'] = bool(item.get('truncated'))

    # One-shot flag set by a conversion POST. It survives exactly one redirect,
    # so we can tell the Post/Redirect/Get landing apart from a real page
    # refresh: on the PRG landing we keep the guest's session history, on a
    # refresh or a fresh visit we tell the browser to wipe it.
    keep_guest_history = session.pop('just_processed', False)

    return render_template('home.html',
                           convert_result=convert_result,
                           convert_token=convert_token if convert_result else None,
                           show_convert_result=show_convert_result,
                           convert_error=convert_error,
                           convert_blocked=convert_blocked,
                           history=history,
                           is_authenticated=bool(uid),
                           keep_guest_history=keep_guest_history,
                           accepted_extensions=ACCEPTED_EXTENSIONS,
                           terms_version=TERMS_VERSION,
                           has_accepted_terms=terms_accepted(),
                           ai=ai_status.check(),
                           qa=ai_qa.provider_info(),
                           latex_engine=latex_tools.engine_name(
                               latex_tools.find_engine()))


@app.route('/legal/<document>')
def legal(document):
    """
    Serve one legal document as a fragment for the in-app modal.

    A fragment rather than a page: the requirement is that a user can read the
    terms without leaving what they were doing, so the modal fetches this and
    drops it in.
    """
    if document not in ('terms', 'privacy'):
        return 'Unknown document', 404
    return render_template(f'legal/{document}.html', terms_version=TERMS_VERSION)


# ---------------------------------------------------------------------------
# AI availability
# ---------------------------------------------------------------------------

@app.route('/api/ai-status')
def ai_status_route():
    """
    Whether the AI conversion path is usable right now.

    Polled by the page before a conversion starts, and again when the user asks
    to re-check from the outage warning - so a warning cannot outlive the
    outage that caused it.
    """
    return jsonify(ai_status.check())


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

@app.route('/convert', methods=['GET', 'POST'])
def convert_route():
    """
    The one conversion route.

    All five input methods land here: file picker, PDF, .docx, camera capture
    and canvas drawing all arrive as the same `file` field.
    """
    if request.method != 'POST':
        return redirect(url_for('home'))

    if not terms_accepted():
        session['convert_error'] = (
            'Please accept the Terms of Service and Privacy Policy before '
            'converting a document.')
        return redirect(url_for('home') + '#convert')

    file = request.files.get('file')
    if not file or file.filename == '':
        session['convert_error'] = "No file selected."
        return redirect(url_for('home') + '#convert')

    file_bytes = file.read()
    if not file_bytes:
        session['convert_error'] = "That file was empty."
        return redirect(url_for('home') + '#convert')

    # The user's answer to the outage warning, if they were shown one.
    allow_fallback = request.form.get('allow_fallback') in ('1', 'true', 'on')

    try:
        result = convert.convert(file_bytes, file.filename,
                                 allow_fallback=allow_fallback)
    except convert.FallbackNotAuthorized as blocked:
        # Never silently downgrade. Hand the status back so the page can say
        # which service is unavailable and whether recovery time is known.
        session['convert_blocked'] = blocked.status
        return redirect(url_for('home') + '#convert')
    except RuntimeError as exc:
        session['convert_error'] = str(exc)
        return redirect(url_for('home') + '#convert')
    except Exception as exc:
        print(f"ERROR: conversion failed: {exc!r}")
        session['convert_error'] = (
            "The conversion failed. Please try a different file.")
        return redirect(url_for('home') + '#convert')

    # Signed-in users get this saved to Firestore; guests do not.
    history_id = record_history(file.filename, result['tex'])

    token = remember_tex({
        'tex': result['tex'],
        'text': result['tex'],
        'draft_tex': result['raw_tex'],
        'file_name': file.filename,
        'source': 'convert',
        'history_id': history_id,
        'detected': [{'index': item['index'], 'latex': item['latex']}
                     for item in result['equations']],
        'stats': result['summary'],
        'qa': _qa_payload(result['qa']),
    })

    # The conversion already compiled this document to check that it builds.
    # Keeping that PDF is what lets the preview open immediately instead of
    # running the identical compile again while the user waits.
    if result.get('pdf'):
        tex_store.save_pdf(token, result['pdf'])

    session['convert_token'] = token
    session['show_convert_result'] = True
    session['just_processed'] = True

    return redirect(url_for('home') + '#convert')


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


# ---------------------------------------------------------------------------
# Output: download, copy (client-side) and PDF preview
# ---------------------------------------------------------------------------

def _tex_download(tex, name, fallback_name):
    base = os.path.splitext(secure_filename(name or '') or fallback_name)[0] \
        or 'document'
    return send_file(
        io.BytesIO((tex or '').encode('utf-8')),
        mimetype='application/x-tex',
        as_attachment=True,
        download_name=f'{base}.tex')


@app.route('/download-converted-tex')
def download_converted_tex():
    """
    Download a generated .tex, but only for the session that generated it.

    The file is streamed from memory so no extra copy is left in the upload
    folder, and an unknown or expired token is a 404 rather than someone else's
    document.
    """
    token = request.args.get('token') or _latest_token('convert')
    job = owned_tex(token)
    if not job:
        return ("That download link has expired or does not belong to this "
                "session. Please run the conversion again."), 404
    return _tex_download(job['tex'], job.get('file_name'), 'converted')


def _wants_html():
    """
    True when the caller is a frame or a tab rather than a script.

    The preview is shown by pointing an iframe straight at this route, because
    a browser will not hand an application/pdf body to fetch(): Chromium
    intercepts those responses for its own PDF viewer, and the script is left
    with nothing to display. So the route is loaded as a document, and a
    failure has to be something a document can render. Callers that ask for
    JSON - the API, and the tests - still get JSON.
    """
    accept = request.accept_mimetypes
    return accept['text/html'] > accept['application/json']


def preview_failure(reason, status, errors='', missing=()):
    """One preview failure, rendered for whoever asked for it."""
    if _wants_html():
        return render_template('preview_error.html', reason=reason,
                               errors=errors or '',
                               missing=list(missing or [])), status
    return jsonify({'ok': False, 'reason': reason, 'errors': errors or '',
                    'missing_packages': list(missing or [])}), status


def _preview_pdf_bytes(tex, cache_token=None):
    """
    The compiled PDF for a preview: (pdf_bytes, failure).

    `failure` is (reason, status, errors, missing) when there is nothing to
    show. Compiling is the slow half of a preview, so the result is cached
    against the same token that owns the document.
    """
    if cache_token:
        cached = tex_store.read_pdf(cache_token)
        if cached:
            return cached, None

    result = latex_tools.compile_tex(tex, want_pdf=True)
    if result['ok'] and result.get('pdf'):
        if cache_token:
            tex_store.save_pdf(cache_token, result['pdf'])
        return result['pdf'], None

    if not result['attempted']:
        return None, (
            result.get('reason')
            or 'No LaTeX engine is installed on this server, so a preview '
               'cannot be produced. The .tex file is still correct and can be '
               'downloaded.',
            503, '', [])

    return None, (
        result.get('reason')
        or f"{result['engine']} could not compile this document.",
        422, result.get('errors') or '', result.get('missing_packages') or [])


def _compiled_pdf(tex, cache_token=None):
    """
    Serve the compiled PDF itself, for opening or saving the real file.

    This is not what the on-page preview uses - see preview_pages - because a
    browser takes an application/pdf response away from the page before it can
    be displayed. It stays because a user still wants the actual document.
    """
    pdf, failure = _preview_pdf_bytes(tex, cache_token)
    if pdf:
        return send_file(io.BytesIO(pdf), mimetype='application/pdf',
                         download_name='preview.pdf')
    reason, status, errors, missing = failure
    return preview_failure(reason, status, errors=errors, missing=missing)


@app.route('/preview.pdf')
def preview_pdf():
    """Render this session's generated .tex to a PDF for the in-page preview."""
    token = request.args.get('token') or _latest_token('convert')
    job = owned_tex(token)
    if not job:
        return preview_failure('That preview has expired or does not belong '
                               'to this session. Please convert again.', 404)
    return _compiled_pdf(job['tex'], cache_token=token)


def _preview_target():
    """
    What a preview request is about: (tex, cache_token, failure).

    Accepts either a result token owned by this session or a saved history id,
    so a fresh conversion and a saved one share one pair of routes.
    """
    doc_id = request.args.get('doc')
    if doc_id:
        item = _history_item(doc_id)
        if not item:
            return None, None, ('That history item was not found.', 404)
        tex = item.get('result') or ''
        if _TRUNCATION_MARK in tex:
            return None, None, (
                'This saved document was too long to store in full, so it '
                'cannot be compiled. Convert the original again to get a '
                'complete .tex.', 422)
        return tex, _history_pdf_token(doc_id), None

    token = request.args.get('token') or _latest_token('convert')
    job = owned_tex(token)
    if not job:
        return None, None, ('That preview has expired or does not belong to '
                            'this session. Please convert again.', 404)
    return job['tex'], token, None


@app.route('/preview/pages')
def preview_pages():
    """
    Render the document to page images and say how many there are.

    This is what the on-page preview is built from. The images are then fetched
    as ordinary <img> loads, which every browser displays - unlike a PDF, which
    Chromium hands to its own viewer, and which a download manager extension
    takes away from the page entirely. Always JSON, so nothing intercepts it.
    """
    tex, cache_token, failure = _preview_target()
    if failure:
        reason, status = failure
        return jsonify({'ok': False, 'reason': reason, 'errors': '',
                        'missing_packages': []}), status

    cached = tex_store.count_pages(cache_token)
    if cached:
        return jsonify({'ok': True, 'pages': cached})

    pdf, failure = _preview_pdf_bytes(tex, cache_token)
    if failure:
        reason, status, errors, missing = failure
        return jsonify({'ok': False, 'reason': reason, 'errors': errors,
                        'missing_packages': missing}), status

    pages, error = latex_tools.render_pages(pdf)
    if error:
        return jsonify({'ok': False, 'reason': error, 'errors': '',
                        'missing_packages': []}), 503

    written = tex_store.save_pages(cache_token, pages)
    if not written:
        return jsonify({'ok': False,
                        'reason': 'The rendered pages could not be stored on '
                                  'this server, so the preview cannot be '
                                  'shown. The .tex file is unaffected.',
                        'errors': '', 'missing_packages': []}), 500
    return jsonify({'ok': True, 'pages': written})


# Deliberately a type nothing claims. An application/pdf response never
# reaches the page that asked for it: the browser routes it to its own viewer,
# and a download manager extension takes it and downloads it instead. Under
# this type the bytes arrive intact, and the page labels them as a PDF itself.
_OPAQUE_PDF = 'application/x-contex-pdf'


@app.route('/preview/document')
def preview_document():
    """
    The compiled PDF as plain bytes, for opening it in the browser's viewer.

    Not a substitute for /preview.pdf, which still serves the real thing to
    anyone who asks for it directly. This exists so the Open in a new tab
    buttons can hand the browser a blob to display rather than a response
    something else will intercept first.
    """
    tex, cache_token, failure = _preview_target()
    if failure:
        reason, status = failure
        return jsonify({'ok': False, 'reason': reason, 'errors': '',
                        'missing_packages': []}), status

    pdf, failure = _preview_pdf_bytes(tex, cache_token)
    if failure:
        reason, status, errors, missing = failure
        return jsonify({'ok': False, 'reason': reason, 'errors': errors,
                        'missing_packages': missing}), status
    return send_file(io.BytesIO(pdf), mimetype=_OPAQUE_PDF)


@app.route('/preview/page.png')
def preview_page():
    """One rendered page, as a plain image."""
    _tex, cache_token, failure = _preview_target()
    if failure:
        return '', 404
    try:
        number = int(request.args.get('n', '1'))
    except (TypeError, ValueError):
        return '', 404
    data = tex_store.read_page(cache_token, number)
    if not data:
        return '', 404
    return send_file(io.BytesIO(data), mimetype='image/png')


@app.route('/history/<doc_id>/download')
def history_download(doc_id):
    """Download the .tex of one saved conversion."""
    item = _history_item(doc_id)
    if not item:
        return "That history item was not found.", 404
    return _tex_download(item.get('result'), item.get('fileName'), 'converted')


@app.route('/history/<doc_id>/tex')
def history_tex(doc_id):
    """The LaTeX of one saved conversion, for the Copy button."""
    item = _history_item(doc_id)
    if not item:
        return jsonify({'ok': False, 'error': 'Not found.'}), 404
    return jsonify({'ok': True, 'tex': item.get('result') or '',
                    'fileName': item.get('fileName') or 'document',
                    'truncated': _TRUNCATION_MARK in (item.get('result') or '')})


@app.route('/history/<doc_id>/preview.pdf')
def history_preview(doc_id):
    """Render one saved conversion to a PDF preview."""
    item = _history_item(doc_id)
    if not item:
        return preview_failure('That history item was not found.', 404)
    tex = item.get('result') or ''
    if _TRUNCATION_MARK in tex:
        return preview_failure(
            'This saved document was too long to store in full, so it cannot '
            'be compiled. Convert the original again to get a complete .tex.',
            422)
    return _compiled_pdf(tex, cache_token=_history_pdf_token(doc_id))


def _latest_token(source):
    """Most recent token in this session that came from the given pipeline."""
    for token in reversed(session.get('tex_tokens', [])):
        stored = tex_store.read(token)
        if stored and stored.get('source') == source:
            return token
    return None


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

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
