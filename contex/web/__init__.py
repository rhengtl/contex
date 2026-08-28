"""
The HTTP layer: everything that knows a request is a request.

Five blueprints and three sets of request hooks, registered here so there is
exactly one place to look for "what URLs does this application answer, and what
does every response carry".

    pages      /  /history  /legal/<doc>  /accept-terms  /healthz
    convert    /convert  /api/ai-status
    output     /download-converted-tex  /preview/*  /history/<id>/*
    auth       /login  /signup  /forgot-password  /logout

    security      the CSP and its nonce, the fixed headers, the rate limit
    compression   gzip, and the ?v= stamp that makes static files cacheable
    session       who this visitor is and what they may fetch

The fifth blueprint, errors, carries no URLs of its own - it registers the
application-wide 413 / 404 / 429 / 500 handlers.

Blueprints rather than a shared `app` object: a module that imports the
application in order to decorate it cannot be imported without building the
application, which is what makes route code awkward to test and easy to
tangle. Here each module is importable on its own.
"""

from contex.web import compression, security, session
# `_bp` on each: binding the blueprint to the bare module name here would
# shadow the submodule, so `contex.web.errors` would resolve to a Blueprint
# rather than to the module that defines it.
from contex.web.auth import bp as auth_bp
from contex.web.convert import bp as convert_bp
from contex.web.errors import bp as errors_bp
from contex.web.output import bp as output_bp
from contex.web.pages import bp as pages_bp


def register(app):
    """Attach every blueprint and request hook to the application."""
    for hooks in (security, compression, session):
        hooks.install(app)

    for blueprint in (pages_bp, convert_bp, output_bp, auth_bp,
                      errors_bp):
        app.register_blueprint(blueprint)
