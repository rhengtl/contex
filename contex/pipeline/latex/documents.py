"""
Assembling one LaTeX document out of several.

A PDF is converted a page at a time - see pipeline/run.py for why - so the
pipeline ends up holding one complete document per page and has to splice them
into one. That is a text operation on LaTeX source: take the union of the
preambles, concatenate the bodies, and keep each page's local settings from
leaking into the next.

Separate from engine.py because this is authoring, not compiling: it decides
what the document says, and never runs anything.
"""

import re

# ---------------------------------------------------------------------------
# Joining several generated documents into one
# ---------------------------------------------------------------------------

_DOCUMENTCLASS = re.compile(r'^\s*\\documentclass\b.*$', re.MULTILINE)
_BODY = re.compile(r'\\begin\{document\}(.*?)\\end\{document\}', re.DOTALL)
_TITLE_MACROS = re.compile(
    r'^\s*\\(?:title|author|date|maketitle)\b.*$', re.MULTILINE)

# What separates one source page from the next in a joined document.
_PAGE_BREAK = '\n\n\\clearpage\n\n'

# Styling that describes one page and must not outlive it. \pagecolor is the
# reason this exists: LaTeX applies it to every page from that point on, so a
# navy page one turns the whole document navy while only page one carries the
# light text meant to sit on it - white on white from page two onward.
# \definecolor is deliberately not here: naming a colour is harmless, and the
# pages that use the name need it to stay in the preamble.
_PAGE_STYLE = re.compile(
    r'^\s*\\(?:pagecolor|nopagecolor|color|normalcolor)\b.*$', re.MULTILINE)

# A body that defines macros must not be wrapped in a group: the definition
# would be scoped away and every later page using it would fail to compile.
_MACRO_DEF = re.compile(
    r'\\(?:new|renew|provide)command|\\def\b|\\newenvironment')

_XCOLOR = re.compile(r'\\usepackage[^{]*\{[^}]*\bxcolor\b[^}]*\}')
_COLOR_PACKAGE = re.compile(r'\\usepackage[^{]*\{[^}]*\bx?color\b[^}]*\}')



def _page_reset(preamble_text, body_text):
    """
    What has to be undone at a page boundary, or '' when nothing does.

    Grouping restores the text colour on its own, but a page background is
    global by design and has to be turned off explicitly.
    """
    if not _PAGE_STYLE.search(body_text) and not _PAGE_STYLE.search(preamble_text):
        return ''
    if _XCOLOR.search(preamble_text):
        # xcolor's own "no background at all", rather than painting white over
        # whatever the page would otherwise show.
        return '\\nopagecolor\\normalcolor'
    if _COLOR_PACKAGE.search(preamble_text):
        return '\\pagecolor{white}\\normalcolor'
    return '\\normalcolor'


def _scoped(body):
    """One page's body, with its formatting confined to that page."""
    if _MACRO_DEF.search(body):
        # A definition is not formatting: scoping it away would break every
        # later page that uses it, so this body is left ungrouped.
        return body
    return '\\begingroup\n' + body + '\n\\endgroup'


def split_document(tex):
    """
    Return (documentclass_line, preamble_lines, body) for one document.

    A document with no \\begin{document} at all is treated as a bare body,
    which is what a model occasionally returns when a page holds nothing but
    an formulas.
    """
    text = tex or ''
    match = _DOCUMENTCLASS.search(text)
    documentclass = match.group(0).strip() if match else ''

    body_match = _BODY.search(text)
    if not body_match:
        return documentclass, [], text.strip()

    body = body_match.group(1).strip()
    head = text[:body_match.start()]
    if match:
        head = head[match.end():]
    preamble = [line.rstrip() for line in head.splitlines() if line.strip()]
    return documentclass, preamble, body


def merge_documents(documents):
    """
    Splice per-page LaTeX documents into one.

    Converting a multi-page PDF page by page is what lets a conversion survive
    losing the AI half way through: the pages already done keep their
    AI output and only the remainder falls back. The cost is that each page
    arrives as its own complete document, so the preambles have to be
    reconciled rather than concatenated - four copies of \\usepackage{amsmath}
    compiles with warnings at best, and four \\maketitle calls is three
    spurious title pages.

    Package and macro lines are unioned in first-seen order; title macros are
    kept from the first document that has them and dropped from the rest.
    """
    kept = [doc for doc in documents if (doc or '').strip()]
    if not kept:
        return ''
    if len(kept) == 1:
        return kept[0]

    documentclass = ''
    preamble, seen = [], set()
    bodies = []
    have_title = False

    for document in kept:
        this_class, lines, body = split_document(document)
        if not documentclass and this_class:
            documentclass = this_class

        page_style = []
        for line in lines:
            if have_title and _TITLE_MACROS.match(line):
                continue
            if _PAGE_STYLE.match(line):
                # A background set in this page's preamble describes this page.
                # Left in the shared preamble it would describe all of them, so
                # it moves into the body it belongs to.
                page_style.append(line.strip())
                continue
            key = ' '.join(line.split())
            if key in seen:
                continue
            seen.add(key)
            preamble.append(line)

        if body:
            if have_title:
                body = _TITLE_MACROS.sub('', body).strip()
        body = '\n'.join(page_style + ([body] if body else []))
        if body.strip():
            bodies.append(body)
        if _TITLE_MACROS.search(document):
            have_title = True

    parts = [documentclass or '\\documentclass{article}']
    parts += preamble
    parts += ['', '\\begin{document}', '']
    # One source page per output page. Without a break here LaTeX sets the
    # bodies as continuous copy, so a short page pulls the next page's opening
    # lines up to fill it and every page after that drifts. \clearpage rather
    # than \newpage: it also flushes pending floats, so a figure from one page
    # cannot be deferred onto a later one.
    #
    # The reset goes after the break, never before it, so the page that asked
    # for a background still gets it and only the pages after it are spared.
    reset = _page_reset('\n'.join(preamble), '\n\n'.join(bodies))
    separator = ('\n\n\\clearpage\n' + reset + '\n\n') if reset else _PAGE_BREAK
    parts.append(separator.join(_scoped(body) for body in bodies))
    parts += ['', '\\end{document}', '']
    return '\n'.join(parts)
