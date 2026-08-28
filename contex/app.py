"""
Building the application.

Everything that turns configuration into a running Flask app: the session
secret, the cookie policy, the proxy trust, and the blueprint registration
that pulls in contex.web.

Deliberately not contex/__init__.py. A package root that imports its own
subpackages, while those subpackages import names back from the root, works
only because of the order things happen to be bound in - and breaks the first
time someone adds an import at the top of a web module. With the construction
here, `contex` itself does nothing and there is no cycle to get wrong.
"""

import os

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from contex import config

#: templates/ and static/ sit beside the package rather than inside it, so the
#: frontend is visible at the top of the repository instead of three
#: directories down. Flask is told where they are rather than guessing.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(_ROOT, 'templates'),
    static_folder=os.path.join(_ROOT, 'static'),
)

# ---------------------------------------------------------------------------
# The session secret
# ---------------------------------------------------------------------------
# The session cookie carries the signed-in user's uid (see web/session.py), and
# Flask's cookie is signed, not encrypted. Whoever knows this key can mint a
# cookie for any account. It therefore has no usable default: in production a
# missing key is a hard failure, because the previous fallback of
# 'supersecretkey' is public knowledge in every copy of this source and would
# have made every account forgeable.
_secret = config.text('FLASK_SECRET_KEY')
if not _secret:
    if config.IS_PRODUCTION:
        raise RuntimeError(
            "FLASK_SECRET_KEY is not set. It signs the session cookie that "
            "carries the signed-in user's id, so without one of your own "
            "anyone could forge a session for any account. Generate one with: "
            "python -c \"import secrets; print(secrets.token_hex(32))\"")
    # A debug run gets a throwaway key so the app still starts. It changes on
    # every restart, so sessions do not survive one - which is the correct
    # nuisance: a reminder to set a real key, not a default.
    import secrets as _secrets
    _secret = _secrets.token_hex(32)
    print("WARNING: FLASK_SECRET_KEY is not set. Using a random key for this "
          "debug run; sessions will not survive a restart.")
app.secret_key = _secret

app.config.update(
    # Never readable from JavaScript: an XSS bug should not also be a session
    # theft. (Flask's default, made explicit so it cannot be lost silently.)
    SESSION_COOKIE_HTTPONLY=True,
    # Lax is what stops a cross-site form posting to /convert, /login or
    # /accept-terms with the visitor's cookie attached. The app has no
    # cross-site POST of its own - the Google sign-in popup hands its ID token
    # to a same-site form - so this costs nothing and removes the CSRF class.
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=config.IS_PRODUCTION,
    PERMANENT_SESSION_LIFETIME=__import__('datetime').timedelta(days=30),
    # Hard ceiling on request size: an oversized body is refused before any
    # converter or model sees it.
    MAX_CONTENT_LENGTH=config.integer('MAX_UPLOAD_MB', 32) * 1024 * 1024,
    # Static URLs carry a ?v= stamp that changes when the file does, so they
    # can be cached hard and for a long time.
    SEND_FILE_MAX_AGE_DEFAULT=31536000,
    UPLOAD_FOLDER=config.text('UPLOAD_FOLDER', 'uploads'),
)
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Behind Firebase Hosting -> Cloud Run (or any other reverse proxy) the request
# arrives over plain HTTP with the real scheme, host and client address in
# X-Forwarded-* headers. Without this, url_for(_external=True) builds http://
# links and the rate limiter sees every request as coming from the proxy. Only
# ever trust these headers when something really is in front: on a directly
# exposed server a client can send them itself.
if config.flag('TRUST_PROXY', config.IS_PRODUCTION):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# Imported here rather than at the top because they import `app`'s package in
# turn; registering them is the last step of building the application.
def _register():
    from contex.web import register
    register(app)


_register()
