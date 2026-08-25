# Firebase Auth Integration for Flask

## Setup Instructions

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Configure Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Save the JSON file in your project root

### 3. Update .env File

Copy `.env.example` to `.env` and update the values:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=your-project-firebase-adminsdk-xxxxx.json
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
```

### 4. Enable Authentication in Firebase Console

1. Go to Firebase Console > Authentication
2. Click "Get Started"
3. Enable "Email/Password" sign-in method

### 5. Create Firestore Database

1. Go to Firebase Console > Firestore Database
2. Click "Create Database"
3. Choose "Start in production mode"
4. Select your preferred region

## Features Implemented

### Authentication
- ✅ User signup with email/password
- ✅ User login with credential verification
- ✅ Password reset via email
- ✅ Session management
- ✅ Logout functionality

### Firestore Integration
- ✅ User profiles stored in `users` collection
- ✅ OCR history tracking in `ocr_history` collection
- ✅ Last login timestamp tracking

### Security
- ✅ Password minimum length (6 characters)
- ✅ Email validation
- ✅ Session-based authentication
- ✅ Environment variables for sensitive data
- ✅ Service account key excluded from git

## Usage

### Running the App
```bash
python app.py
```

### API Routes

**Authentication:**
- `GET/POST /login` - Login page
- `GET/POST /signup` - Signup page
- `GET/POST /forgot-password` - Password reset
- `GET /logout` - Logout user

**Conversion:**
- `GET /` - Home page (main app)
- `POST /accept-terms` - Record acceptance of the Terms and Privacy Policy
- `POST /convert` - Convert an image, PDF or .docx to LaTeX
- `GET /api/ai-status` - Whether AI conversion is available right now
- `GET /legal/<document>` - Terms of Service and Privacy Policy

**Output:**
- `GET /download-converted-tex` - Download the generated `.tex`
- `GET /preview/pages` - Page count for the rendered preview
- `GET /preview/page.png` - One rendered page image
- `GET /preview/document` - The compiled PDF, for opening in a new tab
- `GET /preview.pdf` - The compiled PDF itself

**History** (signed-in users):
- `GET /history/<doc_id>/download` - Download a saved conversion
- `GET /history/<doc_id>/tex` - Its LaTeX, for the copy button
- `GET /history/<doc_id>/preview.pdf` - Its compiled PDF

## Firebase Helper Functions

Located in `firebase_config.py`:

```python
# Authentication
create_user(email, password, display_name)
verify_user(email, password)
send_password_reset(email)
get_user_by_uid(uid)
verify_id_token(id_token)

# Firestore
upsert_user_profile(uid, email, display_name)
save_ocr_history(uid, file_name, ocr_type, result)
get_user_ocr_history(uid, limit=10)
get_ocr_history_item(uid, doc_id)

# Terms acceptance
set_terms_accepted(uid, version)
get_terms_accepted(uid)
```

## Firestore Data Structure

### Users Collection
```javascript
users/{uid}
  - uid: string
  - email: string
  - displayName: string
  - createdAt: timestamp
  - lastLogin: timestamp
```

### OCR History Collection
```javascript
ocr_history/{docId}
  - uid: string
  - fileName: string
  - ocrType: string ('equation' or 'textract')
  - result: string
  - timestamp: timestamp
```

## Security Notes

⚠️ **Important:**
1. Never commit `.env` or Firebase service account JSON files to git
2. The `.gitignore` is configured to exclude these files
3. For production, use environment variables on your hosting platform
4. Consider implementing rate limiting for authentication endpoints
5. Enable email verification in production

## Troubleshooting

**Firebase not initializing:**
- Check that the service account JSON path is correct in `.env`
- Ensure the JSON file exists and has proper permissions

**Authentication errors:**
- Verify Email/Password is enabled in Firebase Console
- Check that passwords meet minimum length requirements

**Firestore errors:**
- Ensure Firestore is created and enabled in Firebase Console
- Check database rules allow read/write with authentication
