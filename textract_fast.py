# textract_fast.py
import pytesseract
from PIL import Image
import os
import numpy as np

# Attempt to import pdf2image
try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

# Set the path to the tesseract executable if it's not in your PATH
# For local Windows development
if os.name == 'nt':  # Windows
    pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
# On Linux (Render), tesseract should be in PATH automatically

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
