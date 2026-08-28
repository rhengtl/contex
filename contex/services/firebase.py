"""
Starting the Firebase Admin SDK.

The only thing in this module is getting a Firestore client, once, with
credentials that come from one of two places depending on where the process is
running. Everything that then USES that client lives in services/accounts.py
(authentication) and contex/data/ (documents).

`db` is None when initialisation failed. Every caller checks it, because a
Firebase outage must degrade the app - guests keep converting, signed-in users
lose history - rather than break it.
"""

import os

import firebase_admin
from firebase_admin import credentials, firestore

from contex import config

def initialize_firebase():
    """
    Initialize the Firebase Admin SDK if it is not already running.

    Two ways in, in this order:

    1. FIREBASE_SERVICE_ACCOUNT_PATH - a downloaded key file. This is how
       local development works, because a laptop has no Google identity of
       its own.

    2. Application Default Credentials - the identity the platform already
       gives the process. On Cloud Run, Cloud Functions or GCE this is the
       service account attached to the service, and it is strictly better
       than a key file: there is no private key to ship in an image, to leak
       in a log, or to rotate by hand. A deployment should therefore set no
       FIREBASE_SERVICE_ACCOUNT_PATH at all.

    Naming a path that does not exist is still an error. That is a typo or a
    file that failed to deploy, and silently falling through to ADC would
    turn it into a confusing permissions failure much later on.
    """
    if not firebase_admin._apps:
        service_account_path = config.text('FIREBASE_SERVICE_ACCOUNT_PATH')

        if service_account_path:
            if not os.path.exists(service_account_path):
                raise FileNotFoundError(
                    f"FIREBASE_SERVICE_ACCOUNT_PATH points at a file that is "
                    f"not there: {service_account_path}. Leave the variable "
                    f"unset to use the platform's own credentials instead.")
            cred = credentials.Certificate(service_account_path)
            source = 'service account key file'
        else:
            cred = credentials.ApplicationDefault()
            source = 'application default credentials'

        options = {}
        # Only the Realtime Database needs this, and this app uses Firestore.
        # Passed through when it is set so an existing deployment does not
        # change behaviour, omitted otherwise rather than sent as None.
        database_url = config.text('FIREBASE_DATABASE_URL')
        if database_url:
            options['databaseURL'] = database_url

        firebase_admin.initialize_app(cred, options)
        print(f"Firebase Admin SDK initialized ({source})")

    return firestore.client()

# Initialize Firestore client
try:
    db = initialize_firebase()
except Exception as e:
    print(f"Error initializing Firebase: {e}")
    db = None

