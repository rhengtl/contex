# textract_fast.py
import pytesseract
from PIL import Image
import os
import shutil

import preprocess

# Attempt to import pdf2image
try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

# Resolve the tesseract executable.
# Order: TESSERACT_CMD env var -> whatever is already on PATH -> common install locations.
# On Linux (Render) tesseract is on PATH automatically, so which() covers it.
def _resolve_tesseract_cmd():
    explicit = os.getenv('TESSERACT_CMD')
    if explicit and os.path.exists(explicit):
        return explicit

    on_path = shutil.which('tesseract')
    if on_path:
        return on_path

    if os.name == 'nt':  # Windows fallbacks
        for candidate in (
            r'C:\Program Files\Tesseract-OCR\tesseract.exe',
            r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
            r'D:\Apps\Tesseract-OCR\tesseract.exe',
        ):
            if os.path.exists(candidate):
                return candidate
    return None


_TESSERACT_CMD = _resolve_tesseract_cmd()
if _TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = _TESSERACT_CMD
else:
    print("WARNING: Tesseract executable not found. Set TESSERACT_CMD in your .env, "
          "or install it from https://github.com/UB-Mannheim/tesseract/wiki")

def extract_text_from_file(file_path, languages='eng'):
    """
    Processes the given image or PDF file and returns the extracted text using Tesseract.
    """
    if not os.path.exists(file_path):
        return f"Error: File not found at '{file_path}'"

    file_extension = os.path.splitext(file_path)[1].lower()
    image_extensions = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff']

    extracted_text = []

    try:
        if file_extension in image_extensions:
            image = Image.open(file_path)
            # Condition the page first. The benchmark in bench/ measured a
            # rotated page dropping Tesseract to 28% char accuracy - and at the
            # default PSM it returns an empty string, so the user saw a blank
            # result with no error at all.
            image, _notes = preprocess.prepare_image(image)
            text = pytesseract.image_to_string(image, lang=languages)
            extracted_text.append(text)

        elif file_extension == '.pdf':
            if not PDF2IMAGE_AVAILABLE:
                return "Error: PDF processing requires 'pdf2image' and Poppler."

            try:
                images_from_pdf = convert_from_path(file_path)
            except Exception as e_pdf:
                if "Poppler" in str(e_pdf) or "pdfinfo" in str(e_pdf):
                    return "Error: Poppler not found. Please install Poppler and add it to PATH."
                return f"Error converting PDF to images: {e_pdf}"

            for i, pil_page_image in enumerate(images_from_pdf):
                # Rasterised PDF pages get the same conditioning as a photo:
                # a scanned-in page can be just as skewed.
                pil_page_image, _notes = preprocess.prepare_image(pil_page_image)
                # Tesseract works directly with PIL images
                text = pytesseract.image_to_string(pil_page_image, lang=languages)
                extracted_text.append(text)

        else:
            return f"Unsupported file type: '{file_extension}'"

    except Exception as e:
        if "tesseract is not installed" in str(e).lower():
             return "Error: Tesseract is not installed or not in PATH. Please install it from https://github.com/UB-Mannheim/tesseract/wiki"
        return f"Unexpected error during OCR: {e}"
    
    return '\n'.join(extracted_text)

def extract_lines(image, languages='eng'):
    """
    Read a page and return its lines **with geometry and confidence**.

    `image_to_string` throws all of this away, but the unified pipeline needs
    it for two things:

      position    Each line's box says where it sits, which is what lets an
                  equation be spliced back into the right place in the flow.
      confidence  Tesseract has no mathematical model, so where a formula is it
                  guesses at glyphs and its confidence collapses. Measured
                  across bench/img_pages: prose lines never drop below 43,
                  while every line overlapping display maths falls to 0-5. That
                  is the text/maths discriminator, and it costs nothing.

    Returns a list of dicts: text, box (left, top, right, bottom), min_conf,
    mean_conf, and Tesseract's own block/paragraph/line numbering, which is
    reading order as the engine understood it.
    """
    data = pytesseract.image_to_data(image, lang=languages,
                                     output_type=pytesseract.Output.DICT)
    grouped = {}
    for index, raw_text in enumerate(data['text']):
        text = (raw_text or '').strip()
        if not text:
            continue
        try:
            confidence = int(float(data['conf'][index]))
        except (TypeError, ValueError):
            confidence = -1
        if confidence < 0:
            continue
        key = (data['block_num'][index], data['par_num'][index],
               data['line_num'][index])
        left, top = data['left'][index], data['top'][index]
        right = left + data['width'][index]
        bottom = top + data['height'][index]
        entry = grouped.get(key)
        if entry is None:
            grouped[key] = {
                'words': [text], 'confs': [confidence],
                'box': [left, top, right, bottom],
                'block': key[0], 'par': key[1], 'line': key[2],
            }
        else:
            entry['words'].append(text)
            entry['confs'].append(confidence)
            box = entry['box']
            box[0] = min(box[0], left)
            box[1] = min(box[1], top)
            box[2] = max(box[2], right)
            box[3] = max(box[3], bottom)

    lines = []
    for entry in grouped.values():
        confs = entry['confs']
        lines.append({
            'text': ' '.join(entry['words']),
            'box': tuple(entry['box']),
            'min_conf': min(confs),
            'mean_conf': sum(confs) / len(confs),
            'block': entry['block'], 'par': entry['par'], 'line': entry['line'],
        })
    # Reading order: down the page, then across.
    lines.sort(key=lambda item: (item['box'][1], item['box'][0]))
    return lines


# Characters that are syntax in LaTeX and must be escaped before raw OCR text
# can be dropped into a document. Without this, any page containing a '%' or a
# '&' produced a .tex file that silently lost content or failed to compile.
_TEX_ESCAPES = {
    '\\': r'\textbackslash{}',
    '&': r'\&',
    '%': r'\%',
    '$': r'\$',
    '#': r'\#',
    '_': r'\_',
    '{': r'\{',
    '}': r'\}',
    '~': r'\textasciitilde{}',
    '^': r'\textasciicircum{}',
}


# Symbols Tesseract emits as Unicode that LaTeX cannot typeset as literal text.
# Without these a single misread glyph - a stray guillemet, a maths sign picked
# up from an equation - makes the whole generated .tex fail to compile.
_TEX_UNICODE = {
    '≤': r'$\le$', '≥': r'$\ge$', '≠': r'$\neq$',
    '×': r'$\times$', '÷': r'$\div$', '±': r'$\pm$',
    '√': r'$\sqrt{\ }$', '∞': r'$\infty$', '∑': r'$\sum$',
    '∫': r'$\int$', '∂': r'$\partial$', '→': r'$\rightarrow$',
    '←': r'$\leftarrow$', '⇒': r'$\Rightarrow$',
    '≈': r'$\approx$', '≡': r'$\equiv$', '−': '-',
    '·': r'$\cdot$', '′': r"$'$", '°': r'$^{\circ}$',
    '—': '---', '–': '--', '…': r'\ldots{}',
    '“': '``', '”': "''", '‘': '`', '’': "'",
    ' ': ' ',
}

# Greek letters arrive whenever a formula bleeds into the text layer.
_GREEK = ('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
          'nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega')
for _index, _name in enumerate(_GREEK.split()):
    if _name != 'omicron' and _name != 'sigmaf':
        _TEX_UNICODE.setdefault(chr(0x3B1 + _index), f'$\\{_name}$')


def escape_tex(text):
    """
    Make plain OCR text safe to drop into a LaTeX document.

    Escapes the ten special characters, maps the Unicode symbols OCR commonly
    emits onto LaTeX equivalents, and replaces anything left that LaTeX cannot
    render with '?'. Losing one unrecognisable glyph is far better than losing
    the whole file to a fatal compile error.
    """
    out = []
    for ch in text or '':
        if ch in _TEX_ESCAPES:
            out.append(_TEX_ESCAPES[ch])
        elif ch in _TEX_UNICODE:
            out.append(_TEX_UNICODE[ch])
        elif ch in '\n\r\t' or ord(ch) < 127:
            out.append(ch)
        elif ord(ch) <= 0xFF:
            # Latin-1: typeset correctly once T1 font encoding is loaded.
            out.append(ch)
        else:
            out.append('?')
    return ''.join(out)


def generate_tex_source(text):
    """
    Wrap plain extracted text in a minimal LaTeX document and return the source.

    This is the fixed-format output of the Tesseract pipeline: it preserves the
    words, not the structure of the page. Recovering headings, equations and
    tables is the job of the review stage in ai_qa.py.
    """
    # T1 font encoding is what makes accented and Latin-1 characters typeset
    # instead of aborting the compile.
    return f"""\\documentclass{{article}}
\\usepackage[utf8]{{inputenc}}
\\usepackage[T1]{{fontenc}}
\\begin{{document}}

{escape_tex(text)}

\\end{{document}}
"""
