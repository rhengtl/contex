"""
Everything that outlives a request.

    users       users/{uid}: the profile and the accepted terms version
    history     ocr_history: one document per saved conversion
    results     generated .tex files, their PDFs and page images, on disk

users and history are Firestore and belong to a signed-in account. results is
local, short-lived and bound to a session rather than to a person - a guest
gets one too.
"""
