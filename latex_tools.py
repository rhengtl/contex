# latex_tools.py
"""
Local (non-AI) LaTeX validation and compilation.

Used by the QA layer to check whatever the reviewer hands back, and by
bench/gen_pages.py to build its corpus. It knows nothing about any AI: it takes
LaTeX source, says what is structurally wrong with it, and - when a TeX engine
is installed - compiles it and reports the engine's own errors in a compact form.

Everything here runs offline, so it costs no API tokens.
"""

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


# ---------------------------------------------------------------------------
# Engine discovery
# ---------------------------------------------------------------------------

def find_engine():
    """
    Return the path to a usable TeX engine, or None if none is installed.

    LATEX_CMD pins an explicit engine; otherwise the first of pdflatex,
    xelatex, lualatex or tectonic found on PATH wins. Compilation is optional
    by design - the pipeline still returns a .tex file when no engine exists.
    """
    explicit = os.getenv('LATEX_CMD')
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


def compile_tex(tex, engine=None, timeout=None, want_pdf=False):
    """
    Compile LaTeX source in a throwaway directory.

    Returns a dict:
        {'attempted': bool, 'ok': bool, 'engine': str|None, 'errors': str,
         'missing_packages': [str], 'reason': str|None, 'pdf': bytes|None}

    With want_pdf=True the compiled PDF is read into memory before cleanup, so
    the visual-verification stage can render it back to images. The working
    directory is always deleted before returning, so an uploaded document never
    lingers on disk.
    """
    engine = engine or find_engine()
    if not engine:
        return {'attempted': False, 'ok': False, 'engine': None, 'errors': '',
                'missing_packages': [], 'pdf': None,
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
                    'reason': f'Compilation timed out after {timeout}s.'}
        except OSError as exc:
            return {'attempted': True, 'ok': False, 'engine': engine_name(engine),
                    'errors': '', 'missing_packages': [], 'pdf': None,
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
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
