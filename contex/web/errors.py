"""
What a visitor sees when something goes wrong.

Every handler gives the same two things: a page in the application's own
shell, and nothing whatsoever about the cause. The detail goes to the log,
where it is useful and where it cannot hand a filesystem path, a stack frame
or a configuration value to whoever tripped it.
"""

from flask import Blueprint, redirect, render_template, session, url_for

from contex import config

bp = Blueprint('errors', __name__)



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


@bp.app_errorhandler(413)
def upload_too_large(_error):
    """Turn Werkzeug's 413 into the same in-page error the route uses."""
    session['convert_error'] = (f"That file is too large. The limit is "
                                f"{config.integer('MAX_UPLOAD_MB', 32)} MB.")
    return redirect(url_for('pages.home') + '#convert'), 302


@bp.app_errorhandler(404)
def not_found(_error):
    return _error_page(
        404, 'There is nothing here',
        'That address does not match any page in ConTeX. It may have been a '
        'link to a result that has since expired.')


@bp.app_errorhandler(429)
def too_many(_error):
    return _error_page(
        429, 'Too many requests',
        'Please wait a few minutes and try again.')


@bp.app_errorhandler(500)
def server_error(_error):
    # Werkzeug has already written the traceback to the log by this point, so
    # nothing is lost by telling the visitor as little as this does.
    return _error_page(
        500, 'Something went wrong on our side',
        'The conversion you were running was not saved. Nothing about your '
        'document was kept. Please try again.')
