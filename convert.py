"""
The unified conversion pipeline.

One upload in, one .tex out. Every input the app accepts - an image, a PDF, a
Word document, a camera capture, a canvas drawing - arrives here and leaves as
the same kind of result. The user never chooses a converter, because choosing
one was always a question about our implementation rather than about their
document.

Two paths produce that result, tried in order of measured quality:

    AI-first    The model reads the page and writes the LaTeX. On the page
                corpus: structure 100% vs 95.83%, maths 99.81% vs 95.47%, and
                about twice as fast. On isolated formulas: 100% vs 93.06%.
    Converters  Tesseract and pix2text run over the same page and are merged
                by position. Used when the AI is unconfigured, out of quota or
                unreachable, so a conversion never comes back empty.

Word documents skip the OCR question entirely: a .docx already knows its own
headings, cells and words, so it is read structurally (docx_input) and only its
LaTeX form is left to decide.

Falling back is never silent. The route checks ai_status before any processing
starts and makes the user choose; and when the AI dies part way through a
multi-page document, the pages already converted keep their AI output, the rest
are converted locally, and the result says exactly where the change happened.

That last guarantee is why PDFs are sent to the model a page at a time rather
than whole. It costs one API call per page instead of one per document, which
matters on a free tier - but a quota that runs out on page 7 of 10 then loses
three pages of quality instead of ten.
"""

import io
import os
import re

from PIL import Image

import ai_qa
import ai_status
import docx_input
import latex_tools
import layout
import preprocess
import textract_fast

_IMAGE_TYPES = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.gif',
                '.webp'}
_ACCEPTED = _IMAGE_TYPES | {'.pdf', '.docx'}


class FallbackNotAuthorized(RuntimeError):
    """
    The AI is unavailable and the user has not agreed to the local fallback.

    Raised instead of quietly producing a lower-quality document. Carries the
    ai_status report so the caller can tell the user which service is down and
    whether a recovery time is known.
    """

    def __init__(self, status):
        super().__init__(status.get('reason') or 'AI conversion is unavailable.')
        self.status = status


def _int_env(name, default):
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _check_input(filename):
    """
    Reject an unusable file type before any path starts.

    Cheap on purpose: the AI path reads PDFs natively, so rasterising one just
    to validate it would throw away the speed advantage.
    """
    extension = os.path.splitext(filename or '')[1].lower()
    if extension and extension not in _ACCEPTED:
        raise RuntimeError(f"Unsupported file type: '{extension}'")


def page_count(file_bytes, filename):
    """How many pages this upload has, capped at the configured limit."""
    if os.path.splitext(filename or '')[1].lower() != '.pdf':
        return 1
    limit = _int_env('UNIFIED_MAX_PDF_PAGES', 10)
    try:
        import pikepdf
        with pikepdf.open(io.BytesIO(file_bytes)) as pdf:
            return max(1, min(len(pdf.pages), limit))
    except Exception:
        return 1


def _pages(file_bytes, filename, first=1):
    """
    Yield PIL pages from an upload, starting at page `first`.

    `first` matters when the AI converted the opening pages and only the tail
    needs the local engines: a ten-page PDF that lost the AI on page nine
    should not pay to rasterise the eight pages it already has better output
    for. It also means a failure while rendering the tail cannot destroy work
    that is already finished.

    This is also where the equation converter's old limitation goes away: it
    could only ever open an image, so a PDF raised UnidentifiedImageError.
    Rasterise once here and both engines get pages they can read.
    """
    extension = os.path.splitext(filename or '')[1].lower()
    if extension == '.pdf':
        try:
            from pdf2image import convert_from_bytes
        except ImportError:
            raise RuntimeError(
                "PDF support needs 'pdf2image' and Poppler on PATH.")
        limit = _int_env('UNIFIED_MAX_PDF_PAGES', 10)
        try:
            return convert_from_bytes(file_bytes, first_page=max(1, first),
                                      last_page=limit)
        except Exception as exc:
            if 'poppler' in str(exc).lower() or 'pdfinfo' in str(exc).lower():
                raise RuntimeError(
                    'Poppler was not found. Install it and add it to PATH.')
            raise RuntimeError(f'Could not read the PDF: {exc}')

    if extension and extension not in _IMAGE_TYPES:
        raise RuntimeError(f"Unsupported file type: '{extension}'")
    if first > 1:
        return []          # a single-page input has no page two
    try:
        image = Image.open(io.BytesIO(file_bytes))
        image.load()
        return [image]
    except Exception as exc:
        raise RuntimeError(f'Could not read the image: {exc}')


def _split_pdf(file_bytes, limit):
    """
    Cut a PDF into one single-page PDF per page.

    Single-page PDFs rather than rasterised images: the model reads a PDF page
    natively, including any text layer, and rendering it to a bitmap first
    would discard that for no reason. Returns None when the file cannot be
    split, which sends the whole document in one call instead.
    """
    try:
        import pikepdf
    except ImportError:
        return None
    try:
        with pikepdf.open(io.BytesIO(file_bytes)) as pdf:
            total = min(len(pdf.pages), limit)
            if total <= 1:
                return None
            out = []
            for index in range(total):
                with pikepdf.new() as single:
                    single.pages.append(pdf.pages[index])
                    buffer = io.BytesIO()
                    single.save(buffer)
                    out.append(buffer.getvalue())
            return out
    except Exception as exc:
        print(f'Notice: could not split the PDF into pages ({exc}).')
        return None


# ---------------------------------------------------------------------------
# The local converter path
# ---------------------------------------------------------------------------

def _recognize_regions(page, boxes, lines):
    """
    Run the formula model over the nominated crops, in reading order.

    Returns (equations, salvaged) where `salvaged` holds regions that turned
    out not to be mathematics. Those must never simply be dropped: when the
    text engine also read nothing there - which is routine for handwriting -
    discarding the region deletes a line of the document outright. Measured on
    a handwritten page, exactly that happened to "This idea changed how physics
    was understood."
    """
    import equation

    found, salvaged = [], []
    for box in boxes:
        try:
            box = equation.tighten(page, box)
            latex = equation.recognize(page.crop(box))
        except Exception as exc:
            print(f'Notice: formula recognition failed for one region ({exc}).')
            continue
        if not latex:
            continue

        if layout.looks_like_equation(latex):
            found.append({'index': len(found) + 1, 'latex': latex, 'box': box})
            continue

        # Not mathematics. If the text engine read this region, its answer
        # stands and there is nothing to salvage. If it did not, the formula
        # model's reading is all we have.
        covered = any(layout._overlap(box, line['box']) >= 0.5 for line in lines)
        if covered:
            continue
        recovered = layout.unwrap_text(latex)
        if recovered:
            salvaged.append({'text': recovered, 'box': box, 'uncertain': True})
    return found, salvaged


def analyse_page(page):
    """
    Run both converters over one already-conditioned page.

    Returns (items, equations, notes) where `items` is the interleaved reading
    order produced by layout.assemble().
    """
    notes = []

    try:
        lines = textract_fast.extract_lines(page)
    except Exception as exc:
        print(f'Notice: text extraction failed ({exc}).')
        lines, notes = [], notes + ['The text engine could not read this page.']

    try:
        import equation
        formula_model = equation.is_model_loaded()
    except Exception:
        formula_model = False

    equations, salvaged = [], []
    if formula_model:
        import equation
        boxes = equation.segment_boxes(page, allow_empty=True)
        nominated, _rejected = layout.nominate(lines, boxes, page.size[0])
        equations, salvaged = _recognize_regions(page, nominated, lines)
    else:
        notes.append('The formula model is not loaded, so equations were not '
                     'recognised separately on this page.')

    # Lines the text engine could not read at all, recovered from the formula
    # model. Rough, and flagged as such so the review stage re-reads them.
    for item in salvaged:
        lines.append({'text': item['text'], 'box': item['box'],
                      'min_conf': 0, 'mean_conf': 0,
                      'block': 0, 'par': 0, 'line': 0, 'uncertain': True})
    if salvaged:
        notes.append(f'{len(salvaged)} line(s) could not be read by the text '
                     'engine and were recovered approximately.')

    return layout.assemble(lines, equations), equations, notes


def _local_document(pages, first_number=1, equation_offset=0):
    """
    Convert already-loaded pages with the local converters only.

    Returns (tex, equations, items, notes). Used both for a whole document and
    for the tail of one whose AI conversion stopped part way, which is why the
    page and equation numbering start where the caller says rather than at one.
    """
    all_items, all_equations, notes = [], [], []
    offset = 0
    for index, raw_page in enumerate(pages):
        number = first_number + index
        try:
            page, page_notes = preprocess.prepare_image(raw_page)
            notes.extend(f'Page {number}: {note}' for note in page_notes)

            items, equations, page_issues = analyse_page(page)
            notes.extend(f'Page {number}: {note}' for note in page_issues)
        except Exception as exc:
            # One page that will not open must not cost the caller the pages
            # that already converted. Record it and carry on.
            print(f'Notice: page {number} could not be converted ({exc}).')
            notes.append(f'Page {number} could not be read and was skipped.')
            continue

        # Shift every box down by the pages already seen, so a multi-page
        # document sorts into one continuous reading order.
        height = page.size[1]
        for item in items:
            box = item['box']
            item['box'] = (box[0], box[1] + offset, box[2], box[3] + offset)
            item['page'] = number
        for item in equations:
            item['index'] = equation_offset + len(all_equations) + 1
            item['page'] = number
            all_equations.append(item)
        all_items.extend(items)
        offset += height

    tex = layout.to_tex(all_items, textract_fast.escape_tex)
    return tex, all_equations, all_items, notes


# ---------------------------------------------------------------------------
# Describing a finished document
# ---------------------------------------------------------------------------

_MATH_ENV = re.compile(
    r'\\\[|\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|cases'
    r'|[pbvV]?matrix)\}')


def _summarise_tex(tex, pages=1):
    """Describe an AI-produced document the way the page counts describe one."""
    body = re.search(r'\\begin\{document\}(.*)\\end\{document\}', tex or '',
                     re.DOTALL)
    body = body.group(1) if body else (tex or '')
    paragraphs = [block for block in re.split(r'\n\s*\n', body) if block.strip()]
    return {
        'pages': pages,
        'text_blocks': len(paragraphs),
        'equations': len(_MATH_ENV.findall(body)),
        'uncertain_lines': 0,
    }


def _expressions_in(tex):
    """Displayed expressions, for the equation list the result page shows."""
    found = []
    for pattern in (r'\\\[(.+?)\\\]',
                    r'\\begin\{(?:equation\*?|align\*?|gather\*?)\}(.+?)'
                    r'\\end\{(?:equation\*?|align\*?|gather\*?)\}'):
        for match in re.findall(pattern, tex or '', re.DOTALL):
            expression = ' '.join(match.split())
            if expression:
                found.append({'index': len(found) + 1, 'latex': expression})
    return found


def _notice(headline, detail, reason='', from_page=1, total=1, partial=False):
    """
    The one message the user gets about a degraded conversion.

    Exactly one of these ever reaches a result, and it is shown once, on the
    finished document - not while the conversion is running. A person watching
    a progress bar cannot act on "the AI just stopped"; a person about to use
    the output can, and that is the moment the warning is worth something.

    Structured rather than prose so the page can lead with the headline and
    keep the reason as secondary text, instead of one long paragraph nobody
    reads to the end of.
    """
    return {
        'headline': headline,
        'detail': detail,
        'reason': (reason or '').strip(),
        'from_page': from_page,
        'total_pages': total,
        # True when the document is short of content, not merely lower
        # quality - a different and more serious thing to tell someone.
        'partial': partial,
    }


def _result(tex, equations, summary, qa, items=None, raw_tex=''):
    return {'tex': tex, 'raw_tex': raw_tex, 'items': items or [],
            'equations': equations, 'summary': summary, 'qa': qa}


# ---------------------------------------------------------------------------
# Word documents
# ---------------------------------------------------------------------------

def _convert_docx(file_bytes, filename, use_ai, unavailable=''):
    """
    Convert a .docx. Its fallback is far stronger than the OCR one.

    Nothing has to be recognised - the words are already the words - so if the
    AI is unavailable, the deterministic rendering loses LaTeX judgement, not
    content. The one weak spot on either path is Word's equations, which are
    stored as OMML and reach us with their layout flattened.
    """
    blocks, notes = docx_input.extract(file_bytes)
    summary = {'pages': 1, 'total_pages': 1, 'text_blocks': len(blocks),
               'uncertain_lines': 0, 'notes': list(notes),
               'fallback_notice': None, 'ai_pages': 0, 'fallback_pages': 0}

    if use_ai:
        result = ai_qa.convert_page(None, filename,
                                    outline=docx_input.outline(blocks),
                                    rotation=ai_qa.Rotation())
        if result['status'] not in ('failed', 'skipped') and result['tex']:
            summary['path'] = 'ai'
            summary['ai_pages'] = 1
            summary['equations'] = len(_MATH_ENV.findall(result['tex']))
            return _result(result['tex'], _expressions_in(result['tex']),
                           summary, result)
        unavailable = result['message'] or unavailable

    summary['fallback_notice'] = _notice(
        headline='This document was converted without AI.',
        detail='It was built straight from the Word file, so the words, '
               'numbers and table cells are exact. Only its LaTeX form is '
               'unaided - equations recovered from Word are the least '
               'reliable part and are worth checking.',
        reason=(unavailable or 'The AI service was unavailable.'))
    summary['fallback_pages'] = 1

    tex = docx_input.to_tex(blocks)
    summary['path'] = 'converters'
    summary['equations'] = len(_MATH_ENV.findall(tex))
    findings = []
    compile_result = _compile_only(tex)
    report = ai_qa.blank_review(
        tex, 'skipped',
        'This document was built directly from the Word file, without AI.')
    report['compile'] = compile_result
    report['findings'] = findings
    return _result(tex, _expressions_in(tex), summary, report)


# ---------------------------------------------------------------------------
# Images and PDFs
# ---------------------------------------------------------------------------

def _ai_units(file_bytes, filename):
    """
    Split an upload into the units the model will be asked to convert.

    A list of (page_number, bytes, filename). One entry for an image; one per
    page for a PDF that can be split, which is what makes partial conversion
    survivable.
    """
    extension = os.path.splitext(filename or '')[1].lower()
    if extension == '.pdf':
        limit = _int_env('AI_QA_MAX_PDF_PAGES', 10)
        parts = _split_pdf(file_bytes, limit)
        if parts:
            return [(number, data, f'page-{number}.pdf')
                    for number, data in enumerate(parts, start=1)]
    return [(1, file_bytes, filename)]


def _convert_pages(file_bytes, filename, use_ai, unavailable=''):
    """Convert an image or a PDF, preferring the AI and degrading page by page."""
    notes = []
    equations = []
    ai_documents = []
    failed_at = None
    reason = ''
    usage = {'input': 0, 'output': 0, 'cache_read': 0, 'cache_write': 0}
    model = provider = None
    findings = []

    units = _ai_units(file_bytes, filename) if use_ai else []
    single = len(units) == 1
    single_compile = None

    # One round for the whole conversion. It opens on the preferred model and,
    # if that runs out of quota part way through, carries whichever model took
    # over to the remaining pages instead of re-probing the exhausted one ten
    # times. A new conversion builds a new round and starts at the top again.
    rotation = ai_qa.Rotation() if use_ai else None

    for number, data, name in units:
        if rotation.exhausted:
            # Every model refused. Stop asking and let the local converters
            # finish the document - the pages already done keep their AI
            # output, and the user is told where the change happened.
            failed_at = number
            reason = (str(rotation.fatal) if rotation.fatal
                      else 'Every AI model has reached its quota.')
            break

        # A lone unit is validated inside the call, where the conversation
        # still has the page attached and can repair against it. Several units
        # are validated once after merging instead: per-page validation would
        # multiply the repair budget by the page count and would be checking
        # fragments that were never meant to compile on their own.
        result = ai_qa.convert_page(data, name, validate=single,
                                    rotation=rotation)
        if result['status'] in ('failed', 'skipped') or not result['tex']:
            failed_at = number
            reason = result['message'] or 'The AI conversion was unavailable.'
            break
        ai_documents.append(result['tex'])
        findings.extend(result['findings'])
        single_compile = result['compile']
        model = model or result['model']
        provider = provider or result['provider']
        for key in usage:
            usage[key] += result['usage'].get(key, 0)

    ai_pages = len(ai_documents)
    local_pages = 0

    if use_ai and failed_at is None and ai_documents:
        # Everything came from the model.
        tex = latex_tools.merge_documents(ai_documents)
        if single:
            compile_result = single_compile
        else:
            tex, compile_result, extra = ai_qa.finalise_document(tex)
            findings.extend(extra)
        summary = _summarise_tex(tex, pages=len(units))
        summary.update({'path': 'ai', 'notes': notes, 'fallback_notice': None,
                        'ai_pages': ai_pages, 'fallback_pages': 0,
                        'total_pages': len(units)})
        report = {'tex': tex, 'status': 'corrected', 'message': '',
                  'findings': findings, 'equations': [], 'summary': {},
                  'compile': compile_result, 'usage': usage,
                  'model': model, 'provider': provider}
        return _result(tex, _expressions_in(tex), summary, report)

    # Some or all of the document still needs the local converters.
    total = page_count(file_bytes, filename)
    start = (failed_at or 1) if use_ai else 1

    # Rasterising and converting the tail is the step most likely to fail on a
    # server missing Poppler or Tesseract. Guard it: work the AI already
    # finished must survive the failure of the thing meant to rescue it.
    try:
        remaining = _pages(file_bytes, filename, first=start)
        local_tex, local_equations, items, local_notes = _local_document(
            remaining, first_number=start)
    except Exception as exc:
        if not ai_documents:
            raise
        print(f'Notice: the local fallback could not run ({exc}).')
        tex = latex_tools.merge_documents(ai_documents)
        tex, compile_result, extra = ai_qa.finalise_document(tex)
        findings.extend(extra)
        summary = _summarise_tex(tex, pages=ai_pages)
        summary.update({
            'path': 'mixed', 'notes': notes, 'ai_pages': ai_pages,
            'fallback_pages': 0, 'total_pages': total,
            'fallback_notice': _notice(
                headline=(f'Only the first {ai_pages} of {total} pages could '
                          f'be converted.'),
                detail=('The AI stopped part way through and this server could '
                        'not convert the rest either, so the document ends at '
                        f'page {ai_pages}. What is here is unaffected.'),
                reason=str(exc), from_page=start, total=total, partial=True),
        })
        report = {'tex': tex, 'status': 'partial', 'message': '',
                  'findings': findings, 'equations': [], 'summary': {},
                  'compile': compile_result, 'usage': usage,
                  'model': model, 'provider': provider}
        return _result(tex, _expressions_in(tex), summary, report)

    local_pages = len(remaining)
    notes.extend(local_notes)
    equations.extend(local_equations)

    if ai_documents:
        # Resume exactly where the AI stopped: pages already converted keep
        # their AI output and are spliced in front of the locally converted
        # tail, so nothing is redone and nothing is lost.
        notice = _notice(
            headline=(f'AI conversion stopped after page {ai_pages} of '
                      f'{total}.'),
            detail=(f'Pages {start} to {total} were converted on this server '
                    f'without AI, so their quality may be lower - '
                    f'especially complex layout, tables and unclear '
                    f'handwriting. Pages 1 to {ai_pages} are unaffected.'),
            reason=reason, from_page=start, total=total)
        tex = latex_tools.merge_documents(ai_documents + [local_tex])
        path = 'mixed'
    else:
        notice = _notice(
            headline='This document was converted without AI.',
            detail=('It was converted on this server instead, so quality may '
                    'be lower - especially complex layout, tables and '
                    'unclear handwriting.'),
            reason=(reason or unavailable
                    or 'The AI service was unavailable.'),
            from_page=1, total=total)
        tex = local_tex
        path = 'converters'

    uncertain = [item['text'] for item in items
                 if item['kind'] == 'text' and item.get('uncertain')
                 and item['text'].strip()]

    # Local validation only. Reaching here means the AI is either switched off
    # or has just failed, and asking a dead service to repair the document
    # would spend the full retry backoff to arrive at the same answer - on
    # exactly the path where the user is already waiting longer than usual.
    compile_result = _compile_only(tex)

    summary = {
        'pages': total,
        'total_pages': total,
        'text_blocks': sum(1 for i in items if i['kind'] == 'text'),
        'equations': len(equations),
        'uncertain_lines': len(uncertain),
        'notes': notes,
        'fallback_notice': notice,
        'path': path,
        'ai_pages': ai_pages,
        'fallback_pages': local_pages,
    }
    # The notice belongs to the result, shown once. Repeating it as the QA
    # status message printed it twice on the same page.
    report = ai_qa.blank_review(
        tex, 'partial' if ai_documents else 'skipped', '')
    report['compile'] = compile_result
    report['findings'] = findings
    report['usage'] = usage
    report['model'] = model
    report['provider'] = provider
    return _result(tex, equations, summary, report, items=items,
                   raw_tex=local_tex)


def _compile_only(tex):
    """Local validation with no API involved at all."""
    if latex_tools.static_validate(tex):
        return {'attempted': False, 'ok': False, 'engine': None, 'errors': '',
                'missing_packages': [], 'reason': 'The LaTeX did not validate.'}
    return latex_tools.compile_tex(tex)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def convert(file_bytes, filename, allow_fallback=False):
    """
    Convert one upload end to end.

    `allow_fallback` is the user's answer to the warning shown when the AI is
    known to be unavailable. Without it this raises FallbackNotAuthorized
    rather than quietly returning a lower-quality document - the user gets to
    decide whether to wait for the service or accept the local converters.

    Returns a dict with the final 'tex', the equations, a summary and the QA
    report. Raises RuntimeError only when the input itself cannot be read.
    """
    _check_input(filename)

    status = ai_status.check()
    use_ai = bool(status['available'])
    if not use_ai and not allow_fallback:
        raise FallbackNotAuthorized(status)

    unavailable = '' if use_ai else (status.get('reason') or '')
    if docx_input.is_docx(filename):
        return _convert_docx(file_bytes, filename, use_ai, unavailable)
    return _convert_pages(file_bytes, filename, use_ai, unavailable)
