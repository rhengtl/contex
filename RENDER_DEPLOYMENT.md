# Render Deployment Guide for ConTeX App

## Files Created for Deployment:
✅ render.yaml - Render configuration
✅ Aptfile - System dependencies (Tesseract OCR)
✅ requirements.txt - Updated with gunicorn

## Deployment Steps:

### 1. Push to GitHub
```bash
git add .
git commit -m "Prepare for Render deployment"
git push origin master
```

### 2. Create Render Account
- Go to: https://render.com
- Sign up with GitHub account (FREE)

### 3. Deploy on Render
1. Click "New +" → "Web Service"
2. Connect your GitHub repository: `miku1001/Context_App`
3. Configure:
   - **Name**: contex-app (or any name)
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
   - **Plan**: Free

4. Click "Create Web Service"

### 4. Wait for Deployment
- First deployment takes 5-10 minutes
- Render will install Tesseract and all dependencies
- Watch the logs for any errors

### 5. Access Your App
- URL will be: `https://contex-app.onrender.com` (or your chosen name)

## Important Notes:
⚠️ **Free tier limitations:**
- App sleeps after 15 minutes of inactivity
- First request after sleep takes ~1 minute to wake up
- 512MB RAM limit
- 750 hours/month (always enough for personal projects)

⚠️ **Model Loading:**
- Your TrOCR model will download on first start
- This might take a few minutes
- Models are cached after first load

## Troubleshooting:
If deployment fails, check Render logs for:
- Memory issues → Model too large for free tier
- Tesseract errors → Check Aptfile is present
- Port errors → Should use $PORT environment variable (already configured)

## Local Testing:
Test locally before deploying:
```bash
gunicorn app:app
```

## Need Help?
Check Render logs at: https://dashboard.render.com
