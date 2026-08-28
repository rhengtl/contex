# ai.py
"""
The AI half of the conversion pipeline.

The model reads the upload itself and writes the LaTeX:

    image / PDF page / .docx -> convert_page() -> .tex

Tesseract and pix2text-mfr stand behind it as a local fallback for when it is
unavailable, and the user is warned before that fallback is used - it is
measurably worse. See run.py for how the two are chosen between.

Two rules shape everything below.

**The AI is an enhancement, never a gate.** Every failure path - no API key, a
dead network, an exhausted free-tier quota, an unparseable reply - falls back
to the local converters rather than failing, with a note saying why. A user
must never lose their conversion because the model was unavailable.

**Source fidelity outranks tidiness.** The model is told to treat the page as
the evidence and to leave unusual-but-valid content alone - mathematics above
all. "This looks odd" is not grounds for changing it; "the image clearly shows
something else" is.
"""

import io
import os
import re

from PIL import Image

from contex import config
from contex.services.llm import availability
from contex.pipeline import latex
from contex.services import llm
from contex.pipeline import preprocess
from contex.services.llm import (LlmError, LlmModelError, LlmQuotaError,
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


def enabled():
    """AI conversion runs when a provider is configured and is switched on."""
    return config.enabled('AI_QA_ENABLED', True) and llm.is_configured()


def provider_info():
    """Describe the active provider for the UI (never includes credentials)."""
    provider = llm.get_provider()
    models = provider.models()
    return {
        'name': provider.name,
        # Per-pipeline models; 'model' stays for callers that want just one.
        'models': models,
        'model': models.get(llm.ROLE_DOCUMENT),
        'configured': provider.is_configured(),
        'enabled': enabled(),
        'available': llm.available(),
        # Drives the disclosure notice shown above the upload controls.
        'trains_on_input': provider.trains_on_free_input(),
    }


# ---------------------------------------------------------------------------
# Showing the original document to the model
# ---------------------------------------------------------------------------

def _prepare_image(file_bytes, extension):
    """
    The bytes to show the model, and their media type.

    The original upload is sent unchanged whenever that is the best option:
    the model already reads it, it is small enough to send whole, and
    conditioning found nothing to correct. Re-encoding it in that case would
    cost a decode and an encode to produce the same page.

    Otherwise the conditioned image is sent - and it is the conditioned one
    that goes, not the original. A page that needed deskewing is worth 28% to
    99.8% character accuracy straightened, so having done the work, sending the
    unstraightened original instead would be the one indefensible outcome.
    """
    media_type = _NATIVE_IMAGE_TYPES.get(extension)
    with Image.open(io.BytesIO(file_bytes)) as img:
        img.load()
        conditioned, _notes = preprocess.prepare_image(img)
        too_big = max(conditioned.size) > _MAX_IMAGE_EDGE
        if media_type and not too_big and conditioned is img:
            return file_bytes, media_type
        if conditioned.mode not in ('RGB', 'L'):
            conditioned = conditioned.convert('RGB')
        if too_big:
            conditioned.thumbnail((_MAX_IMAGE_EDGE, _MAX_IMAGE_EDGE),
                                  Image.LANCZOS)
        buffer = io.BytesIO()
        # PNG is lossless either way; optimize=True only trades noticeably more
        # CPU for a few percent of size, on a page that is about to be uploaded
        # once and discarded.
        conditioned.save(buffer, format='PNG', compress_level=6)
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
    Build the content part that shows the model the original upload.

    Returns None when the file cannot be presented (unknown type, unreadable,
    too large) - the caller then falls back to the local converters rather
    than failing the conversion.
    """
    if not file_bytes:
        return None
    extension = os.path.splitext(filename or '')[1].lower()
    limit = config.integer('AI_QA_MAX_UPLOAD_MB', 20) * 1024 * 1024
    if len(file_bytes) > limit:
        return None

    try:
        if extension == '.pdf':
            data = _prepare_pdf(file_bytes, config.integer('AI_QA_MAX_PDF_PAGES', 10))
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
def _validate_and_repair(convo, tex, calls_left, report):
    """
    Check the converted document and give the model one chance to fix it.

    Bounded deliberately: the point of this layer is fidelity, not chasing a
    compiler. If it still does not validate we keep the text anyway and say so.
    """
    problems = latex.static_validate(tex)
    compile_result = {'attempted': False, 'ok': False, 'engine': None,
                      'errors': '', 'missing_packages': [], 'reason': None}

    if not problems and config.enabled('AI_QA_ENABLE_COMPILE', True):
        compile_result = latex.compile_tex(tex, want_pdf=True)
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
                still = latex.static_validate(repaired)
                if not still:
                    report.append('Fixed a LaTeX validation error.')
                    # Re-check: reporting the pre-repair compile result would
                    # tell the user a working document does not build.
                    if config.enabled('AI_QA_ENABLE_COMPILE', True):
                        compile_result = latex.compile_tex(
                            repaired, want_pdf=True)
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
    told us to stay away from until a stated time - see availability.hard_blocked.

    `pinned()` builds a throwaway round for one speculative call: a single
    model, and a quota error that changes nothing anywhere. run.py sends a
    document's pages out concurrently through those, so that a 429 caused by
    our own burst cannot retire a model the service is perfectly willing to
    serve one request at a time. See _convert_units.
    """

    @classmethod
    def pinned(cls, model, role=None):
        """A one-model round whose failures are private to it."""
        rotation = cls(role)
        rotation.chain = [model] if model else []
        rotation.cursor = 0
        rotation.exhausted = not rotation.chain
        rotation.records = False
        return rotation

    def __init__(self, role=None):
        self.role = role or llm.ROLE_DOCUMENT
        self.provider = llm.get_provider()
        self.chain = self.provider.model_chain(self.role)
        self.cursor = 0
        self.exhausted = not self.chain
        #: Whether a failure here is allowed to mark a model unavailable for
        #: the whole server. False for speculative rounds - see pinned().
        self.records = True
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
            if availability.hard_blocked(model):
                record = availability.record_for(model) or {}
                last = LlmQuotaError(record.get('message')
                                     or f'{model} is rate limited.')
                self._advance()
                self._announce(model, last)
                continue

            # A model already believed to be out gets one quick confirmation
            # instead of three attempts with backoff.
            attempts = 1 if availability.record_for(model) else None

            try:
                convo = self.provider.start(system, model=model, role=self.role,
                                            attempts=attempts)
                reply = convo.ask(parts)
            except LlmQuotaError as exc:
                if self.records:
                    availability.record_model_outage(
                        model, str(exc), retry_after=exc.retry_after,
                        scope=exc.scope, provider=self.provider.name)
                last = exc
                self._advance()
                self._announce(model, exc)
            except LlmModelError as exc:
                if self.records:
                    availability.record_model_outage(
                        model, str(exc),
                        retry_after=availability._MODEL_ERROR_SECONDS,
                        scope='model', provider=self.provider.name,
                        from_provider=False)
                last = exc
                self._advance()
                self._announce(model, exc)
            except LlmError as exc:
                # A rejected key or an unreachable network dooms every model,
                # so rotating would repeat the same failure three more times.
                if self.records:
                    availability.record_outage(str(exc),
                                            provider=self.provider.name)
                self.exhausted = True
                self.fatal = exc
                raise
            else:
                # This model answered, so it is not exhausted and neither is
                # the service. Not clearing here is what would strand the app
                # on the fallback path after the service came back. A
                # speculative round clears too: a success is unambiguous good
                # news however it was obtained.
                availability.clear_model(model)
                return convo, reply

        raise last or LlmError('No usable model is configured for this server.')

    def _announce(self, model, error):
        if not self.records:
            return
        nxt = self.active
        if nxt:
            print(f'Notice: {model} is unavailable ({error}); trying {nxt}.')
        else:
            print(f'Notice: {model} is unavailable ({error}); '
                  'no models left this round.')


def first_usable_model(role):
    """The best model for this role that is not currently known to be out."""
    provider = llm.get_provider()
    chain = provider.model_chain(role)
    usable = availability.usable_models(chain)
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


def _blank_result(tex, status, message):
    return {
        'tex': tex,
        'status': status,
        'message': message,
        'findings': [],
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

    Returns the same shape as blank_review(), so a caller handles a converted
    page and a skipped one the same way. On failure it returns an empty
    document with a status: there is no converter draft to fall back on here,
    which is the central trade-off of going AI-first. run.py is what turns
    that failure into the local fallback.
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
            system, llm.ROLE_DOCUMENT, ask, rotation=rotation)
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
        budget = config.integer('AI_QA_MAX_API_CALLS', 3) - convo.calls
        tex, compile_result = _validate_and_repair(convo, tex, budget, report)

    return {
        'tex': tex, 'status': 'corrected', 'message': '',
        'findings': report,
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
        problems = latex.static_validate(tex)
        compile_result = {'attempted': False, 'ok': False, 'engine': None,
                          'errors': '', 'missing_packages': [],
                          'reason': None}
        if not problems and config.enabled('AI_QA_ENABLE_COMPILE', True):
            compile_result = latex.compile_tex(tex, want_pdf=True)
        return tex, compile_result, findings

    provider = llm.get_provider()
    try:
        # No call is made here - _validate_and_repair only asks if the document
        # is actually broken - so there is nothing to rotate on. Just avoid
        # opening on a model already known to be out of quota.
        convo = provider.start(
            _FIX_SYSTEM, role=llm.ROLE_DOCUMENT,
            model=first_usable_model(llm.ROLE_DOCUMENT))
    except LlmError:
        convo = None

    if convo is None:
        problems = latex.static_validate(tex)
        compile_result = {'attempted': False, 'ok': False, 'engine': None,
                          'errors': '', 'missing_packages': [], 'reason': None}
        if not problems and config.enabled('AI_QA_ENABLE_COMPILE', True):
            compile_result = latex.compile_tex(tex, want_pdf=True)
        return tex, compile_result, findings

    try:
        tex, compile_result = _validate_and_repair(convo, tex, 1, findings)
    except LlmError as exc:
        return tex, {'attempted': False, 'ok': False, 'engine': None,
                     'errors': '', 'missing_packages': [],
                     'reason': str(exc)}, findings
    return tex, compile_result, findings


def blank_review(tex, status, message):
    """Public constructor for a no-review result (used by run.py)."""
    return _blank_result(tex, status, message)
