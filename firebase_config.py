# firebase_config.py
import os
from datetime import datetime, timezone

import firebase_admin
import requests
from firebase_admin import credentials, auth, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Initialize Firebase Admin SDK
def initialize_firebase():
    """Initialize Firebase Admin SDK if not already initialized"""
    if not firebase_admin._apps:
        service_account_path = os.getenv('FIREBASE_SERVICE_ACCOUNT_PATH')
        
        if not service_account_path or not os.path.exists(service_account_path):
            raise FileNotFoundError(f"Firebase service account file not found: {service_account_path}")
        
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred, {
            'databaseURL': os.getenv('FIREBASE_DATABASE_URL')
        })
        print("Firebase Admin SDK initialized successfully")
    
    return firestore.client()

# Initialize Firestore client
try:
    db = initialize_firebase()
except Exception as e:
    print(f"Error initializing Firebase: {e}")
    db = None


# ===========================
# Authentication Functions
# ===========================

def create_user(email, password, display_name):
    """
    Create a new user in Firebase Authentication
    
    Args:
        email (str): User's email address
        password (str): User's password (min 6 characters)
        display_name (str): User's full name
    
    Returns:
        dict: {'success': True, 'uid': user_id} or {'success': False, 'error': error_message}
    """
    try:
        user = auth.create_user(
            email=email,
            password=password,
            display_name=display_name
        )
        
        # Create user profile in Firestore
        if db:
            db.collection('users').document(user.uid).set({
                'uid': user.uid,
                'email': email,
                'displayName': display_name,
                'createdAt': firestore.SERVER_TIMESTAMP,
                'lastLogin': firestore.SERVER_TIMESTAMP
            })
        
        return {'success': True, 'uid': user.uid}
    
    except auth.EmailAlreadyExistsError:
        return {'success': False, 'error': 'Email already exists'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# Generic message for any credential failure. Deliberately identical for
# "no such user" and "wrong password" so the login form cannot be used to
# enumerate which email addresses are registered.
INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'

# Sort floor for history rows whose SERVER_TIMESTAMP has not resolved yet.
# Timezone-aware so it compares cleanly against Firestore timestamps.
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

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

    api_key = os.getenv('FIREBASE_API_KEY')
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


def send_password_reset(email):
    """
    Send password reset email to user
    
    Args:
        email (str): User's email address
    
    Returns:
        dict: {'success': True} or {'success': False, 'error': error_message}
    """
    try:
        # Generate password reset link
        link = auth.generate_password_reset_link(email)
        
        # In production, you would send this link via email service (SendGrid, etc.)
        # For now, we'll just return success
        print(f"Password reset link generated for {email}: {link}")
        
        return {'success': True, 'reset_link': link}
    
    except auth.UserNotFoundError:
        # For security, return success even if user doesn't exist
        return {'success': True}
    except Exception as e:
        return {'success': False, 'error': str(e)}


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


# ===========================
# Firestore Functions
# ===========================

def upsert_user_profile(uid, email, display_name):
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
        db.collection('users').document(uid).set({
            'uid': uid,
            'email': email,
            'displayName': display_name,
            'lastLogin': firestore.SERVER_TIMESTAMP,
            # Only set on first write; merge=True leaves an existing value alone.
            'createdAt': firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return True
    except Exception as e:
        # Never block a valid login on a Firestore hiccup.
        print(f"Warning: could not upsert profile for {uid}: {e}")
        return False


def save_ocr_history(uid, file_name, ocr_type, result):
    """
    Save OCR processing history to Firestore
    
    Args:
        uid (str): User's unique ID
        file_name (str): Name of processed file
        ocr_type (str): Type of OCR ('equation' or 'textract')
        result (str): OCR result text
    
    Returns:
        bool: Success status
    """
    # No uid means a guest: their history is never written to Firestore.
    if not db or not uid:
        return None
    try:
        _timestamp, reference = db.collection('ocr_history').add({
            'uid': uid,
            'fileName': file_name,
            'ocrType': ocr_type,
            'result': result,
            'timestamp': firestore.SERVER_TIMESTAMP
        })
        return reference.id
    except Exception as e:
        # A history write must never break the OCR response the user came for.
        print(f"Error saving OCR history: {e}")
        return None


def get_ocr_history_item(uid, doc_id):
    """
    Read one history record, but only if it belongs to this user.

    The uid check is done here rather than trusted from the request: a document
    id is guessable enough that fetching by id alone would let any signed-in
    user read any other user's conversion.
    """
    if not db or not uid or not doc_id:
        return None
    try:
        snapshot = db.collection('ocr_history').document(doc_id).get()
    except Exception as e:
        print(f"Error reading OCR history item: {e}")
        return None
    if not snapshot.exists:
        return None
    data = snapshot.to_dict() or {}
    if data.get('uid') != uid:
        return None
    data['id'] = snapshot.id
    return data


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


def get_user_ocr_history(uid, limit=10):
    """
    Get user's OCR history from Firestore
    
    Args:
        uid (str): User's unique ID
        limit (int): Maximum number of records to retrieve
    
    Returns:
        list: List of OCR history records
    """
    # Never fall back to "all history" when there is no uid to scope by.
    if not db or not uid:
        return []

    def _rows(stream):
        out = []
        for doc in stream:
            data = doc.to_dict()
            data['id'] = doc.id
            out.append(data)
        return out

    collection = db.collection('ocr_history')
    owned = FieldFilter('uid', '==', uid)

    try:
        # Preferred path: ordered server-side. Needs the uid ASC + timestamp
        # DESC composite index declared in firestore.indexes.json.
        return _rows(
            collection.where(filter=owned)
                      .order_by('timestamp', direction=firestore.Query.DESCENDING)
                      .limit(limit)
                      .stream()
        )
    except Exception as e:
        if 'index' not in str(e).lower():
            print(f"Error getting OCR history: {e}")
            return []

        # The composite index has not been deployed (or is still building).
        # Fall back to fetching only THIS user's rows and ordering them here,
        # so history still works. Still scoped by uid, so it stays private.
        print("Notice: ocr_history composite index not ready - sorting in "
              "Python. Deploy it with: firebase deploy --only firestore:indexes")
        try:
            history = _rows(collection.where(filter=owned).limit(200).stream())
            history.sort(key=lambda r: r.get('timestamp') or _EPOCH, reverse=True)
            return history[:limit]
        except Exception as e2:
            print(f"Error getting OCR history (fallback): {e2}")
            return []
    except Exception as e:
        print(f"Error getting OCR history: {e}")
        return []
