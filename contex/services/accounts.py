"""
Accounts: creating them, proving who someone is, and letting them back in.

WHY THIS IS NOT THE ADMIN SDK ALONE. The Admin SDK deliberately cannot check a
password - that is Google's design, not an oversight. An implementation that
looks a user up by email and treats finding them as success is not
authentication at all: it lets anyone sign in as anyone by typing their
address. So the two operations that need a password go to the Identity Toolkit
REST API over HTTPS, and Firebase does the comparison.

The same reasoning governs the reset link. The Admin SDK can only *generate*
one, and this project has no way to deliver an email - so it asks Firebase to
send its own, and the link never touches this server or its logs.

Every failure answer here is deliberately uninformative: "no such user" and
"wrong password" are indistinguishable, or the form becomes a way to find out
who has an account.
"""

import requests
from firebase_admin import auth, firestore

from contex import config
from contex.services.firebase import db


def create_user(email, password, display_name):
    """
    Create an account, and give it a profile document to go with it.

    The profile write is part of creating the account rather than a separate
    step, so an account can never exist without one - which is what every
    later read of users/{uid} assumes.

    Returns {'success': True, 'uid': ...} or {'success': False, 'error': ...}.

    Note that "Email already exists" is returned as-is, and that IS an
    enumeration signal: it tells a stranger whether an address has an account
    here. Firebase's own enumeration protection covers the sign-in path but
    not this one, because this goes through the Admin SDK. Fixing it properly
    needs an email this project cannot send - see DEPLOYMENT.md.
    """
    try:
        user = auth.create_user(
            email=email,
            password=password,
            display_name=display_name,
        )

        if db:
            db.collection('users').document(user.uid).set({
                'uid': user.uid,
                'email': email,
                'displayName': display_name,
                'createdAt': firestore.SERVER_TIMESTAMP,
                'lastLogin': firestore.SERVER_TIMESTAMP,
            })

        return {'success': True, 'uid': user.uid}

    except auth.EmailAlreadyExistsError:
        return {'success': False, 'error': 'Email already exists'}
    except Exception as exc:
        return {'success': False, 'error': str(exc)}

# Generic message for any credential failure. Deliberately identical for
# "no such user" and "wrong password" so the login form cannot be used to
# enumerate which email addresses are registered.
INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'

# Firebase Auth REST endpoint. The Admin SDK cannot verify passwords by design;
# this is the supported server-side mechanism for doing so.
_SIGN_IN_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'

# Identity Toolkit error codes that mean "bad credentials" rather than a fault
# on our side. INVALID_LOGIN_CREDENTIALS is what newer projects return when
# email-enumeration protection is enabled; the older split codes are kept for
# projects that still have it turned off.
_CREDENTIAL_ERRORS = {
    'EMAIL_NOT_FOUND',
    'INVALID_PASSWORD',
    'INVALID_LOGIN_CREDENTIALS',
    'INVALID_EMAIL',
    'MISSING_PASSWORD',
    'MISSING_EMAIL',
}


def verify_user(email, password):
    """
    Verify a user's email AND password against Firebase Authentication.

    The Firebase Admin SDK intentionally cannot check passwords, so this calls
    the Identity Toolkit `signInWithPassword` endpoint over HTTPS. Firebase
    performs the hash comparison itself; the password is never stored, logged,
    or compared locally.

    Args:
        email (str): User's email address
        password (str): User's password

    Returns:
        dict: {'success': True, 'user': user_record} or
              {'success': False, 'error': error_message}
    """
    # Fail closed on empty/blank input before touching the network.
    if not email or not str(email).strip() or not password:
        return {'success': False, 'error': INVALID_CREDENTIALS_MESSAGE}

    api_key = config.text('FIREBASE_API_KEY')
    if not api_key:
        # Without the Web API key we cannot verify a password. Refuse to sign
        # anyone in rather than falling back to an existence check.
        print("ERROR: FIREBASE_API_KEY is not set - password verification is unavailable.")
        return {'success': False,
                'error': 'Authentication is not configured. Please contact the administrator.'}

    try:
        response = requests.post(
            _SIGN_IN_ENDPOINT,
            params={'key': api_key},
            json={
                'email': str(email).strip(),
                'password': password,
                'returnSecureToken': True,
            },
            timeout=15,
        )
    except requests.exceptions.RequestException as e:
        print(f"Error contacting Firebase Auth: {e}")
        return {'success': False,
                'error': 'Could not reach the authentication service. Please try again.'}

    if response.status_code != 200:
        try:
            code = response.json().get('error', {}).get('message', '')
        except ValueError:
            code = ''
        # Strip any trailing detail, e.g. "TOO_MANY_ATTEMPTS_TRY_LATER : ..."
        code = code.split(':')[0].strip()

        if code in _CREDENTIAL_ERRORS:
            return {'success': False, 'error': INVALID_CREDENTIALS_MESSAGE}
        if code == 'USER_DISABLED':
            return {'success': False, 'error': 'This account has been disabled.'}
        if code == 'TOO_MANY_ATTEMPTS_TRY_LATER':
            return {'success': False,
                    'error': 'Too many failed attempts. Please try again later.'}
        if code == 'CONFIGURATION_NOT_FOUND':
            print("ERROR: Firebase Authentication is not enabled for this project. "
                  "Enable Email/Password sign-in in the Firebase Console.")
            return {'success': False,
                    'error': 'Authentication is not configured. Please contact the administrator.'}

        print(f"Unexpected Firebase Auth error: {code or response.text[:200]}")
        return {'success': False, 'error': INVALID_CREDENTIALS_MESSAGE}

    # Password verified by Firebase.
    uid = response.json().get('localId')
    if not uid:
        return {'success': False, 'error': INVALID_CREDENTIALS_MESSAGE}

    try:
        # Re-read the authoritative record so callers keep receiving a
        # UserRecord with .uid / .email / .display_name, as before.
        user = auth.get_user(uid)
    except Exception as e:
        print(f"Error loading user record after sign-in: {e}")
        return {'success': False, 'error': INVALID_CREDENTIALS_MESSAGE}

    if user.disabled:
        return {'success': False, 'error': 'This account has been disabled.'}

    # Update last login in Firestore (best-effort: a Firestore outage or a
    # missing profile document must not block an otherwise valid login).
    if db:
        try:
            db.collection('users').document(user.uid).set(
                {'lastLogin': firestore.SERVER_TIMESTAMP}, merge=True
            )
        except Exception as e:
            print(f"Warning: could not update lastLogin for {user.uid}: {e}")

    return {'success': True, 'user': user}


# Firebase Auth REST endpoint for "email me a reset link". Unlike the Admin
# SDK's generate_password_reset_link, which only builds a link and leaves
# delivering it to you, this one makes Firebase send its own email - which is
# the whole point, because this project has no mail server of any kind.
_RESET_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode'


def send_password_reset(email):
    """
    Ask Firebase to email this address a password reset link.

    This must stay an actual send. auth.generate_password_reset_link() only
    mints the link - it delivers nothing, so using it means telling the user
    an email is on its way and sending none. And the link it returns is
    equivalent to the account's password, so it must never be printed,
    logged or returned to the caller.

    Returns:
        dict: {'success': True} whether or not the address is registered - the
              answer must not reveal which, or the form becomes a way to test
              whether somebody has an account here.
    """
    if not email or not str(email).strip():
        return {'success': True}

    api_key = config.text('FIREBASE_API_KEY')
    if not api_key:
        print("ERROR: FIREBASE_API_KEY is not set - password reset emails "
              "cannot be sent.")
        return {'success': False,
                'error': 'Password reset is not configured on this server. '
                         'Please contact the administrator.'}

    try:
        response = requests.post(
            _RESET_ENDPOINT,
            params={'key': api_key},
            json={'requestType': 'PASSWORD_RESET',
                  'email': str(email).strip()},
            timeout=15,
        )
    except requests.exceptions.RequestException as e:
        print(f"Error requesting a password reset email: {e}")
        return {'success': False,
                'error': 'Could not reach the authentication service. '
                         'Please try again.'}

    if response.status_code == 200:
        return {'success': True}

    try:
        code = response.json().get('error', {}).get('message', '')
    except ValueError:
        code = ''
    code = code.split(':')[0].strip()

    # An unknown address is not an error the user gets to see.
    if code in ('EMAIL_NOT_FOUND', 'INVALID_EMAIL', 'MISSING_EMAIL'):
        return {'success': True}
    if code == 'TOO_MANY_ATTEMPTS_TRY_LATER':
        return {'success': False,
                'error': 'Too many requests. Please try again later.'}

    # Log the code, never the address plus the outcome together.
    print(f"Password reset request failed: {code or response.status_code}")
    return {'success': False,
            'error': 'The reset email could not be sent. Please try again.'}


def get_user_by_uid(uid):
    """
    Get user information from Firebase
    
    Args:
        uid (str): User's unique ID
    
    Returns:
        dict: User information or None
    """
    try:
        user = auth.get_user(uid)
        return {
            'uid': user.uid,
            'email': user.email,
            'displayName': user.display_name,
            'emailVerified': user.email_verified
        }
    except Exception as e:
        print(f"Error getting user: {e}")
        return None


def verify_id_token(id_token):
    """
    Verify Firebase ID token (for client-side authentication)
    
    Args:
        id_token (str): Firebase ID token from client
    
    Returns:
        dict: Decoded token or None
    """
    if not id_token:
        return None
    try:
        # check_revoked=True rejects tokens belonging to a session that was
        # revoked or to an account that has since been disabled.
        decoded_token = auth.verify_id_token(id_token, check_revoked=True)
        return decoded_token
    except auth.RevokedIdTokenError:
        print("Error verifying token: token has been revoked")
        return None
    except auth.UserDisabledError:
        print("Error verifying token: user account is disabled")
        return None
    except Exception as e:
        print(f"Error verifying token: {e}")
        return None


