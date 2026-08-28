"""
The ocr_history collection: one document per saved conversion.

Only signed-in users appear here. A guest's history is kept in their browser's
sessionStorage and never reaches Firestore - see the guest history section of
static/scripts.js - which is what makes "your conversions are not stored"
true for guests rather than merely intended.

Every read is scoped by uid inside this module rather than trusted from the
caller: a document id is guessable enough that fetching by id alone would let
any signed-in user read any other user's conversion.
"""

from datetime import datetime, timezone

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from contex.services.firebase import db

#: Sort floor for rows whose SERVER_TIMESTAMP has not resolved yet. Timezone
#: aware so it compares cleanly against Firestore timestamps.
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

def save(uid, file_name, ocr_type, result, truncated=False):
    """
    Save OCR processing history to Firestore

    Args:
        uid (str): User's unique ID
        file_name (str): Name of processed file
        ocr_type (str): Type of OCR ('equation' or 'textract')
        result (str): OCR result text
        truncated (bool): whether `result` had to be cut short to be stored

    `truncated` is written as its own field so the history list can be read
    without the documents themselves - see recent.

    Returns:
        str: the new document's id, or None
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
            'truncated': bool(truncated),
            'timestamp': firestore.SERVER_TIMESTAMP
        })
        return reference.id
    except Exception as e:
        # A history write must never break the OCR response the user came for.
        print(f"Error saving OCR history: {e}")
        return None


def item(uid, doc_id):
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




_LIST_FIELDS = ['fileName', 'timestamp', 'truncated', 'ocrType']


def recent(uid, limit=10):
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
        #
        # select() so the documents themselves stay where they are. The list
        # shows a name, a date and some buttons; it never shows the LaTeX. A
        # stored document runs to 60 KB, so fetching twenty of them meant up to
        # a megabyte crossing the network before the page could start
        # rendering, to display none of it. Each document is read in full only
        # when something actually asks for one.
        return _rows(
            collection.where(filter=owned)
                      .select(_LIST_FIELDS)
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
            history = _rows(collection.where(filter=owned)
                            .select(_LIST_FIELDS).limit(200).stream())
            history.sort(key=lambda r: r.get('timestamp') or _EPOCH, reverse=True)
            return history[:limit]
        except Exception as e2:
            print(f"Error getting OCR history (fallback): {e2}")
            return []
