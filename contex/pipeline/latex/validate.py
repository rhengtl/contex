"""
Structural checking of LaTeX source, with no engine involved.

Two different questions live here, and both are answered by reading the text
rather than by compiling it:

  static_validate()     is this document well formed? Unbalanced braces,
                        environments that never close, stray math delimiters -
                        the mechanical faults, found for free and reported with
                        line numbers.

  unsafe_constructs()   does this document try to reach outside itself? See
                        the long note above it; the short version is that a
                        model transcribes what it is shown, so a photograph of
                        \\input{/etc/passwd} becomes that line.

Both run offline and cost nothing, which is why the pipeline can afford to
call them on every conversion.
"""

import re

# Environments whose body must not be scanned for braces / math delimiters,
# because inside them TeX special characters are literal text.
_VERBATIM_ENVS = ('verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt')


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
# Reaching outside the document
# ---------------------------------------------------------------------------
#
# THE THREAT. TeX is a programming language, and this app compiles LaTeX that
# ultimately came from a stranger. Nobody uploads a .tex file - but a model
# transcribes what it is shown, so an image of the line
#
#     \input{/etc/passwd}
#
# becomes that line in the generated document, and the compiled preview then
# shows the file's contents back to whoever uploaded the image. The same trick
# with \write reaches the filesystem, and \write18 reaches the shell.
#
# Measured before this guard existed: a canary string from an unrelated file
# on disk appeared in the rendered PDF.
#
# WHY IT IS CHECKED HERE rather than left to the engine. -no-shell-escape
# closes command execution but says nothing about \input, and kpathsea ships
# openin_any=a (read anything) on most TeX Live builds. engine.py does set
# kpathsea to paranoid mode, but MiKTeX - the usual Windows install, and what
# this project develops against - ignores those variables entirely. A check on
# the source text is the half that works everywhere.
#
# It is blunt on purpose, and that is affordable precisely here: this app
# generates self-contained documents, so a legitimate result never needs any
# of these. Refusing costs the preview, never the .tex.

#: Primitives that touch the filesystem or the shell. \read and \write are
#: matched as whole control words so that \writes or \readline in a package
#: name is not caught by accident; \write18 is listed first because it is the
#: shell one and deserves to be named in the message.
_UNSAFE_CONSTRUCTS = (
    (r'\\write\s*18\b', r'\write18 (runs shell commands)'),
    (r'\\(?:immediate\s*)?\\?openout\b', r'\openout (writes files)'),
    (r'\\openin\b', r'\openin (reads files)'),
    (r'\\read(?![a-zA-Z])', r'\read (reads files)'),
    (r'\\write(?![a-zA-Z0-9])', r'\write (writes files)'),
    (r'\\input\b', r'\input (reads another file)'),
    (r'\\include\b', r'\include (reads another file)'),
    (r'\\(?:Input|)IfFileExists\b', r'\IfFileExists (probes the filesystem)'),
    (r'\\directlua\b', r'\directlua (runs Lua)'),
    (r'\\latelua\b', r'\latelua (runs Lua)'),
    (r'\\ShellEscape\b', r'\ShellEscape (runs shell commands)'),
    (r'\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bshellesc\b',
     r'the shellesc package (runs shell commands)'),
    (r'\\catcode\s*`?\s*\\?\\\s*=', r'\catcode on the escape character'),
)

_UNSAFE_RE = [(re.compile(pattern), label)
              for pattern, label in _UNSAFE_CONSTRUCTS]


def unsafe_constructs(tex):
    """
    Names of the file/shell primitives in `tex`, or an empty list.

    Comments and verbatim bodies are stripped first, so a document that merely
    *shows* \\input as typeset example text is not refused for it - only one
    that would actually execute it.
    """
    if not tex:
        return []
    code = _strip_comments_and_verbatim(tex)
    found = []
    for pattern, label in _UNSAFE_RE:
        if pattern.search(code) and label not in found:
            found.append(label)
    return found


# Escape hatch for an operator who genuinely needs \input to work. Off by
# default: the safe setting has to be the one you get by doing nothing.
