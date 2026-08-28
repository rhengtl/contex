"""
What the application accepts, and how a file becomes pages.

Everything upstream of recognition lives here: which extensions are allowed,
how many pages a document has, and how to turn an upload into a list of images
the recognisers can read.

ACCEPTED is the single source of truth for the file types. The web layer
imports it to build the file picker, so the control cannot offer something the
converter will refuse - which it could when the two kept their own lists.
"""

import io
import os

from PIL import Image

from contex import config

#: Everything the pipeline can read. The picker, the drop area and the route
#: all derive from this.
IMAGE_TYPES = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.gif',
               '.webp'}
ACCEPTED = IMAGE_TYPES | {'.pdf', '.docx'}

#: In the order a person expects to see them offered.
ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif',
                       '.webp', '.gif', '.pdf', '.docx']


def _check_input(filename):
    """
    Reject an unusable file type before any path starts.

    Cheap on purpose: the AI path reads PDFs natively, so rasterising one just
    to validate it would throw away the speed advantage.
    """
    extension = os.path.splitext(filename or '')[1].lower()
    if extension and extension not in ACCEPTED:
        raise RuntimeError(f"Unsupported file type: '{extension}'")


def page_count(file_bytes, filename):
    """How many pages this upload has, capped at the configured limit."""
    if os.path.splitext(filename or '')[1].lower() != '.pdf':
        return 1
    limit = config.integer('UNIFIED_MAX_PDF_PAGES', 10)
    try:
        import pikepdf
        with pikepdf.open(io.BytesIO(file_bytes)) as pdf:
            return max(1, min(len(pdf.pages), limit))
    except Exception:
        return 1


def _pages(file_bytes, filename, first=1):
    """
    Yield PIL pages from an upload, starting at page `first`.

    `first` matters when the AI converted the opening pages and only the tail
    needs the local engines: a ten-page PDF that lost the AI on page nine
    should not pay to rasterise the eight pages it already has better output
    for. It also means a failure while rendering the tail cannot destroy work
    that is already finished.

    This is also where the equation converter's old limitation goes away: it
    could only ever open an image, so a PDF raised UnidentifiedImageError.
    Rasterise once here and both engines get pages they can read.
    """
    extension = os.path.splitext(filename or '')[1].lower()
    if extension == '.pdf':
        try:
            from pdf2image import convert_from_bytes
        except ImportError:
            raise RuntimeError(
                "PDF support needs 'pdf2image' and Poppler on PATH.")
        limit = config.integer('UNIFIED_MAX_PDF_PAGES', 10)
        try:
            return convert_from_bytes(file_bytes, first_page=max(1, first),
                                      last_page=limit)
        except Exception as exc:
            if 'poppler' in str(exc).lower() or 'pdfinfo' in str(exc).lower():
                raise RuntimeError(
                    'Poppler was not found. Install it and add it to PATH.')
            raise RuntimeError(f'Could not read the PDF: {exc}')

    if extension and extension not in IMAGE_TYPES:
        raise RuntimeError(f"Unsupported file type: '{extension}'")
    if first > 1:
        return []          # a single-page input has no page two
    try:
        image = Image.open(io.BytesIO(file_bytes))
        image.load()
        return [image]
    except Exception as exc:
        raise RuntimeError(f'Could not read the image: {exc}')


def _split_pdf(file_bytes, limit):
    """
    Cut a PDF into one single-page PDF per page.

    Single-page PDFs rather than rasterised images: the model reads a PDF page
    natively, including any text layer, and rendering it to a bitmap first
    would discard that for no reason. Returns None when the file cannot be
    split, which sends the whole document in one call instead.
    """
    try:
        import pikepdf
    except ImportError:
        return None
    try:
        with pikepdf.open(io.BytesIO(file_bytes)) as pdf:
            total = min(len(pdf.pages), limit)
            if total <= 1:
                return None
            out = []
            for index in range(total):
                with pikepdf.new() as single:
                    single.pages.append(pdf.pages[index])
                    buffer = io.BytesIO()
                    single.save(buffer)
                    out.append(buffer.getvalue())
            return out
    except Exception as exc:
        print(f'Notice: could not split the PDF into pages ({exc}).')
        return None


