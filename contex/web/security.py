"""
What every response carries, and what a caller is allowed to ask for.

Three concerns that attach to the request cycle rather than to any one route:
the Content-Security-Policy and its per-request nonce, the fixed security
headers, and the per-caller brake on the two route groups that cost something.

Deliberately not in the route modules. A policy applied in some routes and
forgotten in others is a policy with a hole in it; applied here, a new route
cannot forget it.
"""

import secrets
import threading
import time
from collections import deque

from flask import g, request

from contex import config



# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------

# The Firebase Auth popup runs on the project's auth domain, and the browser
# SDK is loaded from gstatic. Both have to be named explicitly, because the
# policy below is default-deny.
_AUTH_DOMAIN = config.text('FIREBASE_AUTH_DOMAIN', '')
_FIREBASE_ORIGINS = ' '.join(filter(None, [
    'https://www.gstatic.com',                    # the browser SDK itself
    'https://apis.google.com',                    # the sign-in iframe
    f'https://{_AUTH_DOMAIN}' if _AUTH_DOMAIN else '',
]))

# What the pages actually need, and nothing else.
#
# There is no 'unsafe-inline' in script-src, and that is the whole point of
# this policy rather than a detail of it. An injected <script> or
# <img onerror=...> does not run, because the only inline scripts that execute
# are the three that carry this request's nonce - a value the attacker cannot
# know, because it is new on every response.
#
# Getting here meant removing all 40 inline on*= handlers from the templates,
# since no nonce and no hash can cover an attribute handler; markup now uses
# data-action and scripts.js dispatches it. A nonce also silently overrides
# 'unsafe-inline' in any browser that understands both, so the two could never
# have coexisted anyway: adding the nonce alone would have broken every one of
# those handlers.
#
# style-src has no 'unsafe-inline' either. Nothing sets a style attribute -
# not the templates, and not scripts.js, which changes .style properties
# through the CSSOM, which CSP does not govern.
def _csp(nonce):
    return "; ".join([
        "default-src 'self'",
        f"script-src 'self' 'nonce-{nonce}' {_FIREBASE_ORIGINS}".rstrip(),
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        # blob: for the camera preview, the canvas export and the opened PDF;
        # data: for the small inline marks.
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        # The preview iframe points at this app; sign-in opens Google's.
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


def make_nonce():
    """
    A fresh nonce for this request's inline scripts.

    New every time, from the same source as the session token, and never
    reused: a nonce an attacker could predict is a nonce that lets injected
    script run, which would give back exactly what removing 'unsafe-inline'
    bought.
    """
    g.csp_nonce = secrets.token_urlsafe(16)


def nonce_for_templates():
    """Expose it so a template can mark its own inline script as ours."""
    return {'csp_nonce': getattr(g, 'csp_nonce', '')}


def security_headers(response):
    """
    The headers a browser needs in order to defend this app for us.

    Set on every response rather than on the HTML routes only: a policy that
    applies to some responses is a policy with a gap in it, and the cost on a
    PNG is a few dozen bytes.
    """
    headers = response.headers
    headers.setdefault('Content-Security-Policy',
                       _csp(getattr(g, 'csp_nonce', '')))
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
    if config.IS_PRODUCTION:
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
    'convert': (config.integer('RATE_LIMIT_CONVERT', 30), 300),
    # Firebase throttles password attempts itself; this stops the traffic
    # before it becomes our bill and their quota.
    'auth': (config.integer('RATE_LIMIT_AUTH', 20), 300),
}


def _caller():
    """Best available identity for rate limiting: the client address."""
    return request.remote_addr or 'unknown'


def rate_limited(group):
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


def install(app):
    """Attach these hooks to an application."""
    app.before_request(make_nonce)
    app.context_processor(nonce_for_templates)
    app.after_request(security_headers)
