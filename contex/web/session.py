"""
Who this visitor is, what they have agreed to, and what they may fetch.

Three questions every route asks and no route should answer for itself:

  who is this?        current_user_uid(), read from the signed session cookie
                      and never from the request, so a client cannot name
                      another user's id and be believed
  may they convert?   terms_accepted(), which uses two stores because the two
                      kinds of visitor are genuinely different
  is this theirs?     owned_tex(), the rule that stops one visitor
                      downloading another's document

Everything here reads or writes the session and nothing else. It is the layer
between "a request arrived" and "this person may do this".
"""

import hashlib

from flask import session

from contex import config
from contex.data import history as history_store
from contex.data import results as result_store
from contex.data import users



# Bump this whenever the terms or privacy policy change materially. Everyone -
# including users who already accepted an older version - is then asked again.
# It is deliberately not a date alone: the version is what was agreed to.
TERMS_VERSION = config.text('TERMS_VERSION', '1.0-2026-08-24')

# NOTE: conversion does not require a login. Every core feature of this app is
# usable by guests; signing in only adds persistent history.


def current_user_uid():
    """
    Return the signed-in user's Firebase UID, or None for a guest.

    The UID always comes from the server-side session (set only after Firebase
    verified a password or an ID token). It is never read from the request, so
    a client cannot target another user's history by forging a uid field.
    """
    user = session.get('user')
    return user.get('uid') if isinstance(user, dict) else None


def start_session(uid, email, display_name, remember=False):
    """
    Begin a signed-in session, discarding whatever the visitor had before.

    Everything from the previous session goes - the generated-result tokens
    above all. On a shared computer the person signing in is not necessarily
    the person who was just using it, and a token left in the cookie would let
    them download the document that person converted.
    """
    session.clear()
    session['user'] = {'uid': uid, 'email': email, 'displayName': display_name}
    session.permanent = bool(remember)


# ---------------------------------------------------------------------------
# Terms of Service / Privacy Policy gate
# ---------------------------------------------------------------------------

def terms_accepted():
    """
    True when this visitor has accepted the current terms.

    Two stores, because the two kinds of visitor are different. A guest has
    nowhere durable to keep the answer, so it lives in their session and they
    are asked again next time. A signed-in user's acceptance is on their
    profile, so it survives signing out - being asked to re-accept on every
    login would be noise, not consent.
    """
    if session.get('terms_version') == TERMS_VERSION:
        return True
    uid = current_user_uid()
    if uid and users.get_terms_accepted(uid) == TERMS_VERSION:
        # Cache it in the session so the next request does not hit Firestore.
        session['terms_version'] = TERMS_VERSION
        return True
    return False


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

# Longest result text stored in a history record.
HISTORY_RESULT_LIMIT = 60000

TRUNCATION_MARK = '\n... [truncated]'


def record_history(file_name, result):
    """
    Persist one conversion for signed-in users only.

    Guests are intentionally skipped here: their history is kept client-side
    in sessionStorage so it disappears with the tab and never touches
    Firestore. Returns the document id, or None.
    """
    uid = current_user_uid()
    if not uid:
        return None
    # A whole .tex document can be long; keep history rows a sane size.
    truncated = bool(result) and len(result) > HISTORY_RESULT_LIMIT
    if truncated:
        result = result[:HISTORY_RESULT_LIMIT] + TRUNCATION_MARK
    return history_store.save(uid, file_name, 'convert', result,
                                            truncated=truncated)


def history_item(doc_id):
    """One history record belonging to the signed-in user, or None."""
    uid = current_user_uid()
    if not uid:
        return None
    return history_store.item(uid, doc_id)


def history_pdf_token(doc_id):
    """
    A stable cache key for a history item's compiled preview.

    Derived from the document id so the same item reuses its PDF instead of
    recompiling on every visit. It is only ever used *after* the route has
    confirmed the item belongs to the signed-in user, so it grants no access of
    its own.
    """
    return hashlib.sha256(f'history:{doc_id}'.encode()).hexdigest()[:48]


# ---------------------------------------------------------------------------
# Generated results
# ---------------------------------------------------------------------------

# How many generated results one session can hold at once. Matched to the
# length of the guest history list, so that every entry a guest can still see
# is an entry they can still preview and download.
_MAX_SESSION_TEX = 20


def remember_tex(payload):
    """
    Store a generated .tex result and bind it to THIS session.

    Returns the token. Only tokens listed in the caller's own session can be
    downloaded later, so one visitor can never fetch another's document.
    """
    token = result_store.save(payload)
    tokens = list(session.get('tex_tokens', [])) + [token]
    for expired in tokens[:-_MAX_SESSION_TEX]:
        result_store.discard(expired)
    session['tex_tokens'] = tokens[-_MAX_SESSION_TEX:]
    return token


def owns_token(token):
    """True when the current session generated this result."""
    return bool(token) and token in session.get('tex_tokens', [])


def owned_tex(token):
    """Return a stored result only if the current session owns that token."""
    if not owns_token(token):
        return None
    return result_store.read(token)


def shell_context():
    """
    What the application shell needs on every page.

    The header, the footer and the base template are on every route,
    including the ones that never thought about them - the auth pages had no
    header at all and no way back to the app except the browser's own back
    button. Injecting this here means a new route cannot forget it.
    """
    return {
        'is_authenticated': bool(current_user_uid()),
        'max_upload_mb': config.integer('MAX_UPLOAD_MB', 32),
    }




def latest_token(source):
    """Most recent token in this session that came from the given pipeline."""
    for token in reversed(session.get('tex_tokens', [])):
        stored = result_store.read(token)
        if stored and stored.get('source') == source:
            return token
    return None

def install(app):
    """Expose the shell's context to every template."""
    app.context_processor(shell_context)
