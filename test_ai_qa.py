# test_ai_qa.py
"""
Verification suite for the two converters and the AI QA layer.

Run it with:      python test_ai_qa.py

Covers everything that does not need a live API key: equation segmentation, the
LaTeX validator, the real compile path, image preprocessing, both Flask routes,
the session-scoped download store, and the QA layer driven by a scripted
stand-in for the reviewer. The heavy OCR model and Firebase are stubbed out so
the suite runs in seconds and touches no network.
"""

import io
import os
import sys
import tempfile
import types

# --- Isolate the app from its heavy/optional dependencies ------------------
_recognized = {}


def _fake_process_image_list(file_bytes):
    return _recognized.get('equations', [{'index': 1, 'latex': 'x^2'}])


_fake_equation = types.ModuleType('equation')
_fake_equation.is_model_loaded = lambda: True
_fake_equation.process_image = lambda data: 'x^2'
_fake_equation.process_image_list = _fake_process_image_list
sys.modules['equation'] = _fake_equation

_saved_history = []
_fake_firebase = types.ModuleType('firebase_config')
_fake_firebase.save_ocr_history = lambda uid, name, kind, result: (
    _saved_history.append((uid, name, kind, result)) or True)
_fake_firebase.get_user_ocr_history = lambda *a, **k: []
_fake_firebase.verify_id_token = lambda *a, **k: None
_fake_firebase.get_user_by_uid = lambda *a, **k: None
_fake_firebase.upsert_user_profile = lambda *a, **k: True
_fake_firebase.verify_user = lambda *a, **k: {'success': False}
_fake_firebase.create_user = lambda *a, **k: {'success': False}
_fake_firebase.send_password_reset = lambda *a, **k: {'success': True}
sys.modules['firebase_config'] = _fake_firebase

_SCRATCH = tempfile.mkdtemp(prefix='contex_test_')
os.environ['UPLOAD_FOLDER'] = _SCRATCH
os.environ['FLASK_SECRET_KEY'] = 'test-secret'
os.environ.setdefault('GEMINI_API_KEY', 'test-key-not-used')

from PIL import Image  # noqa: E402
import pikepdf  # noqa: E402

import ai_qa  # noqa: E402
import latex_tools  # noqa: E402
import llm_providers  # noqa: E402
import preprocess  # noqa: E402
import tex_store  # noqa: E402
import textract_fast  # noqa: E402
import app as flask_app  # noqa: E402


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

_RESULTS = []


def test(name):
    def decorator(fn):
        _RESULTS.append((name, fn))
        return fn
    return decorator


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def skip(reason):
    print(f'      (skipped: {reason})', end=' ')


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

GOOD_TEX = r"""\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Energy}
Einstein's relation is $E = mc^{2}$.
\end{document}
"""

CODE_FENCE = '\n```latex\n'

BROKEN_TEX = r"""\documentclass{article}
\begin{document}
\begin{itemize}
\item One
\end{document}
"""


def png_bytes(size=(600, 400), color=(255, 255, 255)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, format='PNG')
    return buffer.getvalue()


def pdf_bytes(pages=2):
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(200, 200))
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


def text_page(lines=('Chapter 1', 'The quick brown fox jumps'), size=(900, 300)):
    from PIL import ImageDraw
    image = Image.new('L', size, 255)
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((40, 40 + index * 60), line, fill=0)
    return image


def render_tex_page(body, dpi=150):
    """Render LaTeX to a page image - used to test equation segmentation."""
    source = (r'\documentclass[12pt]{article}\usepackage[margin=2cm]{geometry}'
              r'\usepackage{amsmath}\pagestyle{empty}\begin{document}'
              + body + r'\end{document}')
    result = latex_tools.compile_tex(source, want_pdf=True)
    if not result['ok']:
        return None
    try:
        from pdf2image import convert_from_bytes
    except ImportError:
        return None
    try:
        return convert_from_bytes(result['pdf'], dpi=dpi)[0]
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Equation segmentation - the converter's new list output
# ---------------------------------------------------------------------------
# equation.py is stubbed for the route tests, so load the real module under a
# different name with its model imports faked out.

def _load_real_equation_module():
    import importlib.util
    for name, attr in (('transformers', 'TrOCRProcessor'),
                       ('optimum.onnxruntime', 'ORTModelForVision2Seq')):
        if name not in sys.modules:
            module = types.ModuleType(name)
            setattr(module, attr, None)
            sys.modules[name] = module
    sys.modules.setdefault('optimum', types.ModuleType('optimum'))
    spec = importlib.util.spec_from_file_location('_real_equation', 'equation.py')
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        pass
    return module


_EQ = _load_real_equation_module()


@test('separate equations on a page are detected separately')
def _():
    page = render_tex_page(r"""\[ E = mc^{2} \]
\[ a^{2}+b^{2}=c^{2} \]
\[ e^{i\pi}+1=0 \]""")
    if page is None:
        return skip('no LaTeX engine or Poppler')
    regions = _EQ.segment_equations(page)
    check(len(regions) == 3, f'{len(regions)} regions, expected 3')


@test('a fraction is not split into numerator and denominator')
def _():
    page = render_tex_page(r'\[ x = \frac{-b \pm \sqrt{b^{2}-4ac}}{2a} \]')
    if page is None:
        return skip('no LaTeX engine or Poppler')
    regions = _EQ.segment_equations(page)
    check(len(regions) == 1, f'a single fraction split into {len(regions)} pieces')


@test('nested fractions stay in one region')
def _():
    page = render_tex_page(r'\[ y = \frac{\frac{a}{b}}{\frac{c}{d}} \]')
    if page is None:
        return skip('no LaTeX engine or Poppler')
    check(len(_EQ.segment_equations(page)) == 1, 'nested fraction was split')


@test('equations containing fractions are still separated from each other')
def _():
    page = render_tex_page(r"""\[ E = mc^{2} \]
\[ x = \frac{-b \pm \sqrt{b^{2}-4ac}}{2a} \]
\[ \sum_{i=1}^{n} i = \frac{n(n+1)}{2} \]
\[ \int_{0}^{1} x^{2}\,dx = \frac{1}{3} \]""")
    if page is None:
        return skip('no LaTeX engine or Poppler')
    regions = _EQ.segment_equations(page)
    check(len(regions) == 4, f'{len(regions)} regions, expected 4')


@test('a single equation is returned as one region, as it always was')
def _():
    page = render_tex_page(r'\[ E = mc^{2} \]')
    if page is None:
        return skip('no LaTeX engine or Poppler')
    check(len(_EQ.segment_equations(page)) == 1, 'single equation was split')


@test('each region is cropped tightly around its equation')
def _():
    # pix2text-mfr expects a formula that fills its crop. Handing it a
    # full-width strip of mostly blank page made it emit runs of \qquad
    # instead of the expression, so the crop must follow the ink horizontally.
    page = render_tex_page(r"""\[ v = u + at \]
\[ v^{2} = u^{2} + 2as \]""")
    if page is None:
        return skip('no LaTeX engine or Poppler')
    regions = _EQ.segment_equations(page)
    check(len(regions) == 2, f'{len(regions)} regions, expected 2')
    for region in regions:
        check(region.size[0] < page.size[0] * 0.9,
              f'region is {region.size[0]}px wide on a {page.size[0]}px page '
              '- it was not cropped horizontally')


@test('a blank page does not crash the segmenter')
def _():
    blank = Image.new('L', (400, 300), 255)
    check(len(_EQ.segment_equations(blank)) == 1, 'blank page misbehaved')


@test('the number of regions is capped')
def _():
    body = '\n'.join(rf'\[ x_{{{i}}} = {i} \]' for i in range(20))
    page = render_tex_page(body)
    if page is None:
        return skip('no LaTeX engine or Poppler')
    check(len(_EQ.segment_equations(page, max_regions=5)) <= 5, 'cap ignored')


# ---------------------------------------------------------------------------
# LaTeX validation and compilation (unchanged machinery, still relied on)
# ---------------------------------------------------------------------------

@test('static validator accepts a well-formed document')
def _():
    check(latex_tools.static_validate(GOOD_TEX) == [],
          latex_tools.static_validate(GOOD_TEX))


@test('static validator catches an unclosed environment')
def _():
    check(any('itemize' in issue for issue in latex_tools.static_validate(BROKEN_TEX)),
          latex_tools.static_validate(BROKEN_TEX))


@test('a valid document compiles')
def _():
    result = latex_tools.compile_tex(GOOD_TEX)
    if not result['attempted']:
        return skip('no LaTeX engine installed')
    check(result['ok'], result['errors'] or result['reason'])


# ---------------------------------------------------------------------------
# Preprocessing (kept from the measured bench work)
# ---------------------------------------------------------------------------

@test('deskew recovers a rotated page')
def _():
    skewed = text_page().rotate(-8, resample=Image.BICUBIC, expand=True,
                                fillcolor=255)
    _fixed, angle = preprocess.deskew(skewed)
    check(6.0 <= angle <= 10.0, f'estimated {angle}, expected about +8')


@test('deskew leaves a straight page untouched')
def _():
    straight = text_page()
    fixed, angle = preprocess.deskew(straight)
    check(angle == 0.0 and fixed is straight, f'straight page rotated by {angle}')


# ---------------------------------------------------------------------------
# Showing the source document to the reviewer
# ---------------------------------------------------------------------------

@test('an image is prepared as a media part for the reviewer')
def _():
    part = ai_qa.source_part(png_bytes(), 'scan.png')
    check(part and part['kind'] == 'media', part)
    check(part['media_type'] == 'image/png', part['media_type'])


@test('a PDF is prepared as a document part')
def _():
    part = ai_qa.source_part(pdf_bytes(), 'paper.pdf')
    check(part and part['media_type'] == 'application/pdf', part)


@test('an unusable source is refused without raising')
def _():
    for data, name in ((b'', 'x.png'), (b'nonsense', 'x.docx'),
                       (b'nonsense', 'x.png')):
        check(ai_qa.source_part(data, name) is None, f'{name} was accepted')


@test('an oversized source is refused so QA is skipped, not attempted')
def _():
    os.environ['AI_QA_MAX_UPLOAD_MB'] = '1'
    try:
        check(ai_qa.source_part(b'x' * (2 * 1024 * 1024), 'big.png') is None,
              'oversized file accepted')
    finally:
        del os.environ['AI_QA_MAX_UPLOAD_MB']


# ---------------------------------------------------------------------------
# Scripted reviewer
# ---------------------------------------------------------------------------

class ScriptedConversation(llm_providers.Conversation):
    def __init__(self, provider, model, system, script):
        super().__init__(provider, model, system)
        self.script = script
        self.turns = []

    def ask(self, parts):
        self.calls += 1
        self.turns.append(parts)
        self._count(input=10, output=5)
        if not self.script:
            raise AssertionError('the scripted reviewer ran out of replies')
        reply = self.script.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class ScriptedProvider(llm_providers.Provider):
    name = 'scripted'

    def __init__(self, script, fail_on_start=None):
        self.script = list(script)
        self.conversation = None
        self.fail_on_start = fail_on_start

    def is_configured(self):
        return True

    def default_model(self):
        return 'scripted-reviewer'

    def start(self, system, model=None):
        if self.fail_on_start:
            raise self.fail_on_start
        self.conversation = ScriptedConversation(
            self, model or self.default_model(), system, self.script)
        return self.conversation


def with_reviewer(script, fail_on_start=None):
    provider = ScriptedProvider(script, fail_on_start)
    llm_providers.get_provider = lambda name=None: provider
    return provider


_REAL_GET_PROVIDER = llm_providers.get_provider


def restore_provider():
    llm_providers.get_provider = _REAL_GET_PROVIDER


def prompt_text(parts):
    return '\n'.join(p['text'] for p in parts if p['kind'] == 'text')


# ---------------------------------------------------------------------------
# Textract QA
# ---------------------------------------------------------------------------

@test('the generated .tex and the original document both reach the reviewer')
def _():
    provider = with_reviewer(['LATEX_OK'])
    try:
        ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        parts = provider.conversation.turns[0]
        check(any(p['kind'] == 'media' for p in parts),
              'the original document was not shown to the reviewer')
        check('E = mc^{2}' in prompt_text(parts),
              'the generated LaTeX was not sent for review')
    finally:
        restore_provider()


@test('a clean review returns the OCR output unchanged')
def _():
    with_reviewer(['LATEX_OK'])
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['status'] == 'clean', result['status'])
        check(result['tex'] == GOOD_TEX, 'a clean review altered the document')
    finally:
        restore_provider()


@test('the reviewer can correct an obvious OCR error')
def _():
    garbled = GOOD_TEX.replace('Einstein', 'Einstem').replace('Energy', 'Enerqy')
    with_reviewer([
        "- 'Einstem' should read 'Einstein'\n"
        "- the heading 'Enerqy' should read 'Energy'\n"
        f'```latex\n{GOOD_TEX}```'])
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', garbled)
        check(result['status'] == 'corrected', result['status'])
        check('Einstein' in result['tex'] and 'Enerqy' not in result['tex'],
              'the correction was not applied')
        check(any('Einstein' in f for f in result['findings']),
              f"findings not reported: {result['findings']}")
    finally:
        restore_provider()


@test('a corrected document that does not validate gets one repair attempt')
def _():
    with_reviewer([f'Fixed some text.\n```latex\n{BROKEN_TEX}```',
                   f'```latex\n{GOOD_TEX}```'])
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(latex_tools.static_validate(result['tex']) == [],
              'an invalid document was returned')
        check(any('validation' in f.lower() for f in result['findings']),
              result['findings'])
    finally:
        restore_provider()


@test('a repaired document is re-checked, not reported with a stale status')
def _():
    if not latex_tools.find_engine():
        return skip('no LaTeX engine installed')
    with_reviewer([
        'Fixed it.' + CODE_FENCE + BROKEN_TEX + '```',
        CODE_FENCE + GOOD_TEX + '```'])
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['tex'].strip() == GOOD_TEX.strip(), 'repair not applied')
        check(result['compile']['ok'],
              'a working document was reported as not compiling')
    finally:
        restore_provider()


@test('a reviewer failure returns the OCR output, never an error page')
def _():
    with_reviewer([], fail_on_start=llm_providers.LlmError(
        'The free Gemini quota is exhausted.'))
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['status'] == 'failed', result['status'])
        check(result['tex'] == GOOD_TEX, 'the OCR output was lost on failure')
        check('quota' in result['message'], result['message'])
    finally:
        restore_provider()


@test('an unexpected reviewer crash still returns the OCR output')
def _():
    with_reviewer([RuntimeError('/secret/path/to/key.json')])
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['tex'] == GOOD_TEX, 'the OCR output was lost')
        check('/secret/path' not in result['message'], result['message'])
    finally:
        restore_provider()


@test('QA is skipped cleanly when no provider is configured')
def _():
    saved = {k: os.environ.pop(k) for k in
             ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY')
             if k in os.environ}
    try:
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['status'] == 'skipped', result['status'])
        check(result['tex'] == GOOD_TEX, 'the OCR output was altered')
    finally:
        os.environ.update(saved)


@test('QA can be switched off without touching the converters')
def _():
    os.environ['AI_QA_ENABLED'] = 'false'
    try:
        check(not ai_qa.enabled(), 'AI_QA_ENABLED=false was ignored')
        result = ai_qa.review_document(png_bytes(), 'scan.png', GOOD_TEX)
        check(result['status'] == 'skipped' and result['tex'] == GOOD_TEX, result)
    finally:
        del os.environ['AI_QA_ENABLED']


# ---------------------------------------------------------------------------
# Equation QA
# ---------------------------------------------------------------------------

EQUATIONS = [
    {'index': 1, 'latex': 'v = u + at'},
    {'index': 2, 'latex': 's = ut + \\frac{1}{2}at^{2}'},
    {'index': 3, 'latex': 'v^{2} = u^{2} + 2as'},
]

REVIEW_REPLY = """[EQ 1]
status: ok
latex: v = u + at
fidelity: matches the image exactly
math: standard kinematic relation, coherent

[EQ 2]
status: corrected
latex: s = ut + \\frac{1}{2}at^{2}
fidelity: the image shows 1/2, the OCR read it as 1\\2
math: coherent once the fraction is restored

[EQ 3]
status: ok
latex: v^{2} = u^{2} + 2as
fidelity: matches the image
math: consistent with the other two

[SUMMARY]
missing: none
related: yes
relationship: the three standard equations of motion for constant acceleration
ordering: as given; the image lists them in this order
grouping: they should be grouped in a single align environment

```latex
\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\begin{align}
v &= u + at \\\\
s &= ut + \\frac{1}{2}at^{2} \\\\
v^{2} &= u^{2} + 2as
\\end{align}
\\end{document}
```
"""


@test('the equation list and the original image both reach the reviewer')
def _():
    provider = with_reviewer([REVIEW_REPLY])
    try:
        ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        parts = provider.conversation.turns[0]
        check(any(p['kind'] == 'media' for p in parts),
              'the original image was not shown to the reviewer')
        text = prompt_text(parts)
        for item in EQUATIONS:
            check(item['latex'] in text,
                  f"equation {item['index']} was not sent for review")
        check('1. ' in text and '3. ' in text,
              'the equations were not presented as an ordered list')
    finally:
        restore_provider()


@test('every equation gets a transcription verdict')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        check(len(result['equations']) == 3,
              f"{len(result['equations'])} verdicts for 3 equations")
        for verdict in result['equations']:
            check(verdict['fidelity'], f'no fidelity check on {verdict}')
    finally:
        restore_provider()


@test('every equation gets a mathematical plausibility verdict')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        for verdict in result['equations']:
            check(verdict['math'], f'no mathematics check on {verdict}')
    finally:
        restore_provider()


@test('a corrected equation is reported with its corrected LaTeX')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        corrected = [e for e in result['equations'] if e['status'] == 'corrected']
        check(len(corrected) == 1, f'{len(corrected)} corrections found')
        check('frac' in corrected[0]['latex'], corrected[0])
        check(result['status'] == 'corrected', result['status'])
    finally:
        restore_provider()


@test('the reviewer decides whether the equations are related')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        check(result['summary']['related'] is True, result['summary'])
        check('equations of motion' in result['summary']['relationship'],
              result['summary']['relationship'])
        check(result['summary']['ordering'], 'no ordering decision')
        check('align' in result['summary']['grouping'],
              result['summary']['grouping'])
    finally:
        restore_provider()


@test('related equations are grouped and ordered in the final .tex')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        tex = result['tex']
        check(r'\begin{align}' in tex, 'related equations were not grouped')
        check(tex.index('u + at') < tex.index('ut +') < tex.index('2as'),
              'the equations are not in the reviewed order')
        check(latex_tools.static_validate(tex) == [],
              latex_tools.static_validate(tex))
    finally:
        restore_provider()


@test('the final equation document compiles')
def _():
    with_reviewer([REVIEW_REPLY])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
    finally:
        restore_provider()
    if not latex_tools.find_engine():
        return skip('no LaTeX engine installed')
    check(result['compile']['ok'],
          result['compile']['errors'] or result['compile']['reason'])


@test('unusual but valid mathematics is preserved, not "corrected"')
def _():
    unusual = [{'index': 1, 'latex': '\\frac{d^{3}y}{dx^{3}} = -\\pi^{e}'}]
    reply = """[EQ 1]
status: ok
latex: \\frac{d^{3}y}{dx^{3}} = -\\pi^{e}
fidelity: the image really does show a third derivative equal to -pi^e
math: unconventional but well formed; no sign of a recognition error

[SUMMARY]
missing: none
related: no
relationship: independent
ordering: as given
grouping: none

```latex
\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\begin{equation*}
\\frac{d^{3}y}{dx^{3}} = -\\pi^{e}
\\end{equation*}
\\end{document}
```
"""
    with_reviewer([reply])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', unusual)
        check(result['equations'][0]['status'] == 'ok',
              'an unusual but valid expression was marked as wrong')
        check('\\pi^{e}' in result['tex'],
              'the unusual expression was altered in the output')
        check(result['status'] == 'clean', result['status'])
    finally:
        restore_provider()


@test('duplicates and non-equations are dropped from the output')
def _():
    noisy = [{'index': 1, 'latex': 'E = mc^{2}'},
             {'index': 2, 'latex': 'E = mc^{2}'},
             {'index': 3, 'latex': 'Figure 1'}]
    reply = """[EQ 1]
status: ok
latex: E = mc^{2}
fidelity: matches
math: fine

[EQ 2]
status: duplicate
latex: E = mc^{2}
fidelity: the same expression as entry 1
math: n/a

[EQ 3]
status: not_an_equation
latex: Figure 1
fidelity: this is a figure caption, not an expression
math: n/a

[SUMMARY]
missing: none
related: no
relationship: independent
ordering: as given
grouping: none
"""
    with_reviewer([reply])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', noisy)
        check(result['status'] == 'partial', result['status'])
        check(result['tex'].count('E = mc^{2}') == 1,
              'the duplicate survived into the output')
        check('Figure 1' not in result['tex'],
              'a non-equation survived into the output')
    finally:
        restore_provider()


@test('a reviewer failure still returns the detected equations')
def _():
    with_reviewer([], fail_on_start=llm_providers.LlmError('network down'))
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        check(result['status'] == 'failed', result['status'])
        for item in EQUATIONS:
            check(item['latex'] in result['tex'],
                  f"equation {item['index']} was lost when QA failed")
        check(latex_tools.static_validate(result['tex']) == [],
              latex_tools.static_validate(result['tex']))
    finally:
        restore_provider()


@test('the un-reviewed fallback layout is valid LaTeX')
def _():
    tex = ai_qa.equations_to_tex(EQUATIONS)
    check(latex_tools.static_validate(tex) == [], latex_tools.static_validate(tex))
    check(tex.count(r'\begin{equation*}') == 3, tex)


@test('a malformed reviewer reply degrades instead of losing the equations')
def _():
    with_reviewer(['I am not going to follow the format.'])
    try:
        result = ai_qa.review_equations(png_bytes(), 'eq.png', EQUATIONS)
        check(result['status'] == 'partial', result['status'])
        for item in EQUATIONS:
            check(item['latex'] in result['tex'], 'an equation was lost')
    finally:
        restore_provider()


@test('the review parser tolerates extra prose around the blocks')
def _():
    equations, summary = ai_qa.parse_equation_review(
        'Here is my review.\n\n' + REVIEW_REPLY + '\n\nHope that helps.')
    check(len(equations) == 3, f'{len(equations)} parsed')
    check(summary['related'] is True, summary)


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

def client_for_tests():
    flask_app.app.config['TESTING'] = True
    return flask_app.app.test_client()


def qa_result(tex, status='clean', **extra):
    base = {
        'tex': tex, 'status': status, 'message': '', 'findings': [],
        'equations': [], 'summary': {},
        'compile': {'attempted': False, 'ok': False, 'engine': None,
                    'errors': '', 'missing_packages': [], 'reason': None},
        'usage': {'input': 1, 'output': 1, 'cache_read': 0, 'cache_write': 0},
        'model': 'scripted-reviewer', 'provider': 'scripted',
    }
    base.update(extra)
    return base


@test('Textract produces the initial .tex and passes it to QA')
def _():
    seen = {}

    def capture(file_bytes, filename, tex):
        seen['tex'] = tex
        seen['bytes'] = file_bytes
        seen['name'] = filename
        return qa_result(tex)

    flask_app.extract_text_from_file = lambda path, **k: 'Recognised text 100%'
    flask_app.ai_qa.review_document = capture
    client = client_for_tests()
    response = client.post('/textract', data={
        'file': (io.BytesIO(png_bytes()), 'notes.png')})
    check(response.status_code == 302, response.status_code)
    check(r'\documentclass' in seen['tex'], 'no .tex was generated')
    check(r'100\%' in seen['tex'], 'Tesseract output missing or unescaped')
    check(seen['bytes'] and seen['name'] == 'notes.png',
          'the original upload was not passed to QA')


@test('the reviewed Textract .tex is what the page shows and downloads')
def _():
    corrected = GOOD_TEX.replace('Energy', 'Corrected Heading')
    flask_app.extract_text_from_file = lambda path, **k: 'raw ocr text'
    flask_app.ai_qa.review_document = lambda *a, **k: qa_result(
        corrected, 'corrected', findings=['Fixed the heading.'])
    client = client_for_tests()
    client.post('/textract', data={'file': (io.BytesIO(png_bytes()), 'notes.png')})

    page = client.get('/').get_data(as_text=True)
    check('raw ocr text' in page, 'the raw OCR text is no longer shown')
    check('Corrected Heading' in page, 'the reviewed .tex is not shown')
    check('Fixed the heading.' in page, 'the QA findings are not shown')

    download = client.get('/download-tex')
    check(download.status_code == 200, download.status_code)
    check('Corrected Heading' in download.get_data(as_text=True),
          'the download served the un-reviewed version')


@test('Textract still works end to end when QA fails')
def _():
    flask_app.extract_text_from_file = lambda path, **k: 'raw ocr text'
    flask_app.ai_qa.review_document = lambda file_bytes, filename, tex: qa_result(
        tex, 'failed', message='The AI service is unavailable.')
    client = client_for_tests()
    response = client.post('/textract', data={
        'file': (io.BytesIO(png_bytes()), 'notes.png')})
    check(response.status_code == 302, response.status_code)
    page = client.get('/').get_data(as_text=True)
    check('raw ocr text' in page, 'the OCR result was lost')
    check('unavailable' in page, 'the failure was not explained to the user')
    check(client.get('/download-tex').status_code == 200, 'download broken')


@test('the equation route lists detected equations and passes them to QA')
def _():
    seen = {}
    _recognized['equations'] = EQUATIONS

    def capture(file_bytes, filename, equations):
        seen['equations'] = equations
        seen['bytes'] = file_bytes
        return qa_result(ai_qa.equations_to_tex(equations))

    flask_app.ai_qa.review_equations = capture
    client = client_for_tests()
    response = client.post('/equation', data={
        'file': (io.BytesIO(png_bytes()), 'eq.png')})
    check(response.status_code == 302, response.status_code)
    check(len(seen['equations']) == 3, seen['equations'])
    check([e['index'] for e in seen['equations']] == [1, 2, 3],
          'equations were not passed as an ordered list')
    check(seen['bytes'], 'the original image was not passed to QA')


@test('the equation page shows the numbered list and the per-equation verdicts')
def _():
    _recognized['equations'] = EQUATIONS
    flask_app.ai_qa.review_equations = lambda *a, **k: qa_result(
        GOOD_TEX, 'corrected',
        equations=[{'index': 1, 'status': 'ok', 'latex': 'v = u + at',
                    'fidelity': 'matches the image', 'math': 'coherent'},
                   {'index': 2, 'status': 'corrected',
                    'latex': 's = ut + \\frac{1}{2}at^{2}',
                    'fidelity': 'the image shows a fraction', 'math': 'fine'},
                   {'index': 3, 'status': 'ok', 'latex': 'v^{2} = u^{2} + 2as',
                    'fidelity': 'matches', 'math': 'fine'}],
        summary={'related': True, 'relationship': 'equations of motion',
                 'ordering': 'as given', 'grouping': 'one align environment',
                 'missing': 'none'})
    client = client_for_tests()
    client.post('/equation', data={'file': (io.BytesIO(png_bytes()), 'eq.png')})
    page = client.get('/').get_data(as_text=True)
    check('v = u + at' in page, 'the detected list is not shown')
    check('matches the image' in page, 'the fidelity verdict is not shown')
    check('equations of motion' in page, 'the relationship is not shown')
    check('one align environment' in page, 'the grouping decision is not shown')
    check('corrected' in page, 'the per-equation status is not shown')


@test('the reviewed equation .tex can be downloaded')
def _():
    _recognized['equations'] = EQUATIONS
    flask_app.ai_qa.review_equations = lambda *a, **k: qa_result(GOOD_TEX)
    client = client_for_tests()
    client.post('/equation', data={'file': (io.BytesIO(png_bytes()), 'eq.png')})
    download = client.get('/download-equation-tex')
    check(download.status_code == 200, download.status_code)
    check(download.get_data(as_text=True) == GOOD_TEX, 'wrong content served')
    check('eq.tex' in download.headers.get('Content-Disposition', ''),
          download.headers.get('Content-Disposition'))


@test("one session cannot download another session's result")
def _():
    _recognized['equations'] = EQUATIONS
    flask_app.ai_qa.review_equations = lambda *a, **k: qa_result(GOOD_TEX)
    victim = client_for_tests()
    victim.post('/equation', data={'file': (io.BytesIO(png_bytes()), 'private.png')})
    page = victim.get('/').get_data(as_text=True)
    token = page.split('download-equation-tex?token=')[1].split('"')[0]

    attacker = client_for_tests()
    stolen = attacker.get(f'/download-equation-tex?token={token}')
    check(stolen.status_code == 404, f'leaked with status {stolen.status_code}')
    check(victim.get(f'/download-equation-tex?token={token}').status_code == 200,
          'owner locked out of their own file')


@test('a download token cannot be pointed at another file on disk')
def _():
    client = client_for_tests()
    for token in ('../../.env', '..%2F..%2F.env', 'deadbeef'):
        for route in ('/download-tex', '/download-equation-tex'):
            response = client.get(f'{route}?token={token}')
            check(response.status_code == 404,
                  f'{route}?{token} -> {response.status_code}')


@test('an empty submission is refused by both routes')
def _():
    called = []
    flask_app.ai_qa.review_document = lambda *a, **k: called.append(1)
    flask_app.ai_qa.review_equations = lambda *a, **k: called.append(1)
    client = client_for_tests()
    for route, anchor in (('/textract', 'textract'), ('/equation', 'equation')):
        response = client.post(route, data={'file': (io.BytesIO(b''), '')})
        check(response.status_code == 302, response.status_code)
    page = client.get('/').get_data(as_text=True)
    check('No file selected' in page, 'no error shown')
    check(not called, 'the reviewer was called for an empty upload')


@test('an upload filename cannot escape the upload folder')
def _():
    seen = {}

    def capture(path, **kwargs):
        seen['path'] = path
        return 'ok'

    flask_app.extract_text_from_file = capture
    flask_app.ai_qa.review_document = lambda file_bytes, filename, tex: qa_result(tex)
    client = client_for_tests()
    client.post('/textract', data={
        'file': (io.BytesIO(png_bytes()), '../../../evil.png')})
    saved = os.path.abspath(seen['path'])
    check(saved.startswith(os.path.abspath(_SCRATCH)), f'escaped to {saved}')


@test('the uploaded file is deleted after Textract runs')
def _():
    flask_app.extract_text_from_file = lambda path, **k: 'text'
    flask_app.ai_qa.review_document = lambda file_bytes, filename, tex: qa_result(tex)
    client = client_for_tests()
    client.post('/textract', data={'file': (io.BytesIO(png_bytes()), 'notes.png')})
    leftovers = [n for n in os.listdir(_SCRATCH) if n.endswith('.png')]
    check(not leftovers, f'upload left on disk: {leftovers}')


@test('both OCR routes stay open to guests')
def _():
    client = client_for_tests()
    for route in ('/equation', '/textract'):
        response = client.get(route)
        check(response.status_code == 302, f'{route}: {response.status_code}')
        check('/login' not in response.headers['Location'],
              f'{route} demanded a login')


@test('a signed-in user gets results saved to their history')
def _():
    _saved_history.clear()
    _recognized['equations'] = EQUATIONS
    flask_app.ai_qa.review_equations = lambda *a, **k: qa_result(GOOD_TEX)
    client = client_for_tests()
    with client.session_transaction() as session:
        session['user'] = {'uid': 'uid-123', 'email': 'a@b.c', 'displayName': 'A'}
    client.post('/equation', data={'file': (io.BytesIO(png_bytes()), 'eq.png')})
    check(_saved_history, 'nothing was written to history')
    uid, name, kind, _result = _saved_history[-1]
    check((uid, kind, name) == ('uid-123', 'equation', 'eq.png'),
          (uid, kind, name))


@test('a guest result is never written to Firestore')
def _():
    _saved_history.clear()
    _recognized['equations'] = EQUATIONS
    flask_app.ai_qa.review_equations = lambda *a, **k: qa_result(GOOD_TEX)
    client = client_for_tests()
    client.post('/equation', data={'file': (io.BytesIO(png_bytes()), 'eq.png')})
    check(not _saved_history, f'guest history reached Firestore: {_saved_history}')


# ---------------------------------------------------------------------------
# Privacy and disclosure
# ---------------------------------------------------------------------------

@test('the free-tier disclosure appears above both upload controls')
def _():
    page = client_for_tests().get('/').get_data(as_text=True)
    collapsed = ' '.join(page.split())
    check(collapsed.count('Before you upload') == 2,
          'the disclosure is not shown on both converters')
    check('to train its models' in collapsed,
          'the disclosure does not say what happens to the document')
    first_notice = page.index('Before you upload')
    check(first_notice < page.index('id="textract-file"'),
          'the disclosure appears after the upload control')


@test('the disclosure says the OCR itself stays on the server')
def _():
    page = client_for_tests().get('/').get_data(as_text=True)
    collapsed = ' '.join(page.split())
    check('OCR runs on this server' in collapsed,
          'the notice does not distinguish local OCR from the remote review')


@test('the paid tier removes the disclosure')
def _():
    os.environ['GEMINI_PAID_TIER'] = 'true'
    try:
        page = client_for_tests().get('/').get_data(as_text=True)
        check('Before you upload' not in page, 'disclosure shown on the paid tier')
    finally:
        del os.environ['GEMINI_PAID_TIER']


@test('no API key is ever rendered into any page')
def _():
    os.environ['GEMINI_API_KEY'] = 'AIza-supersecret-value'
    try:
        client = client_for_tests()
        for path in ('/', '/login', '/signup'):
            body = client.get(path).get_data(as_text=True)
            check('supersecret' not in body, f'{path} exposed the key')
            check('GEMINI_API_KEY=' not in body, f'{path} exposed the var')
    finally:
        os.environ['GEMINI_API_KEY'] = 'test-key-not-used'


@test('an unconfigured server says so and keeps both converters working')
def _():
    saved = {k: os.environ.pop(k) for k in
             ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY')
             if k in os.environ}
    try:
        page = client_for_tests().get('/').get_data(as_text=True)
        check('GEMINI_API_KEY' in page, 'no setup hint shown')
        check('without review' in page, 'the degraded mode is not explained')
        check('id="textract-file"' in page and 'id="equation-form"' in page,
              'a converter disappeared when QA was unconfigured')
    finally:
        os.environ.update(saved)


# ---------------------------------------------------------------------------
# Existing behaviour that must not regress
# ---------------------------------------------------------------------------

@test('the Tesseract pipeline still produces a .tex document')
def _():
    source = textract_fast.generate_tex_source('Hello world')
    check(r'\documentclass{article}' in source and 'Hello world' in source, source)
    check(latex_tools.static_validate(source) == [],
          latex_tools.static_validate(source))


@test('plain OCR text with LaTeX specials is escaped')
def _():
    source = textract_fast.generate_tex_source('50% off & 100_000 units')
    check(r'50\% off \& 100\_000' in source, source)


@test('OCR noise cannot make the generated .tex uncompilable')
def _():
    # Tesseract emits Unicode when it misreads a symbol; before this was
    # handled, one stray guillemet aborted the whole compile.
    noisy = ('coefficient is »/z ≤ α → — dash '
             '“quoted” 50% & x_1 café 中文')
    source = textract_fast.generate_tex_source(noisy)
    check(latex_tools.static_validate(source) == [],
          latex_tools.static_validate(source))
    result = latex_tools.compile_tex(source)
    if not result['attempted']:
        return skip('no LaTeX engine installed')
    check(result['ok'], f"noisy OCR text broke the compile: {result['errors'][:200]}")


@test('escaping keeps renderable characters and replaces the rest')
def _():
    out = textract_fast.escape_tex('café » 中 ≤')
    check('é' in out, 'a Latin-1 accent was destroyed')
    check('»' in out, 'a Latin-1 symbol was destroyed')
    check('中' not in out and '?' in out, 'an unrenderable glyph was kept')
    check(r'$\le$' in out, 'a maths symbol was not mapped to LaTeX')


@test('Tesseract receives a deskewed page')
def _():
    if not textract_fast._TESSERACT_CMD:
        return skip('Tesseract not installed')
    path = os.path.join(_SCRATCH, 'skewed.png')
    text_page().rotate(-9, resample=Image.BICUBIC, expand=True,
                       fillcolor=255).save(path)
    text = textract_fast.extract_text_from_file(path)
    check('Chapter' in text or 'quick' in text,
          f'a rotated page still produced nothing usable: {text!r}')
    os.remove(path)


@test('stored results round-trip and expire by token')
def _():
    token = tex_store.save({'tex': GOOD_TEX, 'source': 'textract'})
    check(tex_store.read(token)['tex'] == GOOD_TEX, 'round-trip failed')
    tex_store.discard(token)
    check(tex_store.read(token) is None, 'discard did not delete')


@test('gemini remains the default provider for the review layer')
def _():
    saved = os.environ.pop('AI_QA_PROVIDER', None)
    try:
        provider = _REAL_GET_PROVIDER()
        check(provider.name == 'gemini', provider.name)
        check(provider.trains_on_free_input(), 'free tier disclosure not declared')
    finally:
        if saved:
            os.environ['AI_QA_PROVIDER'] = saved


# ---------------------------------------------------------------------------

def main():
    passed = failed = 0
    for name, fn in _RESULTS:
        try:
            fn()
        except Exception as exc:
            failed += 1
            print(f'  FAIL  {name}\n        {type(exc).__name__}: {exc}')
        else:
            passed += 1
            print(f'  ok    {name}')
    print(f'\n{passed} passed, {failed} failed')
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        import shutil
        shutil.rmtree(_SCRATCH, ignore_errors=True)
