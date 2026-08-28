"""
The conversion pipeline, in the order it runs.

    inputs        what is accepted, and how a file becomes pages
    preprocess    deskew, EXIF rotation, alpha flattening, upscaling
    recognise/    reading a page: the model, Tesseract, formulas, Word
    latex/        assembling, validating, compiling and merging the result
    run           the orchestrator: which path a document takes, and why

`convert()` is the one entry point. Everything else in this package is a step
it uses, and every step is importable and testable on its own - which is the
point of the split: the AI path, the local path and the LaTeX validator can
each be exercised without starting a web server.
"""

from contex.pipeline.run import (          # noqa: F401
    FallbackNotAuthorized, convert, page_count,
)

__all__ = ['convert', 'FallbackNotAuthorized', 'page_count']
