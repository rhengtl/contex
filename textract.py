# ocr_utils.py

import easyocr
import os
import numpy as np
from PIL import Image

# Attempt to import pdf2image and set a flag
try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

available_languages = ['en', 'es']  # Default OCR languages


def extract_text_from_file(file_path, languages=available_languages):
    """
    Processes the given image or PDF file and returns the extracted text as a string.
    """
    if not os.path.exists(file_path):
        return f"Error: File not found at '{file_path}'"

    try:
        reader = easyocr.Reader(languages)
    except Exception as e:
        return f"Error initializing EasyOCR Reader: {e}"

    file_extension = os.path.splitext(file_path)[1].lower()
    image_extensions = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff']

    extracted_text = []

    try:
        if file_extension in image_extensions:
            results = reader.readtext(file_path)
            if results:
                combined_text = ' '.join([text_item[1] for text_item in results])
                extracted_text.append(combined_text)
            else:
                extracted_text.append("No text detected in the image.")

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
                image_np = np.array(pil_page_image)
                page_results = reader.readtext(image_np)
                if page_results:
                    combined_text_page = ' '.join([text_item[1] for text_item in page_results])
                    extracted_text.append(f"[Page {i+1}] {combined_text_page}")
                else:
                    extracted_text.append(f"[Page {i+1}] No text detected.")

        else:
            return f"Unsupported file type: '{file_extension}'"

    except Exception as e:
        return f"Unexpected error during OCR: {e}"

    return '\n'.join(extracted_text)