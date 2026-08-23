# ai_qa.py
"""
AI quality assurance for the two OCR converters.

The AI does **no OCR here**. Tesseract still reads documents and pix2text-mfr
still recognises formulas; this module only reviews what they produced, with
the original upload in front of it, and corrects what it can prove is wrong.

    Textract:  image/PDF -> Tesseract -> .tex -> review_document()  -> final .tex
    Equation:  image     -> pix2text -> [eq1, eq2, ...] -> review_equations()
                                                        -> ordered, grouped .tex

Two rules shape everything below.

**QA is an enhancement, never a gate.** Every failure path - no API key, a dead
network, an exhausted free-tier quota, an unparseable reply - returns the
converter's own output unchanged, with a note saying why the review did not
happen. A user must never lose their conversion because a review failed.

**Source fidelity outranks tidiness.** For equations in particular the model is
told to treat the original image as the evidence and to leave unusual-but-valid
mathematics alone. "This looks odd" is not grounds for a change; "the image
clearly shows something else" is.
"""

import io
import os
import re

from PIL import Image

import latex_tools
import llm_providers
import preprocess
from llm_providers import LlmError, media_part, text_part

# Vision pipelines downscale images to a long edge of roughly this size, so
# anything larger costs upload bandwidth without adding any detail.
_MAX_IMAGE_EDGE = 1568

_NATIVE_IMAGE_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
}
_CONVERTIBLE_IMAGE_TYPES = {'.bmp', '.tiff', '.tif'}


def _int_env(name, default):
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _bool_env(name, default=True):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ('false', '0', 'no', 'off')


def enabled():
    """QA runs when a provider is configured and it has not been switched off."""
    return _bool_env('AI_QA_ENABLED', True) and llm_providers.is_configured()


def provider_info():
    """Describe the active provider for the UI (never includes credentials)."""
    provider = llm_providers.get_provider()
    return {
        'name': provider.name,
        'model': provider.default_model(),
        'configured': provider.is_configured(),
        'enabled': enabled(),
        'available': llm_providers.available(),
        # Drives the disclosure notice shown above the upload controls.
        'trains_on_input': provider.trains_on_free_input(),
    }


# ---------------------------------------------------------------------------
# Showing the original document to the reviewer
# ---------------------------------------------------------------------------

def _prepare_image(file_bytes, extension):
    media_type = _NATIVE_IMAGE_TYPES.get(extension)
    with Image.open(io.BytesIO(file_bytes)) as img:
        img.load()
        conditioned, _notes = preprocess.prepare_image(img)
        too_big = max(conditioned.size) > _MAX_IMAGE_EDGE
        if media_type and not too_big:
            return file_bytes, media_type
        if conditioned.mode not in ('RGB', 'L'):
            conditioned = conditioned.convert('RGB')
        if too_big:
            conditioned.thumbnail((_MAX_IMAGE_EDGE, _MAX_IMAGE_EDGE),
                                  Image.LANCZOS)
        buffer = io.BytesIO()
        conditioned.save(buffer, format='PNG', optimize=True)
        return buffer.getvalue(), 'image/png'


def _prepare_pdf(file_bytes, max_pages):
    try:
        import pikepdf
    except ImportError:
        return file_bytes
    try:
        with pikepdf.open(io.BytesIO(file_bytes)) as pdf:
            if len(pdf.pages) <= max_pages:
                return file_bytes
            del pdf.pages[max_pages:]
            buffer = io.BytesIO()
            pdf.save(buffer)
            return buffer.getvalue()
    except Exception:
        return file_bytes


def source_part(file_bytes, filename):
    """
    Build the content part that shows the reviewer the original upload.

    Returns None when the file cannot be presented (unknown type, unreadable,
    too large) - the caller then skips QA rather than failing the conversion.
    """
    if not file_bytes:
        return None
    extension = os.path.splitext(filename or '')[1].lower()
    limit = _int_env('AI_QA_MAX_UPLOAD_MB', 20) * 1024 * 1024
    if len(file_bytes) > limit:
        return None

    try:
        if extension == '.pdf':
            data = _prepare_pdf(file_bytes, _int_env('AI_QA_MAX_PDF_PAGES', 10))
            return media_part(data, 'application/pdf')
        if extension in _NATIVE_IMAGE_TYPES or extension in _CONVERTIBLE_IMAGE_TYPES:
            data, media_type = _prepare_image(file_bytes, extension)
            return media_part(data, media_type)
    except Exception as exc:
        print(f"Notice: could not attach the source document for QA ({exc}).")
    return None


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_DOCUMENT_SYSTEM = """\
You review LaTeX that an OCR tool produced from a scanned document, with the
original page in front of you. You are a proofreader, not a transcriber: the OCR
output is the draft, the image is the truth, and your job is to make the draft
match the truth.

Priorities, in order:
1. Fidelity to the original document. Every piece of content on the page must be
   present, correct, and in the same reading order. Nothing that is not on the
   page may be added.
2. Structure that matches what the page actually is - headings as headings,
   lists as lists, tables as tables, paragraphs kept whole.
3. Valid, compilable LaTeX.

Rules:
- Keep the document complete: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Load only packages the content needs; an unused \\usepackage is a defect.
- Never use \\includegraphics for artwork on the page - the file will not exist.
- Escape LaTeX special characters in ordinary prose (% & _ # $).
- If a word is genuinely illegible, give your best reading and mark it with a
  % comment rather than dropping it.
"""

_DOCUMENT_PROMPT = """\
Below is the LaTeX that OCR produced from the attached document.

Compare it against the attached original and check:
- Does the extracted text make sense, and does it say what the page says?
- Is the meaning and context of the text preserved?
- Is the reading order right, and does each piece of text sit in the correct
  place relative to the rest?
- Is any content missing, duplicated, garbled, or invented?
- Does the LaTeX structure match the page (headings, paragraphs, lists, tables)?
- Are there obvious formatting or structural problems?

OCR tools mangle characters in predictable ways - l/1, O/0, rn/m, joined or
split words, dropped accents, a heading flattened into a paragraph. Fix what the
image shows to be wrong. Do not rewrite wording that is merely awkward if that
is what the page says.

If the LaTeX already represents the page correctly, reply with exactly:

LATEX_OK

Otherwise reply with a short list of what you found and fixed, then the full
corrected document in a single fenced block:

```latex
...corrected document...
```

--- OCR OUTPUT ---
{tex}
"""

_EQUATION_SYSTEM = """\
You review mathematical expressions that an OCR model transcribed from an image,
with the original image in front of you.

You perform two SEPARATE checks on every expression:

1. SOURCE FIDELITY - does the transcription match what is actually in the image?
   The image is the evidence. This check outranks everything else.

2. MATHEMATICAL SANITY - is the expression coherent as mathematics, or does it
   look like a recognition failure? Recognition failures have a signature:
   a stray operator with nothing to operate on, unbalanced delimiters, a symbol
   that cannot appear where it is, digits fused into a variable, \\cdot where the
   image shows a decimal point.

Critically: **unusual is not wrong.** Mathematics is full of valid expressions
that look strange. Never "fix" an expression merely because it is unconventional,
non-standard, dimensionally odd, or unfamiliar. Change it only when the image
supports a different reading. If check 2 says an expression is odd but check 1
says the image really does show it that way, keep it exactly as it is and say so.

When the image is ambiguous, prefer the transcription you were given.
"""

_EQUATION_PROMPT = """\
An OCR model found {count} expression(s) in the attached image and transcribed
each one separately, in top-to-bottom reading order:

{listing}

For EACH expression, decide:
- Fidelity: does it match the image? If not, what does the image actually show?
- Mathematics: is it coherent, or does it show signs of a recognition error?
- Is it actually an equation at all, or did the segmenter pick up a caption or
  a stray mark?
- Is it a duplicate of another entry?
Also say whether any expression visible in the image was missed entirely.

Then consider the group as a whole:
- Are the expressions related to one another?
- Does one follow from, or depend on, another?
- Does the image itself indicate a relationship (a derivation, a numbered list,
  a system of equations, a case split, braces joining them)?
- Do they need a specific order, and is the OCR order right?
- Should any of them be grouped together in the output (align, cases, gather,
  a system) rather than standing alone?

Reply in EXACTLY this format, one block per expression, then the summary, then
the final document. Put nothing else before the first [EQ] block.

[EQ 1]
status: ok | corrected | duplicate | not_an_equation | uncertain
latex: <the final LaTeX for this expression, on one line>
fidelity: <one line: what the image shows, and whether the OCR matched it>
math: <one line: is it mathematically coherent, and did that change anything?>

[EQ 2]
...

[SUMMARY]
missing: <expressions visible in the image but not transcribed, or "none">
related: yes | no
relationship: <one line: how they relate, or "independent">
ordering: <one line: the correct order and why, or "as given">
grouping: <one line: what should be grouped into one environment, or "none">

```latex
...the complete .tex document containing the equations, ordered and grouped as
you described...
```

Layout rules for the final document:
- Load amsmath. Load nothing else unless the content needs it.
- Independent expressions: one displayed equation each.
- A derivation or a chain of equalities: align, aligned to the relation symbol.
- A simultaneous system or a case split: cases, or align inside braces.
- Drop entries whose status is duplicate or not_an_equation.
- Number equations only if the source image numbers them.
"""

_REPAIR_PROMPT = """\
The document you produced does not validate:

{problems}

Fix these without changing the content: the transcription must still match the
attached original. Reply with the full corrected document in a single fenced
block:

```latex
...corrected document...
```
"""


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def fenced_latex(text):
    """Pull a .tex document out of a model reply."""
    if not text:
        return None
    fenced = re.findall(r'```(?:latex|tex)?\s*\n(.*?)```', text, re.DOTALL)
    if fenced:
        for candidate in reversed(fenced):
            if '\\documentclass' in candidate or '\\begin{document}' in candidate:
                return candidate.strip()
        return fenced[-1].strip()
    match = re.search(r'(\\documentclass.*?\\end\{document\})', text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


_EQ_BLOCK = re.compile(
    r'\[EQ\s*(\d+)\](.*?)(?=\[EQ\s*\d+\]|\[SUMMARY\]|```|$)',
    re.DOTALL | re.IGNORECASE)
_FIELD = r'^\s*{name}\s*:\s*(.+?)\s*$'


def _field(block, name):
    match = re.search(_FIELD.format(name=name), block,
                      re.IGNORECASE | re.MULTILINE)
    return match.group(1).strip() if match else ''


def parse_equation_review(reply):
    """
    Turn the reviewer's reply into per-equation verdicts plus a summary.

    A key-per-line format is used rather than JSON because every value here is
    LaTeX: backslash-heavy strings are exactly what models escape incorrectly
    inside JSON, and one bad escape would cost the whole review.
    """
    equations = []
    for match in _EQ_BLOCK.finditer(reply or ''):
        block = match.group(2)
        equations.append({
            'index': int(match.group(1)),
            'status': (_field(block, 'status') or 'ok').split()[0].lower(),
            'latex': _field(block, 'latex'),
            'fidelity': _field(block, 'fidelity'),
            'math': _field(block, 'math'),
        })

    summary_text = ''
    split = re.split(r'\[SUMMARY\]', reply or '', flags=re.IGNORECASE)
    if len(split) > 1:
        summary_text = split[1].split('```')[0]

    summary = {
        'missing': _field(summary_text, 'missing'),
        'related': _field(summary_text, 'related').lower().startswith('y'),
        'relationship': _field(summary_text, 'relationship'),
        'ordering': _field(summary_text, 'ordering'),
        'grouping': _field(summary_text, 'grouping'),
    }
    return equations, summary


# ---------------------------------------------------------------------------
# Fallback assembly (used when QA is unavailable)
# ---------------------------------------------------------------------------

def equations_to_tex(equations):
    """
    Lay out recognised equations without any AI involvement.

    One displayed equation per entry, in the order the converter found them.
    This is the honest default: with no reviewer available we make no claim
    about how the equations relate, so we do not group them.
    """
    lines = [r'\documentclass{article}', r'\usepackage{amsmath}',
             r'\begin{document}']
    for item in equations:
        latex = (item.get('latex') or '').strip()
        if not latex or latex == '[No text recognized]':
            continue
        lines.append(r'\begin{equation*}')
        lines.append(latex)
        lines.append(r'\end{equation*}')
    lines.append(r'\end{document}')
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------
# The review itself
# ---------------------------------------------------------------------------

def _validate_and_repair(convo, tex, calls_left, report):
    """
    Check the reviewed document and give the model one chance to fix it.

    Bounded deliberately: the point of this layer is fidelity, not chasing a
    compiler. If it still does not validate we keep the text anyway and say so.
    """
    problems = latex_tools.static_validate(tex)
    compile_result = {'attempted': False, 'ok': False, 'engine': None,
                      'errors': '', 'missing_packages': [], 'reason': None}

    if not problems and _bool_env('AI_QA_ENABLE_COMPILE', True):
        compile_result = latex_tools.compile_tex(tex)
        if compile_result['attempted'] and not compile_result['ok']:
            detail = compile_result['errors'] or compile_result['reason'] or ''
            if compile_result['missing_packages']:
                detail += ("\n\nThese packages are not installed on this "
                           "server: " + ', '.join(compile_result['missing_packages']))
            problems = [f"{compile_result['engine']} could not compile it:\n{detail}"]

    if problems and calls_left > 0:
        try:
            reply = convo.ask([text_part(
                _REPAIR_PROMPT.format(problems='\n'.join(problems)))])
            repaired = fenced_latex(reply)
            if repaired:
                still = latex_tools.static_validate(repaired)
                if not still:
                    report.append('Fixed a LaTeX validation error.')
                    # Re-check: reporting the pre-repair compile result would
                    # tell the user a working document does not build.
                    if _bool_env('AI_QA_ENABLE_COMPILE', True):
                        compile_result = latex_tools.compile_tex(repaired)
                    return repaired, compile_result
        except LlmError:
            pass  # keep what we have

    if problems:
        report.append('Note: the LaTeX still has validation warnings: '
                      + '; '.join(problems)[:300])
    return tex, compile_result


def _blank_result(tex, status, message, equations=None, summary=None):
    return {
        'tex': tex,
        'status': status,
        'message': message,
        'findings': [],
        'equations': equations or [],
        'summary': summary or {},
        'compile': {'attempted': False, 'ok': False, 'engine': None,
                    'errors': '', 'missing_packages': [], 'reason': None},
        'usage': {'input': 0, 'output': 0, 'cache_read': 0, 'cache_write': 0},
        'model': None,
        'provider': None,
    }


def review_document(file_bytes, filename, tex):
    """
    QA the Textract pipeline's .tex against the original document.

    Returns a dict with the final 'tex' and a 'status' of:
        clean     - the reviewer found nothing to change
        corrected - the reviewer rewrote the document
        skipped   - QA is off, unconfigured, or the source could not be shown
        failed    - the reviewer was unreachable; the original .tex is returned
    """
    if not enabled():
        return _blank_result(tex, 'skipped',
                             'AI review is not configured on this server.')

    part = source_part(file_bytes, filename)
    if part is None:
        return _blank_result(
            tex, 'skipped',
            'The original document could not be shown to the reviewer, so the '
            'OCR output was returned unchanged.')

    provider = llm_providers.get_provider()
    try:
        convo = provider.start(_DOCUMENT_SYSTEM)
        reply = convo.ask([part, text_part(_DOCUMENT_PROMPT.format(tex=tex))])
    except LlmError as exc:
        return _blank_result(tex, 'failed', str(exc))
    except Exception as exc:
        print(f"ERROR: unexpected failure during document QA: {exc!r}")
        return _blank_result(tex, 'failed',
                             'The AI review could not be completed, so the OCR '
                             'output was returned unchanged.')

    corrected = fenced_latex(reply)
    report = []
    compile_result = {'attempted': False, 'ok': False, 'engine': None,
                      'errors': '', 'missing_packages': [], 'reason': None}

    if corrected:
        findings = reply.split('```')[0].strip()
        report = [line.strip(' -*') for line in findings.splitlines()
                  if line.strip()]
        budget = _int_env('AI_QA_MAX_API_CALLS', 3) - convo.calls
        final, compile_result = _validate_and_repair(convo, corrected, budget,
                                                     report)
        status = 'corrected'
    else:
        final = tex
        status = 'clean'
        report = ['The OCR output already matches the source document.']
        if _bool_env('AI_QA_ENABLE_COMPILE', True):
            compile_result = latex_tools.compile_tex(final)

    return {
        'tex': final,
        'status': status,
        'message': '',
        'findings': report,
        'equations': [],
        'summary': {},
        'compile': compile_result,
        'usage': convo.usage,
        'model': convo.model,
        'provider': provider.name,
    }


def review_equations(file_bytes, filename, equations):
    """
    QA the Equation pipeline's list of recognised expressions.

    Takes the ordered list the converter produced, checks each entry against
    the original image for fidelity and for mathematical coherence, works out
    how the expressions relate, and returns a properly ordered and grouped
    .tex document.
    """
    fallback = equations_to_tex(equations)

    if not enabled():
        return _blank_result(fallback, 'skipped',
                             'AI review is not configured on this server.',
                             equations=[])

    part = source_part(file_bytes, filename)
    if part is None:
        return _blank_result(
            fallback, 'skipped',
            'The original image could not be shown to the reviewer, so the '
            'equations were listed in the order they were found.')

    listing = '\n'.join(f"{item['index']}. {item['latex']}"
                        for item in equations)
    prompt = _EQUATION_PROMPT.format(count=len(equations), listing=listing)

    provider = llm_providers.get_provider()
    try:
        convo = provider.start(_EQUATION_SYSTEM)
        reply = convo.ask([part, text_part(prompt)])
    except LlmError as exc:
        return _blank_result(fallback, 'failed', str(exc))
    except Exception as exc:
        print(f"ERROR: unexpected failure during equation QA: {exc!r}")
        return _blank_result(fallback, 'failed',
                             'The AI review could not be completed, so the '
                             'equations were listed in the order they were found.')

    reviewed, summary = parse_equation_review(reply)
    corrected = fenced_latex(reply)

    if not corrected:
        # The reviewer answered but gave us no document. Keep its per-equation
        # verdicts, which are still useful, and lay the equations out ourselves.
        merged = _merge_verdicts(equations, reviewed)
        return {
            'tex': equations_to_tex(merged), 'status': 'partial',
            'message': ('The reviewer did not return a formatted document, so '
                        'the equations were laid out in reading order.'),
            'findings': [], 'equations': reviewed, 'summary': summary,
            'compile': {'attempted': False, 'ok': False, 'engine': None,
                        'errors': '', 'missing_packages': [], 'reason': None},
            'usage': convo.usage, 'model': convo.model,
            'provider': provider.name,
        }

    report = []
    budget = _int_env('AI_QA_MAX_API_CALLS', 3) - convo.calls
    final, compile_result = _validate_and_repair(convo, corrected, budget, report)

    changed = any(item['status'] in ('corrected', 'duplicate', 'not_an_equation')
                  for item in reviewed)
    return {
        'tex': final,
        'status': 'corrected' if changed else 'clean',
        'message': '',
        'findings': report,
        'equations': reviewed,
        'summary': summary,
        'compile': compile_result,
        'usage': convo.usage,
        'model': convo.model,
        'provider': provider.name,
    }


def _merge_verdicts(original, reviewed):
    """Apply per-equation corrections onto the converter's list."""
    by_index = {item['index']: item for item in reviewed}
    merged = []
    for item in original:
        verdict = by_index.get(item['index'])
        if verdict and verdict['status'] in ('duplicate', 'not_an_equation'):
            continue
        latex = (verdict or {}).get('latex') or item['latex']
        merged.append({'index': len(merged) + 1, 'latex': latex})
    return merged
