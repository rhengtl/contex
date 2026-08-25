# latex_tools.py
"""
Local (non-AI) LaTeX validation and compilation.

Used by the QA layer to check whatever the reviewer hands back, and by
bench/gen_pages.py to build its corpus. It knows nothing about any AI: it takes
LaTeX source, says what is structurally wrong with it, and - when a TeX engine
is installed - compiles it and reports the engine's own errors in a compact form.

Everything here runs offline, so it costs no API tokens.
"""

import hashlib
import io
import os
import re
import shutil
import subprocess
import tempfile

# Environments whose body must not be scanned for braces / math delimiters,
# because inside them TeX special characters are literal text.
_VERBATIM_ENVS = ('verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt')

# Engines we know how to drive, in preference order.
_ENGINE_CANDIDATES = ('pdflatex', 'xelatex', 'lualatex', 'tectonic')

# A compile must never hang a web request.
_COMPILE_TIMEOUT = int(os.getenv('LATEX_COMPILE_TIMEOUT', '120'))

# Resolution for the preview page images. High enough that the small text in a
# rendered document stays legible when the page is scaled to the panel width,
# low enough that a long document does not turn into megabytes of PNG.
_PREVIEW_DPI = int(os.getenv('PREVIEW_DPI', '110'))


# ---------------------------------------------------------------------------
# Engine discovery
# ---------------------------------------------------------------------------

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

def _strip_comments_and_verbatim(tex):
    """
    Return `tex` with comments and verbatim bodies blanked out, preserving
    line structure so reported line numbers still match the original source.
    """
    def blank_body(match):
        head, body, tail = match.group(1), match.group(2), match.group(3)
        return head + re.sub(r'[^\n]', ' ', body) + tail

    # Verbatim bodies first: their content is literal and must not be parsed
    # for braces or math delimiters.
    for env in _VERBATIM_ENVS:
        tex = re.sub(
            r'(\\begin\{' + env + r'\*?\})(.*?)(\\end\{' + env + r'\*?\})',
            blank_body, tex, flags=re.DOTALL)

    out = []
    for line in tex.split('\n'):
        cleaned = []
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == '\\' and i + 1 < len(line):
                nxt = line[i + 1]
                if nxt.isalpha():
                    # A control word such as \begin - keep it, the environment
                    # and skeleton checks need to see it.
                    cleaned.append(line[i:i + 2])
                else:
                    # An escaped special character such as \{ or \$ or \% -
                    # blank it so it is never counted as a delimiter.
                    cleaned.append('  ')
                i += 2
                continue
            if ch == '%':
                break  # rest of the line is a comment
            cleaned.append(ch)
            i += 1
        out.append(''.join(cleaned))
    return '\n'.join(out)


def _check_braces(code):
    issues = []
    line_no = 1
    opened_at = []
    for ch in code:
        if ch == '\n':
            line_no += 1
        elif ch == '{':
            opened_at.append(line_no)
        elif ch == '}':
            if not opened_at:
                issues.append(f"Unmatched closing brace '}}' on line {line_no}.")
            else:
                opened_at.pop()
    for ln in opened_at:
        issues.append(f"Unclosed opening brace '{{' from line {ln}.")
    return issues


def _check_environments(code):
    issues = []
    stack = []
    for match in re.finditer(r'\\(begin|end)\s*\{([^}]*)\}', code):
        kind, env = match.group(1), match.group(2).strip()
        line_no = code.count('\n', 0, match.start()) + 1
        if kind == 'begin':
            stack.append((env, line_no))
        elif not stack:
            issues.append(
                f"\\end{{{env}}} on line {line_no} has no matching \\begin.")
        elif stack[-1][0] != env:
            open_env, open_line = stack.pop()
            issues.append(
                f"\\begin{{{open_env}}} (line {open_line}) is closed by "
                f"\\end{{{env}}} (line {line_no}).")
        else:
            stack.pop()
    for env, line_no in stack:
        issues.append(f"\\begin{{{env}}} on line {line_no} is never closed.")
    return issues


def _check_math_delimiters(code):
    issues = []
    # Inline/display '$' toggles. '$$' counts as a single delimiter.
    toggles = 0
    first_open_line = None
    line_no = 1
    i = 0
    while i < len(code):
        ch = code[i]
        if ch == '\n':
            line_no += 1
            i += 1
            continue
        if ch == '$':
            step = 2 if code[i:i + 2] == '$$' else 1
            toggles += 1
            if toggles % 2 == 1:
                first_open_line = line_no
            i += step
            continue
        i += 1
    if toggles % 2 == 1:
        issues.append(
            f"Odd number of '$' math delimiters - math opened near line "
            f"{first_open_line} is never closed.")

    for opener, closer, label in ((r'\\\[', r'\\\]', r'\[ ... \]'),
                                  (r'\\\(', r'\\\)', r'\( ... \)')):
        n_open = len(re.findall(opener, code))
        n_close = len(re.findall(closer, code))
        if n_open != n_close:
            issues.append(
                f"Unbalanced {label} math delimiters: {n_open} opening vs "
                f"{n_close} closing.")

    n_left = len(re.findall(r'\\left(?![a-zA-Z])', code))
    n_right = len(re.findall(r'\\right(?![a-zA-Z])', code))
    if n_left != n_right:
        issues.append(
            f"Unbalanced \\left / \\right: {n_left} \\left vs {n_right} \\right.")
    return issues


def _check_document_skeleton(code):
    issues = []
    if not re.search(r'\\documentclass', code):
        issues.append(
            "Missing \\documentclass - the file is not a complete document.")
    if not re.search(r'\\begin\s*\{document\}', code):
        issues.append("Missing \\begin{document}.")
    if not re.search(r'\\end\s*\{document\}', code):
        issues.append("Missing \\end{document}.")
    return issues


def static_validate(tex):
    """
    Check LaTeX source for structural problems without invoking an engine.

    Returns a list of human-readable issue strings (empty means it looks sane).
    These are the mechanical faults the pipeline must catch - missing braces,
    broken environments, missing \\begin/\\end pairs - found for free.
    """
    if not tex or not tex.strip():
        return ["The generated LaTeX is empty."]

    code = _strip_comments_and_verbatim(tex)
    issues = []
    issues += _check_document_skeleton(code)
    issues += _check_braces(code)
    issues += _check_environments(code)
    issues += _check_math_delimiters(code)
    return issues


# ---------------------------------------------------------------------------
# Compilation
# ---------------------------------------------------------------------------

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
    the visual-verification stage can render it back to images. The working
    directory is always deleted before returning, so an uploaded document never
    lingers on disk.

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
                timeout=timeout, errors='replace')
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
    an equation.
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

    Converting a multi-page PDF one page at a time is what lets a conversion
    survive losing the AI half way through: the pages already done keep their
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
