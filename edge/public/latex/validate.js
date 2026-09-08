/**
 * Structural checking of LaTeX source, with no engine involved.
 * A direct port of contex/pipeline/latex/validate.py.
 *
 * Two different questions live here, and both are answered by reading the text
 * rather than by compiling it:
 *
 *   staticValidate()     is this document well formed? Unbalanced braces,
 *                        environments that never close, stray math delimiters.
 *   unsafeConstructs()   does this document try to reach outside itself?
 *
 * WHY THIS RUNS IN THE BROWSER. Two reasons, and the second is the one that
 * decided it. Regex over a 100 KB document would blow the Worker's 10 ms CPU
 * budget; and the compile now happens on the client, so the check has to sit
 * next to the thing it guards.
 *
 * The threat is unchanged by moving. TeX is a programming language and this
 * app compiles LaTeX that ultimately came from a stranger: nobody uploads a
 * .tex, but a model transcribes what it is shown, so a photograph of the line
 * \input{/etc/passwd} becomes that line in the generated document. In the
 * Python app that read the server's filesystem; here it would read whatever
 * the package fetcher can reach. Refusing costs the preview, never the .tex.
 */

const VERBATIM_ENVS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt'];

/**
 * Return `tex` with comments and verbatim bodies blanked out, preserving line
 * structure so reported line numbers still match the original source.
 */
export function stripCommentsAndVerbatim(tex) {
  let out = tex;
  // Verbatim bodies first: their content is literal and must not be parsed
  // for braces or math delimiters.
  for (const env of VERBATIM_ENVS) {
    const re = new RegExp(
      `(\\\\begin\\{${env}\\*?\\})([\\s\\S]*?)(\\\\end\\{${env}\\*?\\})`, 'g');
    out = out.replace(re, (_m, head, body, tail) =>
      head + body.replace(/[^\n]/g, ' ') + tail);
  }

  const lines = [];
  for (const line of out.split('\n')) {
    const cleaned = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\' && i + 1 < line.length) {
        const nxt = line[i + 1];
        if (/[a-zA-Z]/.test(nxt)) {
          // A control word such as \begin - keep it, the environment and
          // skeleton checks need to see it.
          cleaned.push(line.slice(i, i + 2));
        } else {
          // An escaped special character such as \{ or \$ - blank it so it is
          // never counted as a delimiter.
          cleaned.push('  ');
        }
        i += 2;
        continue;
      }
      if (ch === '%') break;         // rest of the line is a comment
      cleaned.push(ch);
      i += 1;
    }
    lines.push(cleaned.join(''));
  }
  return lines.join('\n');
}

function checkBraces(code) {
  const issues = [];
  let lineNo = 1;
  const openedAt = [];
  for (const ch of code) {
    if (ch === '\n') lineNo += 1;
    else if (ch === '{') openedAt.push(lineNo);
    else if (ch === '}') {
      if (!openedAt.length) issues.push(`Unmatched closing brace '}' on line ${lineNo}.`);
      else openedAt.pop();
    }
  }
  for (const ln of openedAt) issues.push(`Unclosed opening brace '{' from line ${ln}.`);
  return issues;
}

function checkEnvironments(code) {
  const issues = [];
  const stack = [];
  for (const m of code.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    const kind = m[1];
    const env = m[2].trim();
    const lineNo = code.slice(0, m.index).split('\n').length;
    if (kind === 'begin') stack.push([env, lineNo]);
    else if (!stack.length) {
      issues.push(`\\end{${env}} on line ${lineNo} has no matching \\begin.`);
    } else if (stack[stack.length - 1][0] !== env) {
      const [openEnv, openLine] = stack.pop();
      issues.push(`\\begin{${openEnv}} (line ${openLine}) is closed by ` +
                  `\\end{${env}} (line ${lineNo}).`);
    } else stack.pop();
  }
  for (const [env, lineNo] of stack) {
    issues.push(`\\begin{${env}} on line ${lineNo} is never closed.`);
  }
  return issues;
}

function checkMathDelimiters(code) {
  const issues = [];
  let toggles = 0;
  let firstOpenLine = null;
  let lineNo = 1;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\n') { lineNo += 1; i += 1; continue; }
    if (ch === '$') {
      const step = code.slice(i, i + 2) === '$$' ? 2 : 1;
      toggles += 1;
      if (toggles % 2 === 1) firstOpenLine = lineNo;
      i += step;
      continue;
    }
    i += 1;
  }
  if (toggles % 2 === 1) {
    issues.push("Odd number of '$' math delimiters - math opened near line " +
                `${firstOpenLine} is never closed.`);
  }

  const count = (re) => (code.match(re) || []).length;
  for (const [opener, closer, label] of [
    [/\\\[/g, /\\\]/g, '\\[ ... \\]'],
    [/\\\(/g, /\\\)/g, '\\( ... \\)'],
  ]) {
    const nOpen = count(opener);
    const nClose = count(closer);
    if (nOpen !== nClose) {
      issues.push(`Unbalanced ${label} math delimiters: ${nOpen} opening vs ` +
                  `${nClose} closing.`);
    }
  }

  const nLeft = count(/\\left(?![a-zA-Z])/g);
  const nRight = count(/\\right(?![a-zA-Z])/g);
  if (nLeft !== nRight) {
    issues.push(`Unbalanced \\left / \\right: ${nLeft} \\left vs ${nRight} \\right.`);
  }
  return issues;
}

function checkDocumentSkeleton(code) {
  const issues = [];
  if (!/\\documentclass/.test(code)) {
    issues.push('Missing \\documentclass - the file is not a complete document.');
  }
  if (!/\\begin\s*\{document\}/.test(code)) issues.push('Missing \\begin{document}.');
  if (!/\\end\s*\{document\}/.test(code)) issues.push('Missing \\end{document}.');
  return issues;
}

/** Human-readable issue strings; empty means it looks sane. */
export function staticValidate(tex) {
  if (!tex || !tex.trim()) return ['The generated LaTeX is empty.'];
  const code = stripCommentsAndVerbatim(tex);
  return [
    ...checkDocumentSkeleton(code),
    ...checkBraces(code),
    ...checkEnvironments(code),
    ...checkMathDelimiters(code),
  ];
}

// ---------------------------------------------------------------------------
// Reaching outside the document
// ---------------------------------------------------------------------------
//
// Blunt on purpose, and affordable precisely here: this app generates
// self-contained documents, so a legitimate result never needs any of these.

// WHY (?![a-zA-Z]) AND NOT \b. A control word ends where a non-letter starts,
// and a digit is a non-letter to TeX -- but \b is a word boundary, and to a
// regex a digit is a word character. So \b does not match between the 'n' of
// \openin and the '1' of \openin1=secret.txt, which is the ORDINARY way to
// write it, because TeX stream numbers are digits.
//
// Found during the Stage 2 port and fixed in validate.py as well, so the two
// implementations agree again. It matters more here: engine.py had a second
// layer in kpathsea's paranoid mode, and pdftex.wasm has no equivalent, so
// this text check is the only layer the browser has.
const UNSAFE_CONSTRUCTS = [
  [/\\write\s*18\b/, '\\write18 (runs shell commands)'],
  [/\\(?:immediate\s*)?\\?openout(?![a-zA-Z])/, '\\openout (writes files)'],
  [/\\openin(?![a-zA-Z])/, '\\openin (reads files)'],
  [/\\read(?![a-zA-Z])/, '\\read (reads files)'],
  [/\\write(?![a-zA-Z0-9])/, '\\write (writes files)'],
  [/\\input(?![a-zA-Z])/, '\\input (reads another file)'],
  [/\\include(?![a-zA-Z])/, '\\include (reads another file)'],
  [/\\(?:Input|)IfFileExists\b/, '\\IfFileExists (probes the filesystem)'],
  [/\\directlua(?![a-zA-Z])/, '\\directlua (runs Lua)'],
  [/\\latelua(?![a-zA-Z])/, '\\latelua (runs Lua)'],
  // pdfTeX's own file primitives. Each takes a filename directly -- no
  // \openin, no stream number -- and \pdffiledump typesets the file's bytes
  // into the output as hex. Measured against the Python engine on MiKTeX with
  // openin_any=p: a canary file outside the working directory was read and
  // rendered into the PDF.
  //
  // pdftex.wasm has no host filesystem to reach, so here the blast radius is
  // whatever the package fetcher can pull from our own origin. That is much
  // smaller, and it is still not a thing a generated document ever needs.
  [/\\pdffiledump(?![a-zA-Z])/, '\\pdffiledump (reads files)'],
  [/\\pdffilesize(?![a-zA-Z])/, '\\pdffilesize (probes the filesystem)'],
  [/\\pdffilemoddate(?![a-zA-Z])/, '\\pdffilemoddate (probes the filesystem)'],
  [/\\pdfmdfivesum(?![a-zA-Z])/, '\\pdfmdfivesum (reads files)'],
  [/\\pdfximage(?![a-zA-Z])/, '\\pdfximage (reads another file)'],
  [/\\pdfobj(?![a-zA-Z])/, '\\pdfobj (can embed a file)'],
  [/\\ShellEscape\b/, '\\ShellEscape (runs shell commands)'],
  [/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bshellesc\b/,
   'the shellesc package (runs shell commands)'],
  [/\\catcode\s*`?\s*\\?\\\s*=/, '\\catcode on the escape character'],
];

/**
 * Names of the file/shell primitives in `tex`, or an empty array.
 * Comments and verbatim bodies are stripped first, so a document that merely
 * *shows* \input as typeset example text is not refused for it.
 */
export function unsafeConstructs(tex) {
  if (!tex) return [];
  const code = stripCommentsAndVerbatim(tex);
  const found = [];
  for (const [pattern, label] of UNSAFE_CONSTRUCTS) {
    if (pattern.test(code) && !found.includes(label)) found.push(label);
  }
  return found;
}
