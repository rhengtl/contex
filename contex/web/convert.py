"""
Starting a conversion, and saying whether one can be started.

The route does four things and delegates the fifth: it checks the brake,
checks consent, reads the upload, and hands the bytes to the pipeline. What
happens to those bytes - which engine reads them, whether the model is
available, how a partial failure is reported - is pipeline/run.py, and
none of it is decided here.

/api/ai-status lives beside it because the page asks it immediately before
posting here, and the two answers have to agree.
"""

from flask import (Blueprint, jsonify, redirect, request, session, url_for)

from contex import pipeline
from contex.services.llm import availability
from contex.web.security import rate_limited
from contex.web.session import (record_history, remember_tex, terms_accepted)
from contex.data import results as result_store

bp = Blueprint('convert', __name__)



# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

@bp.route('/convert', methods=['GET', 'POST'])
def convert_route():
    """
    The one conversion route.

    All five input methods land here: file picker, PDF, .docx, camera capture
    and canvas drawing all arrive as the same `file` field.
    """
    if request.method != 'POST':
        return redirect(url_for('pages.home'))

    if rate_limited('convert'):
        session['convert_error'] = (
            'That is a lot of conversions in a short time. Please wait a few '
            'minutes and try again.')
        return redirect(url_for('pages.home') + '#convert')

    if not terms_accepted():
        session['convert_error'] = (
            'Please accept the Terms of Service and Privacy Policy before '
            'converting a document.')
        return redirect(url_for('pages.home') + '#convert')

    file = request.files.get('file')
    if not file or file.filename == '':
        session['convert_error'] = "No file selected."
        return redirect(url_for('pages.home') + '#convert')

    file_bytes = file.read()
    if not file_bytes:
        session['convert_error'] = "That file was empty."
        return redirect(url_for('pages.home') + '#convert')

    # The user's answer to the outage warning, if they were shown one.
    allow_fallback = request.form.get('allow_fallback') in ('1', 'true', 'on')

    try:
        result = pipeline.convert(file_bytes, file.filename,
                                 allow_fallback=allow_fallback)
    except pipeline.FallbackNotAuthorized as blocked:
        # Never silently downgrade. Hand the status back so the page can say
        # which service is unavailable and whether recovery time is known.
        session['convert_blocked'] = blocked.status
        return redirect(url_for('pages.home') + '#convert')
    except RuntimeError as exc:
        session['convert_error'] = str(exc)
        return redirect(url_for('pages.home') + '#convert')
    except Exception as exc:
        print(f"ERROR: conversion failed: {exc!r}")
        session['convert_error'] = (
            "The conversion failed. Please try a different file.")
        return redirect(url_for('pages.home') + '#convert')

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
        result_store.save_pdf(token, result['pdf'])

    session['convert_token'] = token
    session['show_convert_result'] = True
    session['just_processed'] = True

    return redirect(url_for('pages.home') + '#convert')


# ---------------------------------------------------------------------------
# AI availability
# ---------------------------------------------------------------------------

@bp.route('/api/ai-status')
def ai_status_route():
    """
    Whether the AI conversion path is usable right now.

    Polled by the page before a conversion starts, and again when the user asks
    to re-check from the outage warning - so a warning cannot outlive the
    outage that caused it.
    """
    return jsonify(availability.check())


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
