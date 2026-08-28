"""
How a response travels: compressed, and cacheable.

Two hooks about transport rather than content - gzip for the text types, and a
?v= stamp on every static URL so a stylesheet can be cached for a year and
still update the instant it changes.
"""

import gzip
import os

from flask import current_app, request



def add_static_version(endpoint, values):
    """
    Stamp every static URL with the file's modification time.

    Without this the browser has to ask whether scripts.js changed on every
    single page load, and gets told "no" - a round trip to learn nothing. With
    it the answer is in the URL, so the file is taken from cache with no
    request at all, and a genuine edit is picked up immediately because the URL
    is different.
    """
    if endpoint != 'static' or 'filename' not in values:
        return
    try:
        path = os.path.join(current_app.static_folder, values['filename'])
        values['v'] = int(os.stat(path).st_mtime)
    except OSError:
        pass  # a missing file is the 404's problem, not this hook's


# Responses worth compressing: markup, styles, scripts and JSON. Everything
# else this app sends - PNG page images, PDFs - is already compressed, and
# running them through gzip would cost CPU to make them very slightly larger.
_COMPRESSIBLE = ('text/html', 'text/css', 'text/plain', 'application/javascript',
                 'text/javascript', 'application/json', 'application/x-tex',
                 'image/svg+xml')
_COMPRESS_MIN_BYTES = 1024

# Static files are streamed rather than buffered, so compressing one means
# reading it into memory first. That is fine for a stylesheet and pointless for
# anything large, hence the ceiling.
_COMPRESS_MAX_BYTES = 4 * 1024 * 1024


def compress_response(response):
    """
    gzip text responses when the client asked for it.

    The home page is 28 KB of markup and scripts.js is 57 KB; both are mostly
    repeated class names and compress to roughly a fifth. On a phone that is
    the difference between one round trip and several.

    Only the types listed above: the page images and PDFs this app serves are
    compressed formats already, and running them through gzip would spend CPU
    to make them marginally larger.
    """
    if (response.status_code < 200 or response.status_code >= 300
            or 'Content-Encoding' in response.headers):
        return response
    if 'gzip' not in request.headers.get('Accept-Encoding', '').lower():
        return response
    if (response.mimetype or '') not in _COMPRESSIBLE:
        return response

    response.headers.add('Vary', 'Accept-Encoding')
    length = response.content_length
    if length is not None and not (_COMPRESS_MIN_BYTES <= length
                                   <= _COMPRESS_MAX_BYTES):
        return response
    if response.direct_passthrough:
        # A streamed file response. Turning passthrough off makes get_data()
        # read the file wrapper, which is what we need in order to compress it.
        response.direct_passthrough = False
    body = response.get_data()
    if not (_COMPRESS_MIN_BYTES <= len(body) <= _COMPRESS_MAX_BYTES):
        return response

    # mtime=0 so the same bytes always produce the same output, which keeps
    # ETags stable across restarts.
    packed = gzip.compress(body, compresslevel=6, mtime=0)
    if len(packed) >= len(body):
        return response
    response.set_data(packed)
    response.headers['Content-Encoding'] = 'gzip'
    response.headers['Content-Length'] = str(len(packed))
    return response


def install(app):
    """Attach these hooks to an application."""
    app.url_defaults(add_static_version)
    app.after_request(compress_response)
