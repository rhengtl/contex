# firebase_config.py
import os
import firebase_admin
from firebase_admin import credentials, auth, firestore
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


def verify_user(email, password):
    """
    Verify user credentials (for server-side authentication)
    
    IMPORTANT NOTE: Firebase Admin SDK cannot verify passwords directly.
    This is a simplified version that just checks if user exists.
    For production, implement client-side Firebase Auth with ID token verification.
    
    Args:
        email (str): User's email address
        password (str): User's password (not verified in this version)
    
    Returns:
        dict: {'success': True, 'user': user_record} or {'success': False, 'error': error_message}
    """
    try:
        # Just check if user exists by email
        # NOTE: This does NOT verify password - that requires client SDK
        user = auth.get_user_by_email(email)
        
        # Update last login in Firestore
        if db:
            db.collection('users').document(user.uid).update({
                'lastLogin': firestore.SERVER_TIMESTAMP
            })
        
        # For now, we trust that the user exists
        # In production, you should verify ID tokens from client-side Firebase Auth
        return {'success': True, 'user': user}
    
    except auth.UserNotFoundError:
        return {'success': False, 'error': 'Invalid email or password'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


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
    try:
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token
    except Exception as e:
        print(f"Error verifying token: {e}")
        return None


# ===========================
# Firestore Functions
# ===========================

def save_user_data(uid, data):
    """
    Save additional user data to Firestore
    
    Args:
        uid (str): User's unique ID
        data (dict): Data to save
    
    Returns:
        bool: Success status
    """
    try:
        if db:
            db.collection('users').document(uid).update(data)
            return True
        return False
    except Exception as e:
        print(f"Error saving user data: {e}")
        return False


def get_user_data(uid):
    """
    Get user data from Firestore
    
    Args:
        uid (str): User's unique ID
    
    Returns:
        dict: User data or None
    """
    try:
        if db:
            doc = db.collection('users').document(uid).get()
            if doc.exists:
                return doc.to_dict()
        return None
    except Exception as e:
        print(f"Error getting user data: {e}")
        return None


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
    try:
        if db:
            db.collection('ocr_history').add({
                'uid': uid,
                'fileName': file_name,
                'ocrType': ocr_type,
                'result': result,
                'timestamp': firestore.SERVER_TIMESTAMP
            })
            return True
        return False
    except Exception as e:
        print(f"Error saving OCR history: {e}")
        return False


def get_user_ocr_history(uid, limit=10):
    """
    Get user's OCR history from Firestore
    
    Args:
        uid (str): User's unique ID
        limit (int): Maximum number of records to retrieve
    
    Returns:
        list: List of OCR history records
    """
    try:
        if db:
            docs = db.collection('ocr_history')\
                     .where('uid', '==', uid)\
                     .order_by('timestamp', direction=firestore.Query.DESCENDING)\
                     .limit(limit)\
                     .stream()
            
            history = []
            for doc in docs:
                data = doc.to_dict()
                data['id'] = doc.id
                history.append(data)
            
            return history
        return []
    except Exception as e:
        print(f"Error getting OCR history: {e}")
        return []
