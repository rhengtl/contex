"""
Reading Microsoft Word (.docx) documents.

A .docx is not a picture of a page - it is already structured text. Rasterising
one and running OCR over it would throw away everything the file already knows
(which paragraph is a heading, where a table's cells begin and end, what the
equations actually say) and then try to guess it back from pixels, badly. So
this module reads the structure directly and hands it on as text.

    .docx -> ordered blocks (heading / paragraph / list / table / equation)
                |
                +-- outline()  a marked-up plain-text view, for the AI to
                |              turn into idiomatic LaTeX
                |
                +-- to_tex()   a direct, deterministic rendering, used when
                               the AI is unavailable

The fallback here is much stronger than the OCR fallback, because nothing has
to be recognised: the words are already the words. What the AI adds is
judgement about LaTeX form - which environment suits a given table, how a
run of equations should be grouped, whether a bold line is really a heading.

Word equations are stored as OMML, not LaTeX. Recovering exact LaTeX from OMML
needs a full converter; what is done here is to pull out the symbols in reading
order and mark the span, so the AI can reconstruct the mathematics with the
surrounding sentence for context. That is a real limitation and it is reported
to the user rather than hidden.
"""

import io
import re

# OMML lives in this namespace inside a Word paragraph.
_M = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'
_W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


class DocxError(RuntimeError):
    """The file could not be read as a Word document."""


def is_docx(filename):
    return (filename or '').lower().endswith('.docx')


def _require_docx():
    try:
        import docx
    except ImportError as exc:
        raise DocxError(
            "Word support needs the 'python-docx' package. "
            "Run: pip install python-docx") from exc
    return docx


def _math_text(node):
    """Symbols of one OMML expression, in reading order."""
    return ''.join(t.text or '' for t in node.iter(f'{_M}t')).strip()


def _paragraph_text(paragraph):
    """
    Paragraph text with any Word equations marked in place.

    python-docx's `.text` silently drops OMML, so an equation in the middle of
    a sentence would vanish without a trace. Walking the XML keeps it, and
    keeps it in the right position in the sentence.
    """
    element = paragraph._p
    pieces = []
    for child in element.iter():
        tag = child.tag
        if tag == f'{_M}oMath':
            expression = _math_text(child)
            if expression:
                pieces.append(f'[MATH]{expression}[/MATH]')
        elif tag == f'{_W}t' and not _inside_math(child):
            pieces.append(child.text or '')
        elif tag == f'{_W}tab' and not _inside_math(child):
            pieces.append('\t')
        elif tag == f'{_W}br' and not _inside_math(child):
            pieces.append('\n')
    return ''.join(pieces).strip()


def _inside_math(node):
    """True when this run belongs to an equation we already captured whole."""
    parent = node.getparent()
    while parent is not None:
        if parent.tag in (f'{_M}oMath', f'{_M}oMathPara'):
            return True
        parent = parent.getparent()
    return False


def _list_level(paragraph):
    """Indent level for a numbered or bulleted paragraph, or None."""
    numbering = paragraph._p.find(f'{_W}pPr/{_W}numPr')
    if numbering is None:
        style = (paragraph.style.name or '').lower()
        if 'list' in style and 'paragraph' not in style:
            return 0
        return None
    level = numbering.find(f'{_W}ilvl')
    try:
        return int(level.get(f'{_W}val')) if level is not None else 0
    except (TypeError, ValueError):
        return 0


def _ordered(paragraph):
    """True when the list is numbered rather than bulleted (best effort)."""
    style = (paragraph.style.name or '').lower()
    return 'number' in style


_HEADING = re.compile(r'^heading\s*(\d+)$', re.IGNORECASE)


def _heading_level(paragraph):
    match = _HEADING.match((paragraph.style.name or '').strip())
    if match:
        return min(int(match.group(1)), 5)
    if (paragraph.style.name or '').strip().lower() == 'title':
        return 0
    return None


def extract(file_bytes):
    """
    Read a .docx into ordered blocks.

    Returns (blocks, notes). Each block is a dict with a 'kind' of 'title',
    'heading', 'paragraph', 'list', 'equation' or 'table'. Body children are
    walked in document order, so a table between two paragraphs stays between
    them - reading paragraphs and tables separately, as the obvious python-docx
    idiom does, would silently reorder the document.
    """
    docx = _require_docx()
    try:
        document = docx.Document(io.BytesIO(file_bytes))
    except Exception as exc:
        raise DocxError(f'Could not read the Word document: {exc}') from exc

    from docx.table import Table
    from docx.text.paragraph import Paragraph

    blocks, notes = [], []
    equations = 0
    body = document.element.body

    for child in body.iterchildren():
        if child.tag == f'{_W}p':
            paragraph = Paragraph(child, document)
            text = _paragraph_text(paragraph)
            if not text:
                continue
            equations += text.count('[MATH]')

            level = _heading_level(paragraph)
            if level == 0:
                blocks.append({'kind': 'title', 'text': text})
                continue
            if level:
                blocks.append({'kind': 'heading', 'level': level, 'text': text})
                continue

            indent = _list_level(paragraph)
            if indent is not None:
                blocks.append({'kind': 'list', 'level': indent, 'text': text,
                               'ordered': _ordered(paragraph)})
                continue

            # A paragraph that is nothing but one equation is displayed maths.
            stripped = text.strip()
            if (stripped.startswith('[MATH]') and stripped.endswith('[/MATH]')
                    and stripped.count('[MATH]') == 1):
                blocks.append({'kind': 'equation',
                               'text': stripped[6:-7].strip()})
                continue

            blocks.append({'kind': 'paragraph', 'text': text})

        elif child.tag == f'{_W}tbl':
            table = Table(child, document)
            rows = []
            for row in table.rows:
                rows.append([' '.join(cell.text.split()) for cell in row.cells])
            if rows:
                blocks.append({'kind': 'table', 'rows': rows})

    if not blocks:
        raise DocxError('That Word document appears to be empty.')

    if equations:
        notes.append(
            f'{equations} Word equation(s) were found. Word stores equations '
            'as OMML, not LaTeX, so their symbols were extracted and rebuilt '
            'as LaTeX - check these against your original.')

    images = body.findall(f'.//{_W}drawing')
    if images:
        notes.append(
            f'{len(images)} embedded image(s) were skipped. LaTeX cannot '
            'reference files that will not exist alongside the .tex.')

    return blocks, notes


# ---------------------------------------------------------------------------
# Two renderings of the same blocks
# ---------------------------------------------------------------------------

def outline(blocks):
    """
    A plain-text view with the structure marked, for the model to work from.

    Markers rather than LaTeX on purpose: handing the model half-written LaTeX
    invites it to preserve the mistakes in it. Plain structure lets it choose
    the LaTeX.
    """
    lines = []
    for block in blocks:
        kind = block['kind']
        if kind == 'title':
            lines.append(f"[TITLE] {block['text']}")
        elif kind == 'heading':
            lines.append(f"[HEADING {block['level']}] {block['text']}")
        elif kind == 'list':
            bullet = '#' if block.get('ordered') else '-'
            lines.append(f"[LIST {block['level']}] {bullet} {block['text']}")
        elif kind == 'equation':
            lines.append(f"[DISPLAY EQUATION] {block['text']}")
        elif kind == 'table':
            lines.append('[TABLE]')
            for row in block['rows']:
                lines.append('  | ' + ' | '.join(row) + ' |')
            lines.append('[/TABLE]')
        else:
            lines.append(block['text'])
        lines.append('')
    return '\n'.join(lines).strip()


_SPECIALS = {'\\': r'\textbackslash{}', '&': r'\&', '%': r'\%', '$': r'\$',
             '#': r'\#', '_': r'\_', '{': r'\{', '}': r'\}',
             '~': r'\textasciitilde{}', '^': r'\textasciicircum{}'}


def _escape(text):
    return ''.join(_SPECIALS.get(char, char) for char in text)


_MATH_SPAN = re.compile(r'\[MATH\](.*?)\[/MATH\]', re.DOTALL)


def _prose(text):
    """Escape prose but leave marked equations as mathematics."""
    out, cursor = [], 0
    for match in _MATH_SPAN.finditer(text):
        out.append(_escape(text[cursor:match.start()]))
        out.append('$' + match.group(1).strip() + '$')
        cursor = match.end()
    out.append(_escape(text[cursor:]))
    return ''.join(out)


_SECTIONS = ['section', 'subsection', 'subsubsection', 'paragraph',
             'subparagraph']


def to_tex(blocks):
    """
    Render blocks straight to LaTeX, with no model involved.

    This is the .docx fallback, and it is a genuinely good one: the text is
    already correct, so only its LaTeX form is unaided. Equations recovered
    from OMML are the weak point and stay the weak point on either path.
    """
    body, in_list, ordered = [], False, False

    def close_list():
        nonlocal in_list
        if in_list:
            body.append('\\end{' + ('enumerate' if ordered else 'itemize') + '}')
            in_list = False

    title = None
    for block in blocks:
        kind = block['kind']
        if kind != 'list':
            close_list()

        if kind == 'title':
            title = _prose(block['text'])
        elif kind == 'heading':
            name = _SECTIONS[min(block['level'], len(_SECTIONS)) - 1]
            body.append(f"\\{name}{{{_prose(block['text'])}}}")
        elif kind == 'paragraph':
            body.append(_prose(block['text']))
        elif kind == 'equation':
            body.append('\\[\n  ' + block['text'].strip() + '\n\\]')
        elif kind == 'list':
            if not in_list:
                ordered = bool(block.get('ordered'))
                body.append('\\begin{'
                            + ('enumerate' if ordered else 'itemize') + '}')
                in_list = True
            body.append('  \\item ' + _prose(block['text']))
        elif kind == 'table':
            body.append(_table_tex(block['rows']))
    close_list()

    preamble = ['\\documentclass{article}',
                '\\usepackage[utf8]{inputenc}',
                '\\usepackage{amsmath}',
                '\\usepackage{amssymb}']
    head = []
    if title:
        preamble.append('')
        head = ['\\title{' + title + '}', '\\maketitle', '']
    return ('\n'.join(preamble) + '\n\n\\begin{document}\n\n'
            + '\n'.join(head + body).strip()
            + '\n\n\\end{document}\n')


def _table_tex(rows):
    width = max(len(row) for row in rows)
    spec = '|' + 'l|' * width
    out = ['\\begin{center}', '\\begin{tabular}{' + spec + '}', '\\hline']
    for index, row in enumerate(rows):
        cells = [_prose(cell) for cell in row] + [''] * (width - len(row))
        out.append('  ' + ' & '.join(cells) + ' \\\\')
        out.append('\\hline' if index == 0 else '\\hline')
    out += ['\\end{tabular}', '\\end{center}']
    return '\n'.join(out)
