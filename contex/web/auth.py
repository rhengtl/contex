"""
Signing in, signing up, and getting back in.

Each route validates its form, asks services/accounts.py the question, and
turns the answer into a page or a redirect. It never talks to Firebase
directly and never decides what counts as a valid credential - that is the
service's job, and keeping it there is what lets the sign-in rules be tested
without a browser.
"""

from flask import (Blueprint, redirect, render_template, request, session,
                   url_for)

from contex import config
from contex.services import accounts
from contex.data import users
from contex.web.security import rate_limited
from contex.web.session import start_session

bp = Blueprint('auth', __name__)



@bp.route('/login', methods=['GET', 'POST'])
def login():
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('pages.home'))

    def page(**context):
        # Every render needs the browser Firebase config, including the ones
        # carrying an error - otherwise a mistyped password makes the Google
        # sign-in button vanish from the page it was just on.
        return render_template('auth/login.html',
                               firebase_config=config.browser_firebase(),
                               **context)

    if request.method == 'POST':
        if rate_limited('auth'):
            return page(error='Too many sign-in attempts. Please wait a few '
                              'minutes and try again.'), 429

        # Check if this is a Firebase ID token login (from Google/Facebook)
        id_token = request.form.get('idToken')

        if id_token:
            # Verify Firebase ID token
            decoded_token = accounts.verify_id_token(id_token)
            if decoded_token:
                uid = decoded_token['uid']
                user = accounts.get_user_by_uid(uid)

                if user:
                    # Federated users skip create_user(), so make sure they
                    # still have a users/ profile document.
                    users.upsert_profile(
                        user['uid'], user['email'], user['displayName'])

                    start_session(user['uid'], user['email'],
                                   user['displayName'], remember=True)
                    return redirect(url_for('pages.home'))

            return page(error="Authentication failed"), 401

        # Regular email/password login
        email = request.form.get('email')
        password = request.form.get('password')
        remember = request.form.get('remember')

        if not email or not password:
            return page(error="Please provide email and password"), 400

        # Verify user with Firebase
        result = accounts.verify_user(email, password)

        if result['success']:
            user = result['user']
            start_session(user.uid, user.email, user.display_name,
                           remember=bool(remember))
            return redirect(url_for('pages.home'))

        return page(error=result.get('error', 'Invalid credentials')), 401

    return page()


@bp.route('/signup', methods=['GET', 'POST'])
def signup():
    # If user is already logged in, redirect to home
    if 'user' in session:
        return redirect(url_for('pages.home'))

    def page(**context):
        # Every render needs the browser Firebase config, including the ones
        # that come back carrying a validation error - otherwise the federated
        # sign-in button disappears the moment you get something wrong.
        return render_template('auth/signup.html',
                               firebase_config=config.browser_firebase(),
                               **context)

    if request.method == 'POST':
        fullname = request.form.get('fullname')
        email = request.form.get('email')
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')
        terms = request.form.get('terms')

        # Basic validation
        if not all([fullname, email, password, confirm_password]):
            return page(error="All fields are required")

        if password != confirm_password:
            return page(error="Passwords do not match")

        if len(password) < 6:
            return page(error="Password must be at least 6 characters")

        if not terms:
            return page(error="You must agree to the terms and conditions")

        # Create user in Firebase
        result = accounts.create_user(email, password, fullname)

        if result['success']:
            return page(success="Account created successfully! Please login.")
        return page(error=result.get('error', 'Failed to create account'))

    return page()


@bp.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        # Same allowance as signing in. Without it this form is a free way to
        # send mail to any address, over and over.
        if rate_limited('auth'):
            return render_template(
                'auth/forgot_password.html',
                error='Too many requests. Please wait a few minutes and try '
                      'again.'), 429

        email = request.form.get('email')

        if not email:
            return render_template('auth/forgot_password.html', error="Please provide your email address")

        # Firebase composes and sends the email itself; nothing here handles
        # the link, and nothing writes it to a log.
        result = accounts.send_password_reset(email)

        if result['success']:
            # Deliberately the same answer whether or not the address is
            # registered, so this form cannot be used to find out who is.
            return render_template('auth/forgot_password.html',
                                 success="If an account exists with that email, you will receive a password reset link.")
        else:
            return render_template('auth/forgot_password.html',
                                 error=result.get('error', 'An error occurred'))

    return render_template('auth/forgot_password.html')


@bp.route('/logout', methods=['GET', 'POST'])
def logout():
    """
    Sign out and drop the whole session.

    GET is kept because the header links to it and a link is what people
    expect; SameSite=Lax already stops another site from triggering it with
    the visitor's cookie, which is the only thing a cross-site logout could
    achieve here.
    """
    session.clear()
    return redirect(url_for('auth.login'))
