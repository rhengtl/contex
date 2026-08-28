"""
Every setting this application reads, in one place.

WHY THIS EXISTS. Configuration used to be read wherever it happened to be
needed: 49 `os.getenv` calls across 12 modules, with five separate
implementations of "read an integer from the environment" and three of "read a
boolean". Nothing said which settings existed, which were required, which were
development-only, or which were safe to put in front of a browser. The answer
was "read all twelve modules".

WHY THE READERS ARE LAZY. `flag()` and `integer()` read the environment at the
moment they are called, not at import. That is deliberate and load-bearing:
the test suite changes settings between tests (`AI_QA_ENABLED`, `UPLOAD_FOLDER`,
`GEMINI_PAID_TIER` and a dozen more) and expects the change to take effect. A
module that snapshots its configuration at import cannot be reconfigured, and a
module that cannot be reconfigured is hard to test.

Only the handful of values fixed for the life of the process - the debug flag,
the session secret - are resolved once, at the bottom of this file.

WHAT IS NOT HERE. Secrets are read through these functions but never stored,
logged or defaulted. `SETTINGS` below records that a value exists and what it
is for; it never records the value.
"""

import os

from dotenv import load_dotenv

# Read .env once, from the project root - the directory above this package.
# Passing the path explicitly rather than letting find_dotenv() search: since
# python-dotenv 1.2 the search starts from the calling file, which for a module
# inside a package is not where .env lives.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, '.env'))


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------

def text(name, default=None):
    """A string setting, or `default` when unset or blank."""
    value = os.getenv(name)
    return value if value not in (None, '') else default


def flag(name, default=False):
    """
    A boolean setting.

    Anything unset falls back to `default`; 1/true/yes/on are true and
    everything else is false. Note that this means an unrecognised value reads
    as false rather than as the default - a typo should not silently enable
    something.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def integer(name, default):
    """An integer setting. A value that will not parse falls back silently."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def decimal(name, default):
    """A float setting, with the same forgiving parse."""
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# What exists
# ---------------------------------------------------------------------------
#
# One row per setting: (name, scope, requirement, what it does).
#
#   scope        server   read only on the server; may be a secret
#                browser  rendered into a page, so public by definition
#                dev      only meaningful while developing
#   requirement  required / optional
#
# This is documentation that a test can read: tests/test_contex.py checks that
# every name here appears in .env.example, so the two cannot drift apart.

SETTINGS = [
    # --- the process ------------------------------------------------------
    ('FLASK_SECRET_KEY', 'server', 'required',
     'Signs the session cookie that carries the signed-in uid. No default: '
     'the app refuses to start in production without it.'),
    ('FLASK_DEBUG', 'dev', 'optional',
     'Off unless set. Turning it on also disables Secure cookies and HSTS.'),
    ('HOST', 'dev', 'optional', 'Development server bind address. Loopback by default.'),
    ('PORT', 'server', 'optional', 'Port to listen on. The platform usually sets it.'),
    ('TRUST_PROXY', 'server', 'optional',
     'Honour X-Forwarded-*. On in production, where something terminates TLS in front.'),
    ('UPLOAD_FOLDER', 'server', 'optional', 'Where generated results are kept.'),
    ('MAX_UPLOAD_MB', 'server', 'optional', 'Hard ceiling on the request body.'),
    ('MAX_IMAGE_PIXELS', 'server', 'optional',
     'Decoded-image ceiling, which the request size does not bound.'),
    ('RATE_LIMIT_CONVERT', 'server', 'optional', 'Conversions per caller per 5 minutes. 0 disables.'),
    ('RATE_LIMIT_AUTH', 'server', 'optional', 'Sign-in attempts per caller per 5 minutes. 0 disables.'),
    ('TERMS_VERSION', 'server', 'optional',
     'Bumping it asks every user to accept the terms again.'),

    # --- Firebase ---------------------------------------------------------
    ('FIREBASE_SERVICE_ACCOUNT_PATH', 'server', 'optional',
     'A downloaded admin key. Leave UNSET in production and let the platform '
     'supply credentials.'),
    ('FIREBASE_DATABASE_URL', 'server', 'optional',
     'Realtime Database only, which this app does not use.'),
    ('FIREBASE_API_KEY', 'browser', 'required',
     'The Web API key. Public by design, and also what the server uses to '
     'verify passwords and send reset emails.'),
    ('FIREBASE_AUTH_DOMAIN', 'browser', 'required',
     'Where the sign-in popup lives. The CSP is built from it.'),
    ('FIREBASE_PROJECT_ID', 'browser', 'required', 'Identifies the project.'),

    # --- the model --------------------------------------------------------
    ('GEMINI_API_KEY', 'server', 'required',
     'Server-side only. Without it every conversion takes the local path.'),
    ('GOOGLE_API_KEY', 'server', 'optional', 'Alternative name for the same key.'),
    ('GEMINI_PAID_TIER', 'server', 'optional',
     'Free tier trains on submitted documents; this changes the disclosure shown.'),
    ('ANTHROPIC_API_KEY', 'server', 'optional', 'The opt-in second provider.'),
    ('ANTHROPIC_AUTH_TOKEN', 'server', 'optional', 'Alternative to the above.'),
    ('AI_QA_ENABLED', 'server', 'optional', 'Switch the model off entirely.'),
    ('AI_FIRST', 'server', 'optional', 'Force the local path for every conversion.'),
    ('AI_QA_PROVIDER', 'server', 'optional', 'gemini | anthropic.'),
    ('AI_QA_MODEL', 'server', 'optional', 'Preferred model for every role.'),
    ('AI_QA_MODEL_DOCUMENT', 'server', 'optional', 'Preferred model for reading a page.'),
    ('AI_QA_THINKING', 'server', 'optional', 'How hard the model thinks.'),
    ('AI_QA_THINKING_DOCUMENT', 'server', 'optional', 'Per-role override of the above.'),
    ('AI_QA_EFFORT', 'server', 'optional', 'Legacy alias for thinking (Claude).'),
    ('AI_QA_TEMPERATURE', 'server', 'optional', '0 keeps conversions deterministic.'),
    ('AI_QA_MAX_TOKENS', 'server', 'optional', 'Output ceiling per call.'),
    ('AI_QA_MAX_API_CALLS', 'server', 'optional', 'Calls per conversion unit.'),
    ('AI_QA_MAX_UPLOAD_MB', 'server', 'optional', 'Larger files convert locally instead.'),
    ('AI_QA_MAX_PDF_PAGES', 'server', 'optional', 'Pages of a PDF sent to the model.'),
    ('AI_QA_PAGE_CONCURRENCY', 'server', 'optional', 'Pages sent at once.'),
    ('AI_QA_RETRY_ATTEMPTS', 'server', 'optional', 'Retries on a 429 or an upstream 5xx.'),
    ('AI_QA_REQUEST_TIMEOUT', 'server', 'optional', 'Seconds before a model call is abandoned.'),
    ('AI_QA_ENABLE_COMPILE', 'server', 'optional', 'Compile the result and repair once.'),
    ('AI_QA_ENABLE_FALLBACKS', 'server', 'optional', 'Claude server-side refusal fallbacks.'),
    ('AI_OUTAGE_ASSUME_SECONDS', 'server', 'optional', 'How long a remembered outage lasts.'),

    # --- the local pipeline -----------------------------------------------
    ('TESSERACT_CMD', 'server', 'optional', 'Pin an explicit Tesseract binary.'),
    ('OCR_PREPROCESS', 'server', 'optional', 'Deskew, EXIF rotation, upscale, flatten alpha.'),
    ('UNIFIED_MAX_PDF_PAGES', 'server', 'optional', 'Pages rasterised from a PDF.'),
    ('UNIFIED_CONF_FLOOR', 'server', 'optional',
     'Tesseract confidence below which a region is treated as mathematics.'),
    ('EQUATION_MAX_REGIONS', 'server', 'optional', 'Most equations detected on one page.'),

    # --- LaTeX ------------------------------------------------------------
    ('LATEX_CMD', 'server', 'optional', 'Pin an explicit TeX engine.'),
    ('LATEX_COMPILE_TIMEOUT', 'server', 'optional', 'Seconds before a compile is abandoned.'),
    ('LATEX_ALLOW_FILE_ACCESS', 'server', 'optional',
     'Removes the guard that stops a document reading files. Do not set this.'),
    ('PREVIEW_DPI', 'server', 'optional', 'Resolution of the preview page images.'),
    ('TEX_STORE_TTL_SECONDS', 'server', 'optional', 'How long a generated result is kept.'),
]

#: The settings that are rendered into a page, and are therefore public. Every
#: other name above must never reach the browser - tests check both directions.
BROWSER_SAFE = frozenset(name for name, scope, _r, _d in SETTINGS
                         if scope == 'browser')

#: Settings without which the application cannot do its job.
REQUIRED = frozenset(name for name, _s, req, _d in SETTINGS
                     if req == 'required')


# ---------------------------------------------------------------------------
# Fixed for the life of the process
# ---------------------------------------------------------------------------

#: Debug is OFF unless something asks for it. It used to default to True,
#: which meant a deployment that simply forgot to set it shipped the Werkzeug
#: debugger - an interactive Python console on a public URL.
DEBUG = flag('FLASK_DEBUG', False)

#: Everything that is not a debug run is production. Keying it off the existing
#: switch rather than a new variable means a local .env that already says
#: FLASK_DEBUG=True keeps behaving as it does now, while a host that sets
#: nothing gets the safe behaviour rather than the convenient one.
IS_PRODUCTION = not DEBUG


def browser_firebase():
    """
    The three Firebase settings the browser SDK needs, or None.

    Public by design - they identify the project, they are not credentials,
    and the security rules are what actually protect the data. Nothing else
    from the service account ever reaches a page.
    """
    settings = {
        'apiKey': text('FIREBASE_API_KEY'),
        'authDomain': text('FIREBASE_AUTH_DOMAIN'),
        'projectId': text('FIREBASE_PROJECT_ID'),
    }
    return settings if all(settings.values()) else None
