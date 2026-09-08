"""
The users/{uid} document: a profile, and what version of the terms it accepted.

One document per account, its id IS the uid, and every write here is a merge -
so a field this app has not thought of yet cannot be destroyed by a write from
an older version of it.

Kept apart from history.py because the two answer different questions. A
profile exists for as long as the account does; a conversion is a document the
user made and can delete.
"""

from firebase_admin import firestore

from contex.services.firebase import db

def upsert_profile(uid, email, display_name):
    """
    Create or refresh a user's Firestore profile and stamp lastLogin.

    Email/password users get their profile from create_user(), but federated
    (Google) users sign in without ever passing through it. This keeps the
    users/ collection consistent for every sign-in method.

    Args:
        uid (str): User's unique ID
        email (str): User's email address
        display_name (str): User's display name

    Returns:
        bool: Success status
    """
    if not db:
        return False
    try:
        document = db.collection('users').document(uid)
        profile = {
            'uid': uid,
            'email': email,
            'displayName': display_name,
            'lastLogin': firestore.SERVER_TIMESTAMP,
        }

        # createdAt is written only when there is nothing there to preserve.
        #
        # It used to sit in the dictionary above, with a comment claiming
        # merge=True would leave an existing value alone. It does not: a merge
        # writes every field it is given, and this one was given createdAt on
        # every login - so an account's creation date was really its last login
        # date, and lastLogin beside it was the same instant. One read is what
        # it costs to be right, and this runs once per sign-in.
        #
        # A row written before this fix has a createdAt that is wrong rather
        # than missing, and nothing here can recover the true date - but a row
        # that never got one at all is healed on the next login.
        snapshot = document.get(field_paths=['createdAt'])
        if not snapshot.exists or not (snapshot.to_dict() or {}).get('createdAt'):
            profile['createdAt'] = firestore.SERVER_TIMESTAMP

        document.set(profile, merge=True)
        return True
    except Exception as e:
        # Never block a valid login on a Firestore hiccup.
        print(f"Warning: could not upsert profile for {uid}: {e}")
        return False




def set_terms_accepted(uid, version):
    """
    Record that this user accepted the terms, so they are not asked again.

    Stored on the user's own profile document rather than in the session, which
    is what makes the acceptance survive signing out and back in.
    """
    if not db or not uid:
        return False
    try:
        db.collection('users').document(uid).set({
            'termsAcceptedVersion': version,
            'termsAcceptedAt': firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return True
    except Exception as e:
        print(f"Warning: could not record terms acceptance for {uid}: {e}")
        return False


def get_terms_accepted(uid):
    """The terms version this user last accepted, or None."""
    if not db or not uid:
        return None
    try:
        snapshot = db.collection('users').document(uid).get()
    except Exception as e:
        print(f"Warning: could not read terms acceptance for {uid}: {e}")
        return None
    if not snapshot.exists:
        return None
    return (snapshot.to_dict() or {}).get('termsAcceptedVersion')


#: The fields the history list actually renders. Everything else - the stored
#: LaTeX above all - is left in Firestore until a route asks for that document.
