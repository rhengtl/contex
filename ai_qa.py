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

import ai_status
import latex_tools
import llm_providers
import preprocess
from llm_providers import (LlmError, LlmModelError, LlmQuotaError,
                           media_part, text_part)

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
    models = provider.models()
    return {
        'name': provider.name,
        # Per-pipeline models; 'model' stays for callers that want just one.
        'models': models,
        'model': models.get(llm_providers.ROLE_DOCUMENT),
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

Know your converter's blind spot: it is a plain text engine with no
mathematical model at all. Where the page has a formula, it does not report a
formula - it reports whatever letters the glyphs looked like, so an equation
arrives as mangled prose. Treat any stretch of nonsense that sits where the
image shows mathematics as a *formula the converter could not read*, never as
prose to be smoothed out. Repairing it into a fluent sentence is the single
worst thing you can do here: the result reads well and says something the page
never said.

When you find one:
- If you can read the formula in the image, typeset it as mathematics.
- If you cannot read it confidently, replace the garbled run with
  `% QA: unreadable formula` and nothing else.
- Never invent prose to bridge the gap, and never leave the mangled letters in
  place as if they were words.

Rules:
- Keep the document complete: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Load only packages the content needs; an unused \\usepackage is a defect.
  Load amsmath if, and only if, you typeset mathematics.
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
- Does the page contain mathematics, and if so, what did the text-only
  converter turn it into?

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

_UNIFIED_SYSTEM = """\
You review a LaTeX document assembled from a scanned page by two separate
converters, with the original page in front of you.

  A text engine read the prose. It has NO mathematical model, so wherever the
  page holds a formula it produced nonsense - and the assembler removed that
  nonsense and put a formula there instead. It is also a *printed* text engine:
  on handwriting it is close to useless, mangling words or returning nothing at
  all for a line.

  A formula model transcribed each equation region on its own. It knows
  mathematics and nothing else: it cannot read prose, and anything it was
  handed that was not really an equation came back as garbage. It reads
  handwritten and printed mathematics about equally well.

The page may hold handwriting, print, or both, in prose and in mathematics.
Where a line is handwritten, YOU are the only stage that can read it properly -
read it off the image and write what it actually says.

The two were merged by position on the page, so an equation should already sit
roughly where it belongs. Your job is to check that merge against the image.

Priorities, in order:
1. Fidelity to the original page. Everything on the page is present, correct,
   and in the same reading order. Nothing invented, nothing duplicated.
2. Structure that matches the page - headings as headings, lists as lists,
   tables as tables, paragraphs kept whole.
3. Valid, compilable LaTeX.

Two checks on every mathematical expression, in this order:

1. SOURCE FIDELITY - does the transcription match what the image shows? The
   image is the evidence, and this outranks everything else.
2. MATHEMATICAL SANITY - is it coherent, or does it show the signature of a
   recognition failure: a stray operator with nothing to operate on,
   unbalanced delimiters, digits fused into a variable, \\cdot where the image
   shows a decimal point?

Critically: **unusual is not wrong.** Mathematics is full of valid expressions
that look strange. Never "fix" one merely because it is unconventional,
non-standard, dimensionally odd, or unfamiliar. Change it only when the image
supports a different reading. If an expression looks odd but the image really
does show it that way, keep it exactly as it is.

Faults specific to this merge, which you are the only stage that can catch:
- An equation placed in the wrong position, or out of order.
- The same content appearing twice - once as mangled prose and once as a
  formula - because the assembler failed to remove the text engine's attempt.
- Leftover garbled letters where a formula should be.
- A region that is not an equation at all - a heading, a caption, a table rule,
  a figure - transcribed as one. Delete it and restore what the page shows.
- An equation visible on the page that neither converter reported.
- Prose and a formula that belong to one sentence split apart, or an inline
  expression turned into a displayed one when the page has it mid-sentence.
- Handwritten prose mangled into near-words ("phigsics" for "physics"), or a
  handwritten line missing entirely because no engine could read it.

Do not mark handwriting up as different from print. A handwritten sentence and
a printed one both become ordinary LaTeX prose; a handwritten formula and a
printed one both become ordinary LaTeX mathematics. What the page was written
with changes how carefully you must read it, not how it is typeset.

Rules:
- Keep the document complete: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Load only packages the content needs; an unused \\usepackage is a defect.
- Never use \\includegraphics for artwork on the page - the file will not exist.
- Escape LaTeX special characters in ordinary prose (% & _ # $).
- If something is genuinely illegible, give your best reading and mark it with
  a % comment rather than dropping it.
"""

_UNIFIED_PROMPT = """\
Below is the assembled LaTeX. The text engine's prose and {count} separately
recognised expression(s) have been merged by their position on the page.

{listing}{uncertain}
Compare the document against the attached original and check:
- Does the text say what the page says, in the same reading order?
- Is any content missing, duplicated, garbled, or invented?
- Does each equation match what the image shows at that spot?
- Is each expression coherent mathematics, or does it look like a misread?
- Is every equation in the right place relative to the surrounding text, and
  are related equations in the right order?
- Do any of them belong together in one environment (align, cases, a system)
  rather than standing separately?
- Was anything transcribed as an equation that is not one?
- Does the LaTeX structure match the page (headings, paragraphs, lists,
  tables)?

Text engines mangle characters predictably - l/1, O/0, rn/m, joined or split
words, a heading flattened into a paragraph. Fix what the image shows to be
wrong. Do not rewrite wording that is merely awkward if that is what the page
says.

If the document already represents the page correctly, reply with exactly:

LATEX_OK

Otherwise reply with a short list of what you found and fixed, then the full
corrected document in a single fenced block:

```latex
...corrected document...
```

--- ASSEMBLED DOCUMENT ---
{tex}
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


class Rotation:
    """
    One conversion's journey through a role's model chain.

    A *round* is one conversion, however many pages it has. The round opens on
    the role's preferred model and stays there; when that model reports itself
    out of quota the round advances to the next candidate and stays there for
    the remaining pages, rather than re-probing an exhausted model once per
    page. When the chain runs out the round is `exhausted`, and the caller
    stops asking and finishes the document locally.

    The next conversion builds a new Rotation, so it opens on the preferred
    model again. That is deliberate: free-tier quota comes back without warning
    and nothing should keep a user on the fourth-choice model because the first
    was busy an hour ago. The one exception is a model the provider explicitly
    told us to stay away from until a stated time - see ai_status.hard_blocked.
    """

    def __init__(self, role=None):
        self.role = role or llm_providers.ROLE_DOCUMENT
        self.provider = llm_providers.get_provider()
        self.chain = self.provider.model_chain(self.role)
        self.cursor = 0
        self.exhausted = not self.chain
        #: Set when a failure no model can get around ends the round early.
        self.fatal = None

    @property
    def active(self):
        """The model this round is currently using, or None once spent."""
        if self.exhausted or self.cursor >= len(self.chain):
            return None
        return self.chain[self.cursor]

    def _advance(self):
        self.cursor += 1
        if self.cursor >= len(self.chain):
            self.exhausted = True

    def ask(self, system, parts):
        """
        Send `parts`, advancing through the chain until one model answers.

        Returns (conversation, reply). Raises LlmError when the round has no
        models left, or at once for a failure that rotating cannot fix.
        """
        if self.fatal is not None:
            raise self.fatal

        last = None
        while not self.exhausted:
            model = self.active

            # The provider named a time to come back; honour it rather than
            # spending a round trip to be told the same thing again.
            if ai_status.hard_blocked(model):
                record = ai_status.record_for(model) or {}
                last = LlmQuotaError(record.get('message')
                                     or f'{model} is rate limited.')
                self._advance()
                self._announce(model, last)
                continue

            # A model already believed to be out gets one quick confirmation
            # instead of three attempts with backoff.
            attempts = 1 if ai_status.record_for(model) else None

            try:
                convo = self.provider.start(system, model=model, role=self.role,
                                            attempts=attempts)
                reply = convo.ask(parts)
            except LlmQuotaError as exc:
                ai_status.record_model_outage(
                    model, str(exc), retry_after=exc.retry_after,
                    scope=exc.scope, provider=self.provider.name)
                last = exc
                self._advance()
                self._announce(model, exc)
            except LlmModelError as exc:
                ai_status.record_model_outage(
                    model, str(exc),
                    retry_after=ai_status._MODEL_ERROR_SECONDS, scope='model',
                    provider=self.provider.name, from_provider=False)
                last = exc
                self._advance()
                self._announce(model, exc)
            except LlmError as exc:
                # A rejected key or an unreachable network dooms every model,
                # so rotating would repeat the same failure three more times.
                ai_status.record_outage(str(exc), provider=self.provider.name)
                self.exhausted = True
                self.fatal = exc
                raise
            else:
                # This model answered, so it is not exhausted and neither is
                # the service. Not clearing here is what would strand the app
                # on the fallback path after the service came back.
                ai_status.clear_model(model)
                return convo, reply

        raise last or LlmError('No usable model is configured for this server.')

    def _announce(self, model, error):
        nxt = self.active
        if nxt:
            print(f'Notice: {model} is unavailable ({error}); trying {nxt}.')
        else:
            print(f'Notice: {model} is unavailable ({error}); '
                  'no models left this round.')


def first_usable_model(role):
    """The best model for this role that is not currently known to be out."""
    provider = llm_providers.get_provider()
    chain = provider.model_chain(role)
    usable = ai_status.usable_models(chain)
    return (usable or chain or [None])[0]


def ask_first_usable(system, role, parts, rotation=None):
    """
    Send `parts` on the first model that answers, rotating as needed.

    A convenience wrapper for the single-call review paths, which are each
    their own round. Multi-page conversions build one Rotation and reuse it, so
    the model chosen on page one carries to page ten.

    Returns (conversation, reply, provider).
    """
    rotation = rotation or Rotation(role)
    convo, reply = rotation.ask(system, parts)
    return convo, reply, rotation.provider


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


_DIRECT_SYSTEM = """\
You convert a scanned or photographed page into LaTeX. You are reading the page
yourself - there is no OCR draft to check.

Priorities, in order:
1. Fidelity to the page. Every piece of content present, correct, and in the
   same reading order. Nothing invented, nothing omitted, nothing duplicated.
2. Structure that matches the page - headings as headings, lists as lists,
   tables as tables, paragraphs kept whole, displayed mathematics displayed and
   inline mathematics inline.
3. Valid, compilable LaTeX.

The page may be handwritten, printed, or both, in prose and in mathematics.
Typeset all of it the same way: a handwritten sentence and a printed one both
become ordinary LaTeX prose, a handwritten formula and a printed one both
become ordinary LaTeX mathematics. What it was written with changes how
carefully you must read, not how it is typeset.

On mathematics, **unusual is not wrong.** Transcribe what the page shows. Never
normalise an expression into a more familiar one because the one written looks
strange, unconventional or dimensionally odd. If the page shows it that way,
write it that way.

Rules:
- Emit a complete document: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Load only packages the content needs; an unused \\usepackage is a defect.
- Never use \\includegraphics - the file will not exist.
- Escape LaTeX special characters in ordinary prose (% & _ # $).
- If something is genuinely illegible, give your best reading and mark it with
  a % comment rather than dropping it.

Reply with the document in a single fenced block and nothing else:

```latex
...document...
```
"""

_DIRECT_PROMPT = """\
Convert the attached page to LaTeX, following your instructions exactly.
"""

_DOCX_SYSTEM = """\
You turn the extracted contents of a Microsoft Word document into LaTeX.

Nothing here was recognised from an image, so the words, numbers and table
cells are already exactly right. Do not "correct" them. Your job is the LaTeX
form: choosing the environment that suits each structure and typesetting the
mathematics properly.

The extraction marks structure with tags you must translate, not reproduce:

    [TITLE] ...              the document title
    [HEADING n] ...          a heading at level n
    [LIST n] - ...           a bullet at indent level n
    [LIST n] # ...           a numbered item at indent level n
    [DISPLAY EQUATION] ...   mathematics that stood alone on its own line
    [MATH]...[/MATH]         mathematics inside a sentence
    [TABLE] ... [/TABLE]     rows of cells separated by |

Word stores equations in a format that is not LaTeX, so what reaches you
inside the maths markers is the symbols in reading order with their layout
lost: superscripts, subscripts, fractions, roots and limits are flattened.
Rebuild them into correct LaTeX using the surrounding sentence to judge what
was meant - "E=mc2" in a passage about relativity is E = mc^{2}. Where the
intent is genuinely ambiguous, choose the reading the context supports and
mark it with a % comment.

Rules:
- Emit a complete document: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Keep every block, in the order given. Nothing invented, nothing dropped.
- Load only packages the content needs.
- Never use \\includegraphics - the file will not exist.
- Escape LaTeX special characters in ordinary prose (% & _ # $).

Reply with the document in a single fenced block and nothing else:

```latex
...document...
```
"""

_DOCX_PROMPT = """\
Convert this extracted Word document to LaTeX, following your instructions
exactly.

{outline}
"""

_FIX_SYSTEM = """\
You repair LaTeX documents that do not compile.

You are working on the source alone - the original document is not in front of
you, so you cannot verify the content and must not try to. Change only what is
structurally broken: unbalanced braces, unclosed environments, mismatched maths
delimiters, a missing package for a command that is used. Leave every word,
number and expression exactly as it is.

Reply with the full corrected document in a single fenced block and nothing
else.
"""


def convert_page(file_bytes, filename, validate=True, outline=None,
                 rotation=None):
    """
    Transcribe one unit of a document to LaTeX with the model alone.

    A "unit" is one page of a PDF, one image, or - when `outline` is given
    instead of file bytes - the extracted contents of a Word document. There is
    no converter draft in either case: the model is doing the reading.

    `rotation` carries one conversion's model state across its pages: the
    round opens on the preferred model and, if that runs out of quota, stays on
    whichever model took over instead of re-probing the exhausted one for every
    remaining page. Omit it and the call is its own round.

    `validate` is off when the caller is converting several pages and will
    validate the merged document once at the end. Validating per page would
    multiply the compile and repair budget by the page count while checking
    fragments that were never meant to stand alone.

    Returns the same shape as review_page(), so callers do not have to care
    which path produced the document. On failure it returns an empty document
    with a status; unlike the review path there is no converter output to fall
    back on here, which is the central trade-off of going AI-first.
    """
    if not enabled():
        return _blank_result('', 'skipped',
                             'AI conversion is not configured on this server.')

    if outline is not None:
        system, ask = _DOCX_SYSTEM, [text_part(
            _DOCX_PROMPT.format(outline=outline))]
    else:
        part = source_part(file_bytes, filename)
        if part is None:
            return _blank_result('', 'skipped',
                                 'The document could not be shown to the model.')
        system, ask = _DIRECT_SYSTEM, [part, text_part(_DIRECT_PROMPT)]

    try:
        convo, reply, provider = ask_first_usable(
            system, llm_providers.ROLE_DOCUMENT, ask, rotation=rotation)
    except LlmError as exc:
        return _blank_result('', 'failed', str(exc))
    except Exception as exc:
        print(f"ERROR: unexpected failure during direct conversion: {exc!r}")
        return _blank_result('', 'failed', 'The conversion could not be completed.')

    tex = fenced_latex(reply) or reply.strip()
    if not tex:
        return _blank_result('', 'failed', 'The model returned no document.')

    report = []
    compile_result = {'attempted': False, 'ok': False, 'engine': None,
                      'errors': '', 'missing_packages': [], 'reason': None}
    if validate:
        budget = _int_env('AI_QA_MAX_API_CALLS', 3) - convo.calls
        tex, compile_result = _validate_and_repair(convo, tex, budget, report)

    return {
        'tex': tex, 'status': 'corrected', 'message': '',
        'findings': report, 'equations': [], 'summary': {},
        'compile': compile_result, 'usage': convo.usage,
        'model': convo.model, 'provider': provider.name,
    }


def finalise_document(tex):
    """
    Validate an assembled document and repair it once if it will not build.

    Used after several pages have been merged, where no single conversation
    holds the whole document. The repair conversation is opened fresh and
    without the original attached, so it is told plainly that it is fixing
    structure and must not touch content.

    Returns (tex, compile_result, findings). Never raises: a document that
    cannot be repaired is still the user's document.
    """
    findings = []
    if not (tex or '').strip():
        return tex, {'attempted': False, 'ok': False, 'engine': None,
                     'errors': '', 'missing_packages': [], 'reason': None}, findings

    if not enabled():
        problems = latex_tools.static_validate(tex)
        compile_result = {'attempted': False, 'ok': False, 'engine': None,
                          'errors': '', 'missing_packages': [],
                          'reason': None}
        if not problems and _bool_env('AI_QA_ENABLE_COMPILE', True):
            compile_result = latex_tools.compile_tex(tex)
        return tex, compile_result, findings

    provider = llm_providers.get_provider()
    try:
        # No call is made here - _validate_and_repair only asks if the document
        # is actually broken - so there is nothing to rotate on. Just avoid
        # opening on a model already known to be out of quota.
        convo = provider.start(
            _FIX_SYSTEM, role=llm_providers.ROLE_DOCUMENT,
            model=first_usable_model(llm_providers.ROLE_DOCUMENT))
    except LlmError:
        convo = None

    if convo is None:
        problems = latex_tools.static_validate(tex)
        compile_result = {'attempted': False, 'ok': False, 'engine': None,
                          'errors': '', 'missing_packages': [], 'reason': None}
        if not problems and _bool_env('AI_QA_ENABLE_COMPILE', True):
            compile_result = latex_tools.compile_tex(tex)
        return tex, compile_result, findings

    try:
        tex, compile_result = _validate_and_repair(convo, tex, 1, findings)
    except LlmError as exc:
        return tex, {'attempted': False, 'ok': False, 'engine': None,
                     'errors': '', 'missing_packages': [],
                     'reason': str(exc)}, findings
    return tex, compile_result, findings


def blank_review(tex, status, message):
    """Public constructor for a no-review result (used by convert.py)."""
    return _blank_result(tex, status, message)


def review_page(file_bytes, filename, tex, equations=None, uncertain=None):
    """
    QA the unified pipeline's assembled document.

    One call, one document, the whole page in view. This is the only stage that
    can check the *merge* - whether an equation landed in the right place,
    whether content got duplicated between the two converters, whether
    something that is not an equation was transcribed as one. Two separate
    reviews structurally cannot see that, because neither has both halves.

    Returns the same shape as review_document(), so callers and templates do
    not have to care which review ran.
    """
    if not enabled():
        return _blank_result(tex, 'skipped',
                             'AI review is not configured on this server.')

    part = source_part(file_bytes, filename)
    if part is None:
        return _blank_result(
            tex, 'skipped',
            'The original document could not be shown to the reviewer, so the '
            'converted output was returned unchanged.')

    equations = equations or []
    if equations:
        listing = ('The expressions the formula model reported, in reading '
                   'order:\n'
                   + '\n'.join(f"{item['index']}. {item['latex']}"
                               for item in equations)
                   + '\n')
    else:
        listing = ('The formula model reported no equations on this page. If '
                   'the image shows mathematics, it was missed - add it.\n')

    # Lines no engine could read - handwriting, almost always. Naming them
    # tells the reviewer exactly where to spend its attention on the image,
    # instead of hoping it notices.
    if uncertain:
        flagged = ('\nThese lines were NOT read reliably by any engine, and are '
                   'very likely handwritten. Treat each as a guess and read it '
                   'off the image yourself:\n'
                   + '\n'.join(f'  - {text[:120]}' for text in uncertain[:20])
                   + '\n')
    else:
        flagged = ''

    try:
        convo, reply, provider = ask_first_usable(
            _UNIFIED_SYSTEM,
            llm_providers.ROLE_EQUATIONS if equations
            else llm_providers.ROLE_DOCUMENT,
            [part, text_part(_UNIFIED_PROMPT.format(
                count=len(equations), listing=listing, uncertain=flagged,
                tex=tex))])
    except LlmError as exc:
        return _blank_result(tex, 'failed', str(exc))
    except Exception as exc:
        print(f"ERROR: unexpected failure during unified QA: {exc!r}")
        return _blank_result(tex, 'failed',
                             'The AI review could not be completed, so the '
                             'converted output was returned unchanged.')

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
        report = ['The converted document already matches the source page.']
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

    try:
        convo, reply, provider = ask_first_usable(
            _DOCUMENT_SYSTEM, llm_providers.ROLE_DOCUMENT,
            [part, text_part(_DOCUMENT_PROMPT.format(tex=tex))])
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

    try:
        convo, reply, provider = ask_first_usable(
            _EQUATION_SYSTEM, llm_providers.ROLE_EQUATIONS,
            [part, text_part(prompt)])
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
