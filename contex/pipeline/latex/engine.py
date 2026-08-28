"""
Driving a TeX engine: finding one, running it safely, and rasterising what it
produces.

Everything here shells out. Nothing here decides what a document should say -
that is latex/assemble.py and the recognisers - and nothing here judges whether
a document is well formed, which is latex/validate.py. This module is the part
that knows about pdflatex, its flags, its log format and its sandbox.

Compilation is optional by design. With no engine installed the pipeline still
produces a .tex file; only the preview is lost, and the user is told why.
"""

import hashlib
import io
import os
import re
import shutil
import subprocess
import tempfile

from contex import config
from contex.pipeline.latex.validate import unsafe_constructs

# A compile must never hang a web request.
_COMPILE_TIMEOUT = config.integer('LATEX_COMPILE_TIMEOUT', 120)

# Resolution for the preview page images. High enough that the small text in a
# rendered document stays legible when the page is scaled to the panel width,
# low enough that a long document does not turn into megabytes of PNG.
_PREVIEW_DPI = config.integer('PREVIEW_DPI', 110)

# Engines we know how to drive, in preference order.
_ENGINE_CANDIDATES = ('pdflatex', 'xelatex', 'lualatex', 'tectonic')

#: Resolved engine paths, keyed by the LATEX_CMD that asked for them. Looking
#: an engine up walks PATH, which on Windows is a few milliseconds of stat
#: calls - trivial once, but this runs on every page render and every compile.
#: Keyed by LATEX_CMD so changing that setting still takes effect.
_ENGINE_CACHE = {}



def find_engine():
    """
    Return the path to a usable TeX engine, or None if none is installed.

    LATEX_CMD pins an explicit engine; otherwise the first of pdflatex,
    xelatex, lualatex or tectonic found on PATH wins. Compilation is optional
    by design - the pipeline still returns a .tex file when no engine exists.

    The answer is cached per LATEX_CMD: an engine does not appear or vanish
    while the process runs, and re-walking PATH for every compile is pure cost.
    """
    explicit = os.getenv('LATEX_CMD')
    if explicit in _ENGINE_CACHE:
        return _ENGINE_CACHE[explicit]
    found = _locate_engine(explicit)
    _ENGINE_CACHE[explicit] = found
    return found


def _locate_engine(explicit):
    """The uncached lookup behind find_engine()."""
    if explicit:
        if os.path.exists(explicit):
            return explicit
        resolved = shutil.which(explicit)
        if resolved:
            return resolved
        print(f"WARNING: LATEX_CMD={explicit!r} not found; falling back to PATH.")

    for name in _ENGINE_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    return None


def engine_name(engine_path):
    """Bare engine name, e.g. 'pdflatex', for display and flag selection."""
    if not engine_path:
        return None
    return os.path.splitext(os.path.basename(engine_path))[0].lower()


# ---------------------------------------------------------------------------
# Static structural validation (no engine needed)
# ---------------------------------------------------------------------------



# ---------------------------------------------------------------------------
# The sandbox
# ---------------------------------------------------------------------------
#
# Two layers, because neither is sufficient alone.
#
#   1. kpathsea is put into paranoid mode through the environment below. That
#      is the real control on TeX Live, which is what a Linux deployment runs.
#      MiKTeX ignores these variables and is configured through its own ini
#      file, so on Windows this layer does nothing.
#
#   2. The source is refused if it contains a primitive that reads, writes or
#      executes - unsafe_constructs() in validate.py, which is a check on the
#      text and therefore covers MiKTeX too.
#
# On top of both: the engine is invoked as an argv list and never through a
# shell, in a temporary directory that is deleted afterwards, with
# -no-shell-escape, -halt-on-error, a timeout, and no stdin to prompt at.

#: kpathsea settings for the compile subprocess. 'p' is paranoid: no dotfiles,
#: no absolute paths, nothing above the working directory.
_SANDBOX_ENV = {
    'openin_any': 'p',
    'openout_any': 'p',
    'shell_escape': 'f',
}


def _file_access_allowed():
    """
    Whether the guard in validate.py is switched off.

    Read at call time rather than at import so a test - and an operator - can
    change it without restarting.
    """
    return config.flag('LATEX_ALLOW_FILE_ACCESS', False)


def _compile_env():
    """The environment for the engine: ours, plus the kpathsea restrictions."""
    env = dict(os.environ)
    env.update(_SANDBOX_ENV)
    return env


_MIKTEX_CACHE = {}


def _is_miktex(engine):
    if engine in _MIKTEX_CACHE:
        return _MIKTEX_CACHE[engine]
    try:
        proc = subprocess.run([engine, '--version'], capture_output=True,
                              text=True, timeout=20, errors='replace')
        result = 'miktex' in ((proc.stdout or '') + (proc.stderr or '')).lower()
    except Exception:
        result = 'miktex' in engine.lower()
    _MIKTEX_CACHE[engine] = result
    return result


def _engine_argv(engine, tex_name, workdir):
    name = engine_name(engine)
    if name == 'tectonic':
        return [engine, '--keep-logs', '--outdir', workdir, tex_name]

    argv = [engine,
            '-interaction=nonstopmode',
            '-halt-on-error',
            '-file-line-error',
            '-no-shell-escape',
            f'-output-directory={workdir}']
    # MiKTeX otherwise blocks on its package installer for any package the
    # generated document happens to use.
    if _is_miktex(engine):
        argv.insert(1, '--disable-installer')
    return argv + [tex_name]


# Lines that matter when a compile fails. LaTeX logs are enormous; the model
# only needs the errors and the source line they point at.
_ERROR_LINE = re.compile(
    r'^(?:!'
    r'|.*?:\d+:'
    r'|l\.\d+'
    r'|.*?\bUndefined control sequence\b'
    r'|.*?\bLaTeX Error\b'
    r'|.*?\bEmergency stop\b'
    r'|.*?\bRunaway argument\b'
    r'|.*?\bFile .*? not found\b)')


def extract_errors(log, max_lines=40):
    """
    Condense a TeX log into just the error-bearing lines.

    Sending a full log back to the model would be thousands of wasted tokens;
    the '!' lines plus their 'l.NNN' source context are what identify the fault.
    """
    if not log:
        return ''
    kept = []
    lines = log.splitlines()
    for i, line in enumerate(lines):
        if _ERROR_LINE.match(line.strip()):
            # TeX puts the offending source on the following lines.
            for context in lines[i:i + 3]:
                context = context.rstrip()
                if context and context not in kept:
                    kept.append(context)
        if len(kept) >= max_lines:
            break
    if not kept:
        # No recognisable error line (e.g. the engine died early) - fall back
        # to the tail of the log, where TeX reports fatal stops.
        kept = [l.rstrip() for l in lines[-max_lines:] if l.strip()]
    return '\n'.join(kept[:max_lines])


def missing_packages(log):
    """Package names the engine could not find, for a clear user-facing hint."""
    names = set()
    for match in re.finditer(r"File [`']([^'`]+)\.sty' not found", log or ''):
        names.add(match.group(1))
    return sorted(names)


def source_sha(tex):
    """Identity of a LaTeX source, used to match a cached PDF to its .tex."""
    return hashlib.sha256((tex or '').encode('utf-8')).hexdigest()


def compile_tex(tex, engine=None, timeout=None, want_pdf=False):
    """
    Compile LaTeX source in a throwaway directory.

    Returns a dict:
        {'attempted': bool, 'ok': bool, 'engine': str|None, 'errors': str,
         'missing_packages': [str], 'reason': str|None, 'pdf': bytes|None,
         'source_sha': str|None}

    With want_pdf=True the compiled PDF is read into memory before cleanup, so
    the preview can serve it and rasterise it without compiling again. The
    working directory is always deleted before returning, so an uploaded
    document never lingers on disk.

    `source_sha` identifies the source these bytes came from. A conversion
    compiles the document to validate it and the preview wants that same PDF
    rather than a second compile of the same source - but only if it really is
    the same source, and the pipeline may repair or merge a document after
    validating it. The hash is what lets the caller check instead of assume.
    """
    engine = engine or find_engine()
    if not engine:
        return {'attempted': False, 'ok': False, 'engine': None, 'errors': '',
                'missing_packages': [], 'pdf': None, 'source_sha': None,
                'reason': 'No LaTeX engine found on this server.'}

    # Refuse before the engine ever sees it. attempted=False because nothing
    # was run - this is the same shape as "no engine installed", and callers
    # already treat that as "no preview, the .tex is fine".
    unsafe = [] if _file_access_allowed() else unsafe_constructs(tex)
    if unsafe:
        return {'attempted': False, 'ok': False, 'engine': engine_name(engine),
                'errors': '', 'missing_packages': [], 'pdf': None,
                'source_sha': None,
                'reason': 'This document asks LaTeX to reach outside itself ('
                          + ', '.join(unsafe) + '), so it was not compiled. '
                          'The .tex file is unchanged and can still be '
                          'downloaded and compiled wherever you trust it.'}

    timeout = timeout or _COMPILE_TIMEOUT
    workdir = tempfile.mkdtemp(prefix='contex_tex_')
    try:
        tex_name = 'document.tex'
        with open(os.path.join(workdir, tex_name), 'w', encoding='utf-8') as fh:
            fh.write(tex)

        try:
            proc = subprocess.run(
                _engine_argv(engine, tex_name, workdir),
                cwd=workdir, capture_output=True, text=True,
                timeout=timeout, errors='replace', env=_compile_env(),
                # Nothing to type at: an engine that still finds a way to
                # prompt gets EOF and stops, instead of holding the request
                # open until the timeout.
                stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {'attempted': True, 'ok': False, 'engine': engine_name(engine),
                    'errors': '', 'missing_packages': [], 'pdf': None,
                    'source_sha': None,
                    'reason': f'Compilation timed out after {timeout}s.'}
        except OSError as exc:
            return {'attempted': True, 'ok': False, 'engine': engine_name(engine),
                    'errors': '', 'missing_packages': [], 'pdf': None,
                    'source_sha': None,
                    'reason': f'Could not run the LaTeX engine: {exc}'}

        log_path = os.path.join(workdir, 'document.log')
        log = ''
        if os.path.exists(log_path):
            with open(log_path, 'r', encoding='utf-8', errors='replace') as fh:
                log = fh.read()
        combined = log or (proc.stdout or '') + (proc.stderr or '')

        pdf_path = os.path.join(workdir, 'document.pdf')
        pdf_ok = os.path.exists(pdf_path)
        ok = proc.returncode == 0 and pdf_ok

        pdf_bytes = None
        if ok and want_pdf:
            with open(pdf_path, 'rb') as fh:
                pdf_bytes = fh.read()

        return {
            'attempted': True,
            'ok': ok,
            'engine': engine_name(engine),
            'errors': '' if ok else extract_errors(combined),
            'missing_packages': [] if ok else missing_packages(combined),
            'reason': None,
            'pdf': pdf_bytes,
            'source_sha': source_sha(tex) if pdf_bytes else None,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def render_pages(pdf_bytes, dpi=None):
    """
    Rasterise a compiled PDF into one PNG per page.

    Returns (pages, error): a list of PNG byte strings, and None; or an empty
    list and a sentence explaining why nothing could be rendered.

    The preview is shown as images because a browser will not reliably let a
    page display a PDF: Chromium hands an application/pdf response to its own
    viewer before script can read it, and a download manager extension will
    take it away entirely. An image is shown by every browser regardless.
    """
    if not pdf_bytes:
        return [], 'There is no compiled document to show.'

    try:
        from pdf2image import convert_from_bytes
    except ImportError:
        return [], ("Page images need 'pdf2image'. The PDF itself is fine and "
                    "can still be opened or downloaded.")

    try:
        images = convert_from_bytes(pdf_bytes, dpi=dpi or _PREVIEW_DPI)
    except Exception as exc:                       # pdf2image raises its own
        detail = str(exc).lower()
        if 'poppler' in detail or 'pdfinfo' in detail:
            return [], ('Page images need Poppler on PATH. The PDF itself is '
                        'fine and can still be opened or downloaded.')
        return [], f'The document could not be turned into page images: {exc}'

    pages = []
    for image in images:
        buffer = io.BytesIO()
        image.convert('RGB').save(buffer, format='PNG', optimize=True)
        pages.append(buffer.getvalue())
    return pages, None


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


