# Firebase Auth Integration for Flask

## Setup Instructions

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Configure Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project (contex-55562)
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key" (you already have this: `contex-55562-firebase-adminsdk-fbsvc-d081c3fda2.json`)
5. Save the JSON file in your project root

### 3. Update .env File

Copy `.env.example` to `.env` and update the values:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=contex-55562-firebase-adminsdk-fbsvc-d081c3fda2.json
FIREBASE_DATABASE_URL=https://contex-55562.firebaseio.com
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

**OCR Features:**
- `GET /` - Home page (main app)
- `POST /equation` - Process equation images
- `POST /textract` - Extract text from documents

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
save_user_data(uid, data)
get_user_data(uid)
save_ocr_history(uid, file_name, ocr_type, result)
get_user_ocr_history(uid, limit=10)
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
