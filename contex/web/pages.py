"""
The pages a person navigates to.

Thin by design: each one gathers what a template needs and renders it. The
decisions live behind them - whether the terms are accepted is session.py,
whether a result belongs to this visitor is session.py, what a conversion
produced is the pipeline. A route that starts making decisions is a route that
has taken work from a layer that can be tested without a browser.
"""

from flask import (Blueprint, jsonify, redirect, render_template, request,
                   session, url_for)

from contex.data import history as history_store
from contex.data import users
from contex.pipeline import latex
from contex.pipeline.inputs import ACCEPTED_EXTENSIONS
from contex.pipeline.recognise import ai
from contex.services.llm import availability
from contex.web.session import (TERMS_VERSION, current_user_uid, owned_tex,
                                terms_accepted)

bp = Blueprint('pages', __name__)



# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@bp.route('/', methods=['GET'])
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
                           ai=availability.check(),
                           qa=ai.provider_info(),
                           latex_engine=latex.engine_name(latex.find_engine()))


# How many saved conversions the history page lists.
HISTORY_PAGE_LIMIT = 20


@bp.route('/history')
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
    history = (history_store.recent(uid, limit=HISTORY_PAGE_LIMIT)
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


@bp.route('/legal/<document>')
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


@bp.route('/accept-terms', methods=['POST'])
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
        users.set_terms_accepted(uid, TERMS_VERSION)
    return jsonify({'ok': True, 'version': TERMS_VERSION})


@bp.route('/index')
def index():
    return redirect(url_for('pages.home'))


@bp.route('/healthz')
def healthz():
    """
    Liveness for the platform's health check.

    Deliberately shallow: it says this process can serve a request, and
    nothing about Firestore or the model. A health check that calls out to a
    dependency turns that dependency's bad minute into a restart loop, which
    is worse than serving the degraded behaviour the app already handles.
    """
    return jsonify({'ok': True}), 200
