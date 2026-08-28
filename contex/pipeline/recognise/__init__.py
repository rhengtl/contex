"""
Reading a page: four backends, one job each.

    ai          the model reads the page and writes the LaTeX (preferred)
    tesseract   local OCR for prose
    formulas    local formula recognition (pix2text-mfr on ONNX Runtime)
    word        .docx read structurally - never OCR'd, because a Word file
                already knows its own headings, cells and words

Adding a fifth means adding a module here and a branch in run.py. Nothing
else in the application needs to know it exists.
"""
