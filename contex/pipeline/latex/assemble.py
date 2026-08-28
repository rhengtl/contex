"""
Deciding what is text, what is mathematics, and what order it all goes in.

This is the piece that lets the two converters become one pipeline. Neither
engine knows about the other; both, however, report geometry in the same
coordinate space (the preprocessed page), and that shared space is the whole
trick. Tesseract says where the words are and how sure it is about them; the
segmenter says where the ink blocks are. Overlaying the two answers three
questions at once:

  Which regions are formulas?   The ones Tesseract stumbled over.
  Where does each formula go?   At the vertical position its box occupied.
  What is the reading order?    Down the page, using Tesseract's own block and
                                paragraph numbering to keep prose together.

**The discriminator is measured, not guessed.** Across bench/img_pages, taking
the lowest per-word confidence on each line:

    pages without maths   lowest min-conf 43, 81   (and one table at 0)
    pages with maths      lowest min-conf 0, 0, 0, 0, 1

So a low-confidence run is a reliable *candidate* signal - every maths page was
caught - but not a classifier, because a table trips it too. That is the right
shape for this pipeline: nominate cheaply here, transcribe with pix2text, and
let the AI review reject whatever was not really an formulas. It already does
exactly that, marking headings and prose `not_an_equation` unprompted.
"""

import re

from contex import config

# Below this Tesseract is guessing at glyphs rather than reading words.
#
# This floor only ever judges lines that are NOT prose - prose is protected
# separately - so it is set from where garbled maths actually lands rather than
# from the prose/maths page-level gap. Measured on bench/img_pages, the two
# align equations Tesseract mangled into "(a+b)? =a + 2ab+0?" scored 41 and 31,
# while the table rows it read correctly scored 93-96. 50 sits in that gap.
_CONF_FLOOR = 50

# A nominated region has to be tall enough to be a displayed formula rather
# than a speck or an underline.
_MIN_EQUATION_HEIGHT = 14

# How much of a text line must sit inside an equation box before we treat that
# line as belonging to the formula and drop its words. Generous, because
# Tesseract's boxes for garbled maths are ragged.
_OVERLAP = 0.5


def conf_floor():
    return config.integer('UNIFIED_CONF_FLOOR', _CONF_FLOOR)


def _overlap(first, second):
    """Vertical overlap of two boxes as a fraction of the shorter one."""
    top = max(first[1], second[1])
    bottom = min(first[3], second[3])
    if bottom <= top:
        return 0.0
    shorter = min(first[3] - first[1], second[3] - second[1])
    return (bottom - top) / shorter if shorter else 0.0


_WORD = re.compile(r'[A-Za-z]{3,}')

# How many real words (three or more letters) a line needs before it counts as
# a sentence rather than part of a formula. Three separates the cases that
# actually occur: "The Fourier transform of f is" has six, while the garbled
# maths line "lim =1, o =aVu." has two and an equation number "(1)" has none.
_PROSE_WORDS = 3


def _is_prose(text):
    """
    Is this line a sentence, or something inside a formula?

    This decides two things at once. A prose line may carve a region, and a
    prose line is never sent to the formula model.

    Both directions were measured. Carving on anything confident shredded
    formulas, because Tesseract reads an equation number "(1)" or a lone
    numerator "1" perfectly well - that took a page from 2 equations found to
    0. And *not* protecting prose sent "Einstein's mass-energy relation is
    $E = mc^2$..." to pix2text, which returned it as \\mathrm{} letter soup,
    because a line of prose with inline maths has low confidence too.

    Inline mathematics therefore stays in the text and is left to the AI
    review, which can read it off the image. Only displayed mathematics - which
    occupies its own horizontal band - goes to the formula model.
    """
    return len(_WORD.findall(text)) >= _PROSE_WORDS


def _carve(box, confident):
    """
    Remove confidently-read text lines from a region, returning what is left.

    The segmenter merges ink separated by less than a line space, so a caption
    and the formula beneath it routinely arrive as one band - measured, "The
    Fourier transform of f is" (confidence 96) merged with the integral below
    it (confidence 5). Sending the whole band to the formula model would lose
    the sentence. Subtracting the spans Tesseract read confidently leaves just
    the part it could not, which is the formula.
    """
    top, bottom = box[1], box[3]
    spans = [(top, bottom)]
    for line in confident:
        _, line_top, _, line_bottom = line['box']
        remaining = []
        for start, end in spans:
            if line_bottom <= start or line_top >= end:
                remaining.append((start, end))
                continue
            if line_top > start:
                remaining.append((start, line_top))
            if line_bottom < end:
                remaining.append((line_bottom, end))
        spans = remaining
    return [(box[0], start, box[2], end) for start, end in spans
            if end - start >= _MIN_EQUATION_HEIGHT]


def nominate(lines, boxes, page_width=0):
    """
    Decide which regions are worth sending to the formula model.

    A region is nominated when it is tall enough AND either Tesseract found
    nothing there (an ink block it could not read at all) or what it did find
    was low-confidence (it tried and failed). Both are the signature of a
    region a text engine cannot handle.

    A region that mixes both is carved: the confident text stays text, and only
    the rest is nominated.

    Returns (nominated_boxes, rejected) so the caller can report what it
    skipped rather than silently discarding it.
    """
    floor = conf_floor()
    nominated, rejected = [], []
    for box in boxes:
        if box[3] - box[1] < _MIN_EQUATION_HEIGHT:
            rejected.append((box, 'too short to be a displayed formula'))
            continue

        covering = [line for line in lines
                    if _overlap(box, line['box']) >= _OVERLAP]
        if not covering:
            nominated.append(box)
            continue

        # Prose keeps its ground whatever its confidence: a confident sentence
        # is text, and an unconfident one is a sentence with inline maths,
        # which the text engine reads better than the formula model would.
        # Carve it out FIRST, then judge what is left on its own - a caption
        # sitting above a formula must not lend the formula its confidence.
        prose = [line for line in covering if _is_prose(line['text'])]
        pieces = _carve(box, prose) if prose else [box]
        if not pieces:
            rejected.append((box, 'the region is prose, not displayed maths'))
            continue

        for piece in pieces:
            inside = [line for line in lines
                      if _overlap(piece, line['box']) >= _OVERLAP]
            if not inside:
                # Ink the text engine did not report at all. Measured on a
                # rendered PDF, Tesseract returned nothing whatsoever for a
                # displayed derivative - not even garbage - so "no words here"
                # has to nominate just as loudly as "bad words here".
                nominated.append(piece)
                continue
            weakest = min(line['min_conf'] for line in inside)
            # Centring is measured on the words themselves, not on the region.
            # A region carved out of a merged band keeps the whole band's left
            # and right edges, which hides the fact that the formula inside it
            # is centred - measured, that is exactly how a printed E = mc^2
            # under a handwritten caption got missed.
            words = (min(line['box'][0] for line in inside),
                     0,
                     max(line['box'][2] for line in inside),
                     0)
            if weakest < floor:
                nominated.append(piece)
            elif is_centred(words, page_width):
                # Read confidently, but sitting centred on the page. Printed
                # algebra is made of ordinary glyphs, so Tesseract reads it
                # happily and confidence never dips - position is the only
                # signal left that this is a displayed formula.
                nominated.append(piece)
            else:
                rejected.append((piece, f'read as text (min conf {weakest})'))
    return nominated, rejected


# Something that makes an expression mathematical rather than a phrase: a
# relation, an operator, or a script.
_MATH_SIGNAL = re.compile(
    r'[=<>^_+]'
    r'|\\(?:int|sum|prod|frac|dfrac|sqrt|lim|partial|nabla|cdot|times|div'
    r'|le|ge|neq|approx|equiv|pm|mp|to|rightarrow|infty|begin\{(?:cases'
    r'|[pbvV]?matrix|align|array))')


def unwrap_text(latex):
    """
    Recover prose from what the formula model returns for a line of writing.

    Handed handwriting, pix2text-mfr answers with the letters spaced out inside
    ``\\mathrm{...}`` and word gaps marked ``~``. That is not an equation, but it
    *is* a transcription - and on handwriting it is often the only one, because
    Tesseract is 95.4% word-error-rate on handwriting and frequently returns
    nothing at all for a line.

    So instead of discarding a rejected region, unwrap it. The result is rough
    (measured: "phigsics" for "physics") and the AI review is what makes it
    right, but rough text beats a silently missing line.
    """
    if not latex:
        return ''
    text = re.sub(r'\\(?:mathrm|mathbf|mathit|mathsf|text|operatorname\*?)\s*',
                  ' ', latex)
    text = re.sub(r'\\qquad|\\quad|\\,|\\;|\\:', ' ', text)
    text = text.replace('\\!', '')
    # '~' is the word gap, so it must survive the character-run join below.
    text = text.replace('~', ' \x00 ')
    text = re.sub(r'[{}$]', ' ', text)
    text = re.sub(r'\\([A-Za-z]+)', r'\1', text)
    text = text.replace('\\', ' ')

    words, run = [], []
    for token in text.split():
        if token == '\x00':
            if run:
                words.append(''.join(run))
                run = []
        elif len(token) == 1 and token.isalnum():
            run.append(token)
        else:
            if run:
                words.append(''.join(run))
                run = []
            words.append(token)
    if run:
        words.append(''.join(run))
    return ' '.join(words).strip()


def is_centred(box, page_width):
    """
    Is this region centred on the page rather than aligned to the margin?

    Displayed mathematics is centred; prose, headings and table rows start at
    the left margin. This matters because confidence alone misses a *printed*
    equation made of ordinary glyphs - Tesseract read "E=mc" with the
    superscript as a separate line at confidence 80 and 96, so nothing looked
    wrong, and the equation was silently left as prose.
    """
    if not page_width:
        return False
    left_gap = box[0]
    right_gap = page_width - box[2]
    if left_gap < page_width * 0.12:
        return False          # starts at the margin: ordinary text
    # Roughly equal gaps on both sides.
    return abs(left_gap - right_gap) < page_width * 0.18


def looks_like_equation(latex):
    """
    Did the formula model actually find mathematics, or was it handed prose?

    Given text, pix2text-mfr returns the letters spaced out inside \\mathrm -
    "1.1 Motivation" came back as ``1. 1 \\quad \\mathrm{M o t i v a t i o n}``.
    A real expression always carries a relation, an operator or a script, and
    that is the difference worth testing.

    This is a cheap last line of defence behind nomination. It is deliberately
    permissive: anything with a genuine mathematical signal passes, and the AI
    review still gets the final say on whatever slips through.
    """
    if not latex or not latex.strip():
        return False
    return bool(_MATH_SIGNAL.search(latex))


def assemble(lines, equations):
    """
    Interleave text lines and recognised equations into one ordered document.

    Equations win any line they overlap: Tesseract also produced output for
    that region, and it is garbage by construction, so keeping both would
    duplicate the content in a mangled form. This is why the merge does not
    need fuzzy text matching to deduplicate - the boxes say exactly which words
    came from the formula.

    Returns a list of items, each {'kind': 'text'|'equation', ...}, in reading
    order.
    """
    consumed = set()
    for item in equations:
        for index, line in enumerate(lines):
            if _overlap(item['box'], line['box']) >= _OVERLAP:
                consumed.add(index)

    items = []
    for index, line in enumerate(lines):
        if index in consumed:
            continue
        items.append({
            'kind': 'text', 'text': line['text'], 'box': line['box'],
            'block': line['block'], 'par': line['par'],
            'min_conf': line['min_conf'],
            # True when no engine read this confidently - handwriting, usually.
            # Counted into the result as `uncertain_lines`, so the user knows
            # how much of the page to check.
            'uncertain': bool(line.get('uncertain'))
                         or line['min_conf'] < conf_floor(),
        })
    for item in equations:
        items.append({
            'kind': 'equation', 'latex': item['latex'], 'box': item['box'],
            'index': item.get('index'),
        })

    items.sort(key=lambda entry: (entry['box'][1], entry['box'][0]))
    return items


# ---------------------------------------------------------------------------
# Turning the assembled items into LaTeX
# ---------------------------------------------------------------------------

# A short line in its own paragraph, with no sentence punctuation, sitting
# above other text - that is what a heading looks like geometrically. Tesseract
# gives no font-size information, so this is the available signal. It is only a
# first guess: the AI review sees the page and fixes the hierarchy.
_HEADING_MAX_WORDS = 8
_NUMBERED = re.compile(r'^\d+(\.\d+)*\s')


def _looks_like_heading(item, body_height):
    if item['kind'] != 'text':
        return False
    text = item['text'].strip()
    if not text or len(text.split()) > _HEADING_MAX_WORDS:
        return False
    if text.endswith(('.', ',', ';', ':')):
        return False
    height = item['box'][3] - item['box'][1]
    # Either visibly larger than body text, or numbered like a section.
    return height > body_height * 1.15 or bool(_NUMBERED.match(text))


def _heading_level(text):
    match = _NUMBERED.match(text.strip())
    if match and '.' in match.group(0):
        return 'subsection'
    return 'section'


def to_tex(items, escape):
    """
    Emit a complete LaTeX document from the assembled items.

    `escape` is tesseract.escape_tex, passed in rather than imported so
    this module stays free of OCR dependencies and can be tested on its own.

    The structure here is deliberately conservative - paragraphs, headings,
    displayed equations. Tables and finer structure are what the AI path
    recovers and this one does not; guessing at them from bounding boxes alone
    would invent structure that is not there.
    """
    text_items = [i for i in items if i['kind'] == 'text']
    heights = sorted(i['box'][3] - i['box'][1] for i in text_items)
    body_height = heights[len(heights) // 2] if heights else 0

    has_math = any(i['kind'] == 'equation' for i in items)
    body = []
    paragraph = []
    previous = None
    current_page = None

    def flush():
        if paragraph:
            body.append(' '.join(paragraph))
            paragraph.clear()

    for item in items:
        # A multi-page document arrives as one pooled list of boxes, tagged
        # with the page each came from. Without a break at the seam LaTeX sets
        # it all as continuous copy: a short page pulls the next page's opening
        # lines up to fill it, and everything after that drifts. Items from a
        # single image carry no page number, and need no break.
        page = item.get('page')
        if page is not None:
            if current_page is not None and page != current_page:
                flush()
                body.append('\\clearpage')
            current_page = page

        if item['kind'] == 'equation':
            flush()
            body.append('\\[\n' + item['latex'] + '\n\\]')
            previous = item
            continue

        if _looks_like_heading(item, body_height):
            flush()
            text = item['text'].strip()
            level = _heading_level(text)
            # Drop the printed number; LaTeX numbers sections itself.
            stripped = _NUMBERED.sub('', text, count=1).strip() or text
            body.append(f'\\{level}{{{escape(stripped)}}}')
            previous = item
            continue

        # A new Tesseract paragraph starts a new LaTeX paragraph.
        if previous is not None and previous.get('kind') == 'text':
            if (item['par'], item['block']) != (previous['par'], previous['block']):
                flush()
        paragraph.append(escape(item['text']))
        previous = item

    flush()

    packages = ['\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}']
    if has_math:
        packages.append('\\usepackage{amsmath}')

    return ('\\documentclass{article}\n'
            + '\n'.join(packages)
            + '\n\\begin{document}\n\n'
            + '\n\n'.join(body).strip()
            + '\n\n\\end{document}\n')
