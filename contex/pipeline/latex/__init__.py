"""
Producing LaTeX, checking it, and turning it into something to look at.

    assemble    positioned OCR blocks -> a document
    validate    is it well formed, and does it try to reach outside itself?
    engine      find a TeX engine, run it in a sandbox, rasterise the result
    documents   splice per-page documents into one

The split is between authoring (assemble, documents), judging (validate) and
running (engine). Only `engine` shells out.
"""

from contex.pipeline.latex.documents import merge_documents, split_document  # noqa: F401
from contex.pipeline.latex.engine import (                                   # noqa: F401
    compile_tex, engine_name, extract_errors, find_engine, missing_packages,
    render_pages, source_sha,
)
from contex.pipeline.latex.validate import static_validate, unsafe_constructs  # noqa: F401

__all__ = [
    'static_validate', 'unsafe_constructs',
    'find_engine', 'engine_name', 'compile_tex', 'render_pages',
    'extract_errors', 'missing_packages', 'source_sha',
    'split_document', 'merge_documents',
]
