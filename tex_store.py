# tex_store.py
"""
Short-lived, per-session storage for generated LaTeX jobs.

Why this exists: the original download route served one fixed file,
`uploads/output.tex`, to whoever asked for it. With more than one visitor that
hands one user another user's document. Here every generated result gets an
unguessable token; the token is recorded in the requester's server-side session
and a download is only served if the token is in *that* session.

Results are written to disk (rather than kept in a process dictionary) so the
app still behaves correctly under multiple gunicorn workers, and every file is
deleted once it passes its TTL - uploads and their results are temporary by
design, never a permanent archive.
"""

import json
import os
import secrets
import time

# Generated results live this long before the sweeper removes them.
TTL_SECONDS = int(os.getenv('TEX_STORE_TTL_SECONDS', str(60 * 60)))

# Token filenames look like: texjob_<48 hex chars>.json
_PREFIX = 'texjob_'
_SUFFIX = '.json'
_TOKEN_BYTES = 24

# A compiled preview of the same job. Kept beside the .tex rather than inside
# it: a PDF would have to be base64'd to live in JSON, inflating every read of
# a record that is usually wanted only for its text.
_PDF_PREFIX = 'texpdf_'
_PDF_SUFFIX = '.pdf'

# The preview is shown as page images rather than as the PDF itself. Browsers
# hand an application/pdf response to their own viewer - or to a download
# manager extension - before a page can display it, so the one thing a preview
# cannot be made of is a PDF. Images are shown by any browser, whatever it is
# configured to do with PDF files.
_PAGE_PREFIX = 'texpng_'
_PAGE_SUFFIX = '.png'


def _folder():
    return os.getenv('UPLOAD_FOLDER', 'uploads')


def _path_for(token):
    return os.path.join(_folder(), _PREFIX + token + _SUFFIX)


def _pdf_path_for(token):
    return os.path.join(_folder(), _PDF_PREFIX + token + _PDF_SUFFIX)


def _page_path_for(token, index):
    name = f'{_PAGE_PREFIX}{token}_{int(index):03d}{_PAGE_SUFFIX}'
    return os.path.join(_folder(), name)


def _is_valid_token(token):
    """Reject anything that is not one of our own tokens (no path traversal)."""
    return (isinstance(token, str)
            and len(token) == _TOKEN_BYTES * 2
            and all(c in '0123456789abcdef' for c in token))


def sweep():
    """Delete stored results older than the TTL. Cheap; safe to call per request."""
    folder = _folder()
    if not os.path.isdir(folder):
        return
    cutoff = time.time() - TTL_SECONDS
    for name in os.listdir(folder):
        ours = ((name.startswith(_PREFIX) and name.endswith(_SUFFIX))
                or (name.startswith(_PDF_PREFIX) and name.endswith(_PDF_SUFFIX))
                or (name.startswith(_PAGE_PREFIX) and name.endswith(_PAGE_SUFFIX)))
        if not ours:
            continue
        path = os.path.join(folder, name)
        try:
            if os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass  # another worker got there first, or the file is locked


def save(payload):
    """
    Store one result dict (must contain at least 'tex') and return its token.

    The caller must record the token in the user's session; without that the
    result is unreachable, because the token is never guessable or enumerable.
    """
    sweep()
    os.makedirs(_folder(), exist_ok=True)
    token = secrets.token_hex(_TOKEN_BYTES)
    with open(_path_for(token), 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
    return token


def read(token):
    """Return the stored result dict, or None if the token is bad or expired."""
    if not _is_valid_token(token):
        return None
    path = _path_for(token)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def save_pdf(token, data):
    """
    Cache the compiled preview for a stored result.

    Compiling is slow enough to be worth not repeating every time the user
    scrolls back to the preview, and the PDF is derived entirely from a
    document this session already owns, so it inherits the same lifetime and
    the same access rule.
    """
    if not _is_valid_token(token) or not data:
        return False
    try:
        os.makedirs(_folder(), exist_ok=True)
        with open(_pdf_path_for(token), 'wb') as handle:
            handle.write(data)
        return True
    except OSError:
        return False


def read_pdf(token):
    """Return the cached preview PDF, or None if it has not been built yet."""
    if not _is_valid_token(token):
        return None
    try:
        with open(_pdf_path_for(token), 'rb') as handle:
            return handle.read()
    except OSError:
        return None


def save_pages(token, images):
    """
    Cache the rendered preview pages for a stored result.

    Returns how many were written. Rasterising is far slower than compiling, so
    a preview that is scrolled back to must not pay for it twice.
    """
    if not _is_valid_token(token):
        return 0
    written = 0
    try:
        os.makedirs(_folder(), exist_ok=True)
        for index, data in enumerate(images, start=1):
            if not data:
                continue
            with open(_page_path_for(token, index), 'wb') as handle:
                handle.write(data)
            written += 1
    except OSError:
        return written
    return written


def read_page(token, index):
    """Return one cached preview page, or None if it has not been rendered."""
    if not _is_valid_token(token) or int(index) < 1:
        return None
    try:
        with open(_page_path_for(token, index), 'rb') as handle:
            return handle.read()
    except (OSError, ValueError):
        return None


def count_pages(token):
    """How many preview pages are cached for this result."""
    if not _is_valid_token(token):
        return 0
    total = 0
    while os.path.exists(_page_path_for(token, total + 1)):
        total += 1
    return total


def discard(token):
    """Delete one stored result (used when a session replaces its previous one)."""
    if not _is_valid_token(token):
        return
    for path in (_path_for(token), _pdf_path_for(token)):
        try:
            os.remove(path)
        except OSError:
            pass
    for index in range(1, count_pages(token) + 1):
        try:
            os.remove(_page_path_for(token, index))
        except OSError:
            pass
