"""
Getting the result out: the .tex, the compiled PDF, and the page images.

Every route here answers the same question first - does this document belong
to whoever is asking? - and the answer comes from session.py, never from the
request. A token names a result the session generated; a doc id names a saved
conversion whose owner is checked in Firestore. Neither is trusted on its own.

The preview is served as page images rather than as a PDF on purpose. A
browser hands an application/pdf response to its own viewer, or to a download
manager extension, before the page can display it - so the one thing a
preview cannot be made of is a PDF.
"""

import io
import os

from flask import (Blueprint, jsonify, render_template, request, send_file)
from werkzeug.utils import secure_filename

from contex.data import results as result_store
from contex.pipeline import latex
from contex.web.session import (TRUNCATION_MARK, history_item,
                                history_pdf_token, latest_token,
                                owned_tex)

bp = Blueprint('output', __name__)



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


@bp.route('/download-converted-tex')
def download_converted_tex():
    """
    Download a generated .tex, but only for the session that generated it.

    The file is streamed from memory so no extra copy is left in the upload
    folder, and an unknown or expired token is a 404 rather than someone else's
    document.
    """
    token = request.args.get('token') or latest_token('convert')
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
        cached = result_store.read_pdf(cache_token)
        if cached:
            return cached, None

    result = latex.compile_tex(tex, want_pdf=True)
    if result['ok'] and result.get('pdf'):
        if cache_token:
            result_store.save_pdf(cache_token, result['pdf'])
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


@bp.route('/preview.pdf')
def preview_pdf():
    """Render this session's generated .tex to a PDF for the in-page preview."""
    token = request.args.get('token') or latest_token('convert')
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
        item = history_item(doc_id)
        if not item:
            return None, None, ('That history item was not found.', 404)
        tex = item.get('result') or ''
        if TRUNCATION_MARK in tex:
            return None, None, (
                'This saved document was too long to store in full, so it '
                'cannot be compiled. Convert the original again to get a '
                'complete .tex.', 422)
        return tex, history_pdf_token(doc_id), None

    token = request.args.get('token') or latest_token('convert')
    job = owned_tex(token)
    if not job:
        return None, None, ('That preview has expired or does not belong to '
                            'this session. Please convert again.', 404)
    return job['tex'], token, None


@bp.route('/preview/pages')
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

    cached = result_store.count_pages(cache_token)
    if cached:
        return jsonify({'ok': True, 'pages': cached})

    pdf, failure = _preview_pdf_bytes(tex, cache_token)
    if failure:
        reason, status, errors, missing = failure
        return jsonify({'ok': False, 'reason': reason, 'errors': errors,
                        'missing_packages': missing}), status

    pages, error = latex.render_pages(pdf)
    if error:
        return jsonify({'ok': False, 'reason': error, 'errors': '',
                        'missing_packages': []}), 503

    written = result_store.save_pages(cache_token, pages)
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


@bp.route('/preview/document')
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


@bp.route('/preview/page.png')
def preview_page():
    """One rendered page, as a plain image."""
    _tex, cache_token, failure = _preview_target()
    if failure:
        return '', 404
    try:
        number = int(request.args.get('n', '1'))
    except (TypeError, ValueError):
        return '', 404
    data = result_store.read_page(cache_token, number)
    if not data:
        return '', 404
    return send_file(io.BytesIO(data), mimetype='image/png')


@bp.route('/history/<doc_id>/download')
def history_download(doc_id):
    """Download the .tex of one saved conversion."""
    item = history_item(doc_id)
    if not item:
        return "That history item was not found.", 404
    return _tex_download(item.get('result'), item.get('fileName'), 'converted')


@bp.route('/history/<doc_id>/tex')
def history_tex(doc_id):
    """The LaTeX of one saved conversion, for the Copy button."""
    item = history_item(doc_id)
    if not item:
        return jsonify({'ok': False, 'error': 'Not found.'}), 404
    return jsonify({'ok': True, 'tex': item.get('result') or '',
                    'fileName': item.get('fileName') or 'document',
                    'truncated': TRUNCATION_MARK in (item.get('result') or '')})


@bp.route('/history/<doc_id>/preview.pdf')
def history_preview(doc_id):
    """Render one saved conversion to a PDF preview."""
    item = history_item(doc_id)
    if not item:
        return preview_failure('That history item was not found.', 404)
    tex = item.get('result') or ''
    if TRUNCATION_MARK in tex:
        return preview_failure(
            'This saved document was too long to store in full, so it cannot '
            'be compiled. Convert the original again to get a complete .tex.',
            422)
    return _compiled_pdf(tex, cache_token=history_pdf_token(doc_id))
