// Failure-case documents for Stage 2. Real ConTeX benchmark outputs cover the
// happy path; these cover the paths a user actually hits when something is
// wrong, which is where the original's behaviour is easiest to lose.
import { mkdir, writeFile } from 'node:fs/promises';

const DIR = 'tests/fixtures';
await mkdir(DIR, { recursive: true });

const head = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
`;
const tail = String.raw`
\end{document}
`;

const FIXTURES = {
  // structurally sound
  'valid-plain': head + String.raw`Ordinary prose with $x^2$ inline math.` + tail,

  // staticValidate() should catch each of these
  'unbalanced-braces': head + String.raw`A \textbf{bold run that never closes.` + tail,
  'missing-end-document': head + 'This document simply stops.\n',
  'unclosed-environment': head + String.raw`\begin{itemize}\item one` + tail,
  'mismatched-environment':
    head + String.raw`\begin{itemize}\item one\end{enumerate}` + tail,
  'odd-dollar': head + String.raw`An opening $x + y that never closes.` + tail,
  'unbalanced-left-right': head + String.raw`\[ \left( x + y \]` + tail,
  empty: '',

  // unsafeConstructs() should refuse these before the engine runs
  'unsafe-input': head + String.raw`\input{/etc/passwd}` + tail,
  'unsafe-write18': head + String.raw`\write18{ls -la}` + tail,
  'unsafe-openin': head + String.raw`\openin1=secret.txt` + tail,

  // ...and must NOT refuse these: the primitive is shown, not executed
  'verbatim-shows-input': head + String.raw`\begin{verbatim}
\input{/etc/passwd}
\end{verbatim}` + tail,
  'comment-shows-input': head + String.raw`% \input{/etc/passwd} is only a comment
Prose.` + tail,

  // engine-level failures
  'missing-package': String.raw`\documentclass{article}
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}` + tail,
  'undefined-command': head + String.raw`\thisCommandDoesNotExist{x}` + tail,
};

for (const [name, body] of Object.entries(FIXTURES)) {
  await writeFile(`${DIR}/${name}.tex`, body);
}
console.log(`${Object.keys(FIXTURES).length} fixtures -> ${DIR}`);
