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
import secrets
import threading
import time
from collections import deque
from datetime import timedelta

from flask import (Flask, jsonify, request, render_template, redirect,
                   url_for, send_file, session)
from werkzeug.middleware.proxy_fix import ProxyFix
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


def _flag(name, default=False):
    """Read a boolean setting. Anything unset falls back to `default`."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


# Debug is OFF unless something asks for it. It used to default to True, which
# meant a deployment that simply forgot to set FLASK_DEBUG shipped the Werkzeug
# debugger - an interactive Python console on a public URL.
DEBUG = _flag('FLASK_DEBUG', False)

# Everything that is not a debug run is treated as production. Keying it off
# the existing switch rather than a new variable means a local .env that
# already says FLASK_DEBUG=True keeps behaving exactly as it does now, while a
# host that sets nothing gets the safe behaviour rather than the convenient one.
IS_PRODUCTION = not DEBUG

# Initialize Flask app
app = Flask(__name__)

# ---------------------------------------------------------------------------
# The session secret
# ---------------------------------------------------------------------------
# The session cookie is what carries the signed-in user's uid (see
# current_user_uid), and Flask's cookie is signed, not encrypted. Whoever knows
# this key can mint a cookie for any account. It therefore has no usable
# default: in production a missing key is a hard failure, because the previous
# fallback of 'supersecretkey' is public knowledge in every copy of this
# source and would have made every account forgeable.
_secret = os.getenv('FLASK_SECRET_KEY')
if not _secret:
    if IS_PRODUCTION:
        raise RuntimeError(
            "FLASK_SECRET_KEY is not set. It signs the session cookie that "
            "carries the signed-in user's id, so without one of your own "
            "anyone could forge a session for any account. Generate one with: "
            "python -c \"import secrets; print(secrets.token_hex(32))\"")
    # A debug run gets a throwaway key so `python app.py` still starts. It
    # changes on every restart, so sessions do not survive one - which is the
    # correct nuisance: it is a reminder to set a real key, not a default.
    _secret = secrets.token_hex(32)
    print("WARNING: FLASK_SECRET_KEY is not set. Using a random key for this "
          "debug run; sessions will not survive a restart.")
app.secret_key = _secret

app.config.update(
    # Never readable from JavaScript: an XSS bug should not also be a session
    # theft. (Flask's default, made explicit so it cannot be lost silently.)
    SESSION_COOKIE_HTTPONLY=True,
    # Lax is what stops a cross-site form from posting to /convert, /login or
    # /accept-terms with the visitor's cookie attached. The app has no
    # cross-site POST of its own - the Google sign-in popup hands its ID token
    # to a same-site form - so this costs nothing and removes the CSRF class.
    SESSION_COOKIE_SAMESITE='Lax',
    # Only sent over HTTPS in production. Off in debug so http://localhost
    # still works.
    SESSION_COOKIE_SECURE=IS_PRODUCTION,
    # "Remember me" is a month, not Flask's default 31 days of silence about
    # what it is. Stated here so the answer is in one place.
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# Behind Firebase Hosting -> Cloud Run (or any other reverse proxy) the request
# reaches this process over plain HTTP with the real scheme, host and client
# address in X-Forwarded-* headers. Without this, url_for(_external=True)
# builds http:// links and the rate limiter sees every request as coming from
# the proxy. Only ever trust these headers when something is actually in front
# of the app: on a directly-exposed server a client can send them itself.
if _flag('TRUST_PROXY', IS_PRODUCTION):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

app.config['UPLOAD_FOLDER'] = os.getenv('UPLOAD_FOLDER', 'uploads')  # Optional: if you want to save uploads
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True) # Create upload folder if it doesn't exist

# Hard ceiling on request size. This stops an oversized body from being
# buffered at all, before any converter or model sees it.
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


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------

# The Firebase Auth popup runs on the project's auth domain, and the browser
# SDK is loaded from gstatic. Both have to be named explicitly, because the
# policy below is default-deny.
_AUTH_DOMAIN = os.getenv('FIREBASE_AUTH_DOMAIN', '')
_FIREBASE_ORIGINS = ' '.join(filter(None, [
    'https://www.gstatic.com',                    # the browser SDK itself
    'https://apis.google.com',                    # the sign-in iframe
    f'https://{_AUTH_DOMAIN}' if _AUTH_DOMAIN else '',
]))

# What the pages actually need, and nothing else.
#
# 'unsafe-inline' in script-src is the one weakness here and it is not an
# oversight: the templates use inline onclick= handlers, which no nonce or hash
# can cover - only 'unsafe-hashes' or moving them to addEventListener. Removing
# it is a real piece of work on the front end rather than a header change, so
# it is written down in DEPLOYMENT.md instead of quietly claimed.
_CSP = "; ".join([
    "default-src 'self'",
    f"script-src 'self' 'unsafe-inline' {_FIREBASE_ORIGINS}".rstrip(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    # blob: for the camera preview, the canvas export and the opened PDF;
    # data: for the small inline marks.
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    # The preview iframe points at this app; the sign-in flow opens Google's.
    f"frame-src 'self' blob: {_FIREBASE_ORIGINS}".rstrip(),
    # Where fetch() may go: this app, and the Firebase Auth endpoints the
    # browser SDK calls directly.
    "connect-src 'self' https://identitytoolkit.googleapis.com "
    "https://securetoken.googleapis.com https://www.googleapis.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.after_request
def security_headers(response):
    """
    The headers a browser needs in order to defend this app for us.

    Set on every response rather than on the HTML routes only: a policy that
    applies to some responses is a policy with a gap in it, and the cost on a
    PNG is a few dozen bytes.
    """
    headers = response.headers
    headers.setdefault('Content-Security-Policy', _CSP)
    # Never let a browser guess that a .tex or a stored page image is HTML.
    headers.setdefault('X-Content-Type-Options', 'nosniff')
    # frame-ancestors above is the real control; this is for older browsers.
    headers.setdefault('X-Frame-Options', 'DENY')
    # A converted document's URL should not travel to another site.
    headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    # The app asks for the camera itself and needs nothing else.
    headers.setdefault('Permissions-Policy',
                       'camera=(self), microphone=(), geolocation=(), '
                       'payment=(), usb=(), interest-cohort=()')
    if IS_PRODUCTION:
        # Only meaningful over HTTPS, and only safe once the deployment really
        # is HTTPS-only - which Firebase Hosting and Cloud Run both are.
        headers.setdefault('Strict-Transport-Security',
                           'max-age=31536000; includeSubDomains')
    return response


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------
#
# SCOPE, honestly stated: this counts requests inside ONE process. Under
# gunicorn with N workers a caller effectively gets N times the allowance, and
# on a platform that runs several instances it multiplies again. It is a brake
# on the obvious abuse - a script hammering /convert, which costs an API call,
# a LaTeX compile and a rasterise every time - not a defence against a
# distributed attacker. A shared counter (Redis, or Cloud Armor in front of
# the service) is what that would take; see DEPLOYMENT.md.
#
# It is still worth having: the expensive route is open to anonymous callers by
# design, and without any limit one loop can spend the whole Gemini free tier
# and pin every worker on pdflatex.

_RATE_BUCKETS = {}
_RATE_LOCK = threading.Lock()

# (requests, seconds) per caller, per route group. Set either to 0 to turn
# that group's limit off - which the test suite does, because it runs far more
# conversions in five minutes than any person would.
_RATE_LIMITS = {
    # A conversion is the expensive one: a model call plus a compile. Thirty
    # in five minutes is well above anyone working through a stack of pages by
    # hand and well below what a script would want.
    'convert': (int(os.getenv('RATE_LIMIT_CONVERT', '30')), 300),
    # Firebase throttles password attempts itself; this stops the traffic
    # before it becomes our bill and their quota.
    'auth': (int(os.getenv('RATE_LIMIT_AUTH', '20')), 300),
}


def _caller():
    """Best available identity for rate limiting: the client address."""
    return request.remote_addr or 'unknown'


def _rate_limited(group):
    """
    True when this caller has used up `group`'s allowance.

    A sliding window of timestamps rather than a counter with a reset, so a
    caller cannot get a full fresh allowance by waiting for a tick boundary.
    """
    allowance, window = _RATE_LIMITS[group]
    if allowance <= 0:
        return False
    now = time.monotonic()
    key = (group, _caller())
    with _RATE_LOCK:
        # Evict callers who have gone quiet, so this cannot grow without bound.
        if len(_RATE_BUCKETS) > 4096:
            for stale in [k for k, v in _RATE_BUCKETS.items()
                          if not v or now - v[-1] > window]:
                _RATE_BUCKETS.pop(stale, None)
        seen = _RATE_BUCKETS.setdefault(key, deque())
        while seen and now - seen[0] > window:
            seen.popleft()
        if len(seen) >= allowance:
            return True
        seen.append(now)
        return False


# Bump this whenever the terms or privacy policy change materially. Everyone -
# including users who already accepted an older version - is then asked again.
# It is deliberately not a date alone: the version is what was agreed to.
TERMS_VERSION = os.getenv('TERMS_VERSION', '1.0-2026-08-24')

# Extensions the upload control accepts, in one place so the route, the drop
# area and the file picker cannot drift apart.
ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif',
                       '.webp', '.gif', '.pdf', '.docx']


@app.context_processor
def shell_context():
    """
    What the application shell needs on every page.

    The header, the footer and the base template are on every route,
    including the ones that never thought about them - the auth pages had no
    header at all and no way back to the app except the browser's own back
    button. Injecting this here means a new route cannot forget it.
    """
    return {
        'is_authenticated': bool(current_user_uid()),
        'max_upload_mb': _MAX_UPLOAD_MB,
    }


@app.errorhandler(413)
def upload_too_large(_error):
    """Turn Werkzeug's 413 into the same in-page error the route uses."""
    session['convert_error'] = (f"That file is too large. The limit is "
                                f"{_MAX_UPLOAD_MB} MB.")
    return redirect(url_for('home') + '#convert'), 302


def _error_page(code, heading, message):
    """
    One error, rendered in the application's own shell.

    Nothing about the cause reaches the visitor - not a stack frame, not a
    path, not a configuration value. Flask's built-in pages are already safe
    in that respect; this exists so a wrong turn does not also look like a
    different, broken website, and so there is a way back rather than only the
    browser's back button.

    Falls back to plain text if even the shell cannot render, which is the one
    case where a template is the least trustworthy thing available.
    """
    try:
        return render_template('error.html', code=code, heading=heading,
                               message=message), code
    except Exception:
        return f'{code} {heading}. {message}', code


@app.errorhandler(404)
def not_found(_error):
    return _error_page(
        404, 'There is nothing here',
        'That address does not match any page in ConTeX. It may have been a '
        'link to a result that has since expired.')


@app.errorhandler(429)
def too_many(_error):
    return _error_page(
        429, 'Too many requests',
        'Please wait a few minutes and try again.')


@app.errorhandler(500)
def server_error(_error):
    # Werkzeug has already written the traceback to the log by this point, so
    # nothing is lost by telling the visitor as little as this does.
    return _error_page(
        500, 'Something went wrong on our side',
        'The conversion you were running was not saved. Nothing about your '
        'document was kept. Please try again.')

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


def _start_session(uid, email, display_name, remember=False):
    """
    Begin a signed-in session, discarding whatever the visitor had before.

    Everything from the previous session goes - the generated-result tokens
    above all. On a shared computer the person signing in is not necessarily
    the person who was just using it, and a token left in the cookie would let
    them download the document that person converted.
    """
    session.clear()
    session['user'] = {'uid': uid, 'email': email, 'displayName': display_name}
    session.permanent = bool(remember)


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

    # One-shot flag set by a conversion POST. It survives exactly one redirect,
    # so the browser can tell the Post/Redirect/Get landing apart from an
    # ordinary load and never wipe a guest's history on the very hop that just
    # added to it. What a plain load does is decided in the browser, where the
    # navigation type is actually known - see the guest history section of
    # scripts.js.
    keep_guest_history = session.pop('just_processed', False)

    return render_template('home.html',
                           convert_result=convert_result,
                           convert_token=convert_token if convert_result else None,
                           show_convert_result=show_convert_result,
                           convert_error=convert_error,
                           convert_blocked=convert_blocked,
                           keep_guest_history=keep_guest_history,
                           accepted_extensions=ACCEPTED_EXTENSIONS,
                           terms_version=TERMS_VERSION,
                           has_accepted_terms=terms_accepted(),
                           ai=ai_status.check(),
                           qa=ai_qa.provider_info(),
                           latex_engine=latex_tools.engine_name(
                               latex_tools.find_engine()))


# How many saved conversions the history page lists.
HISTORY_PAGE_LIMIT = 20


@app.route('/history')
def history_page():
    """
    Past conversions.

    Signed in -> read the persistent list back from Firestore.
    Guest     -> nothing server-side; the browser holds its own list in
                 sessionStorage and scripts.js renders it into this page.

    Its own route rather than a section of the workspace: reaching a past
    conversion used to mean scrolling past the entire converter, and after a
    conversion the page scrolled itself to the result, leaving history
    off-screen. It also means the workspace no longer queries Firestore on
    every single visit in order to render something below the fold.
    """
    uid = current_user_uid()
    history = (firebase_config.get_user_ocr_history(uid, limit=HISTORY_PAGE_LIMIT)
               if uid else [])
    for item in history:
        # Recorded when the row was written. Rows saved before that field
        # existed simply do not claim to be truncated; opening one still gets
        # the accurate explanation, because the routes that compile or copy a
        # document read the document itself and check it there.
        item['truncated'] = bool(item.get('truncated'))

    return render_template('history.html',
                           history=history,
                           history_limit=HISTORY_PAGE_LIMIT)


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

    if _rate_limited('convert'):
        session['convert_error'] = (
            'That is a lot of conversions in a short time. Please wait a few '
            'minutes and try again.')
        return redirect(url_for('home') + '#convert')

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
    record_history(file.filename, result['tex'])

    token = remember_tex({
        'tex': result['tex'],
        'file_name': file.filename,
        'source': 'convert',
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
    """
    The record of how a conversion went, minus credentials and bulk.

    The page does not render any of this - the counts and the quality report
    were both taken off the result UI deliberately, because the preview shows
    the document better than a report describes it. It is still stored, so a
    conversion can be accounted for afterwards: which model produced it,
    whether it compiled, what the engine said if it did not, what it cost, and
    any repair that was made along the way.
    """
    return {
        'status': review['status'],
        'message': review['message'],
        'findings': review['findings'],
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

def _browser_firebase_config():
    """
    The Firebase settings the browser SDK needs, or None if not configured.

    These three are public by design - they identify the project, they are not
    credentials, and Firebase security rules are what actually protect the
    data. Nothing else from the service account ever reaches a page.

    Both auth pages get this, so the federated sign-in button is real on
    each. The sign-up page previously rendered its Google and Facebook buttons
    without ever being given a config or a click handler, so both were inert.
    """
    settings = {
        'apiKey': os.getenv('FIREBASE_API_KEY'),
        'authDomain': os.getenv('FIREBASE_AUTH_DOMAIN'),
        'projectId': os.getenv('FIREBASE_PROJECT_ID'),
    }
    return settings if all(settings.values()) else None


@app.route('/login', methods=['GET', 'POST'])
def login():
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('home'))

    def page(**context):
        # Every render needs the browser Firebase config, including the ones
        # carrying an error - otherwise a mistyped password makes the Google
        # sign-in button vanish from the page it was just on.
        return render_template('auth/login.html',
                               firebase_config=_browser_firebase_config(),
                               **context)

    if request.method == 'POST':
        if _rate_limited('auth'):
            return page(error='Too many sign-in attempts. Please wait a few '
                              'minutes and try again.'), 429

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

                    _start_session(user['uid'], user['email'],
                                   user['displayName'], remember=True)
                    return redirect(url_for('home'))

            return page(error="Authentication failed"), 401

        # Regular email/password login
        email = request.form.get('email')
        password = request.form.get('password')
        remember = request.form.get('remember')

        if not email or not password:
            return page(error="Please provide email and password"), 400

        # Verify user with Firebase
        result = firebase_config.verify_user(email, password)

        if result['success']:
            user = result['user']
            _start_session(user.uid, user.email, user.display_name,
                           remember=bool(remember))
            return redirect(url_for('home'))

        return page(error=result.get('error', 'Invalid credentials')), 401

    return page()


@app.route('/signup', methods=['GET', 'POST'])
def signup():
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('home'))

    def page(**context):
        # Every render needs the browser Firebase config, including the ones
        # that come back carrying a validation error - otherwise the federated
        # sign-in button disappears the moment you get something wrong.
        return render_template('auth/signup.html',
                               firebase_config=_browser_firebase_config(),
                               **context)

    if request.method == 'POST':
        fullname = request.form.get('fullname')
        email = request.form.get('email')
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')
        terms = request.form.get('terms')

        # Basic validation
        if not all([fullname, email, password, confirm_password]):
            return page(error="All fields are required")

        if password != confirm_password:
            return page(error="Passwords do not match")

        if len(password) < 6:
            return page(error="Password must be at least 6 characters")

        if not terms:
            return page(error="You must agree to the terms and conditions")

        # Create user in Firebase
        result = firebase_config.create_user(email, password, fullname)

        if result['success']:
            return page(success="Account created successfully! Please login.")
        return page(error=result.get('error', 'Failed to create account'))

    return page()


@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        # Same allowance as signing in. Without it this form is a free way to
        # send mail to any address, over and over.
        if _rate_limited('auth'):
            return render_template(
                'auth/forgot_password.html',
                error='Too many requests. Please wait a few minutes and try '
                      'again.'), 429

        email = request.form.get('email')

        if not email:
            return render_template('auth/forgot_password.html', error="Please provide your email address")

        # Firebase composes and sends the email itself; nothing here handles
        # the link, and nothing writes it to a log.
        result = firebase_config.send_password_reset(email)

        if result['success']:
            # Deliberately the same answer whether or not the address is
            # registered, so this form cannot be used to find out who is.
            return render_template('auth/forgot_password.html',
                                 success="If an account exists with that email, you will receive a password reset link.")
        else:
            return render_template('auth/forgot_password.html',
                                 error=result.get('error', 'An error occurred'))

    return render_template('auth/forgot_password.html')


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    """
    Sign out and drop the whole session.

    GET is kept because the header links to it and a link is what people
    expect; SameSite=Lax already stops another site from triggering it with
    the visitor's cookie, which is the only thing a cross-site logout could
    achieve here.
    """
    session.clear()
    return redirect(url_for('login'))


@app.route('/index')
def index():
    return redirect(url_for('home'))


@app.route('/healthz')
def healthz():
    """
    Liveness for the platform's health check.

    Deliberately shallow: it says this process can serve a request, and
    nothing about Firestore or the model. A health check that calls out to a
    dependency turns that dependency's bad minute into a restart loop, which
    is worse than serving the degraded behaviour the app already handles.
    """
    return jsonify({'ok': True}), 200


if __name__ == "__main__":
    # Development entry point only. In production the app is served by
    # gunicorn (see the Dockerfile), which imports `app` from this module and
    # never runs this block - so the debugger cannot be switched on by
    # accident there.
    port = int(os.getenv("PORT", 5000))
    # Loopback by default. This used to bind 0.0.0.0, which with the debugger
    # on put an interactive Python console on every network the machine was
    # attached to. Set HOST=0.0.0.0 when you actually want to reach the dev
    # server from a phone on the same wifi.
    app.run(debug=DEBUG, host=os.getenv("HOST", "127.0.0.1"), port=port)
