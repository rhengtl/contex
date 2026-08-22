# textract_fast.py
import pytesseract
from PIL import Image
import os
import shutil
import numpy as np

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

def generate_tex_file(text, output="output.tex"):
    tex_content = f"""\\documentclass{{article}}
\\usepackage[utf8]{{inputenc}}
\\begin{{document}}

{text}

\\end{{document}}
"""
    try:
        with open(output, 'w', encoding='utf-8') as tex_file:
            tex_file.write(tex_content)
        return output
    except Exception as e:
        return f"Error writing .tex file: {e}"
