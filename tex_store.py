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


def _folder():
    return os.getenv('UPLOAD_FOLDER', 'uploads')


def _path_for(token):
    return os.path.join(_folder(), _PREFIX + token + _SUFFIX)


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
        if not (name.startswith(_PREFIX) and name.endswith(_SUFFIX)):
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


def discard(token):
    """Delete one stored result (used when a session replaces its previous one)."""
    if not _is_valid_token(token):
        return
    try:
        os.remove(_path_for(token))
    except OSError:
        pass
