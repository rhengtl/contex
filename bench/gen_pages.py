"""Render full LaTeX pages with exact ground truth.

The existing corpora measure one thing each: gen_text.py renders sentences,
gen_math.py renders isolated formulas. Neither measures a whole page and its
*structure*, which is what score_qa.py needs.

The trick here is that the ground truth is the source. We write a .tex file,
compile it, and rasterise the PDF; whatever a converter produces from that
image should say the same thing as the .tex we started from. That gives exact
structural ground truth - headings, tables, lists, display math - which cannot
be obtained by annotating scans by hand.

Requires a LaTeX engine (the same one the app compiles with) and Poppler.

    python gen_pages.py            # writes img_pages/ and manifest_pages.json
"""

import json
import os
import sys

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(BENCH))  # the app package lives one level up

import latex_tools  # noqa: E402

IMG = os.path.join(BENCH, 'img_pages')

_PREAMBLE = r"""\documentclass[11pt]{article}
\usepackage[margin=2.2cm]{geometry}
\usepackage{amsmath}
\pagestyle{empty}
"""

# Each page exercises a different structural feature the pipeline has to get
# right. Keep them short: one page each, so a rasterised page stays legible at
# a sensible resolution.
PAGES = [
    ('headings', r"""
\section{Introduction}
Signal processing turns measurements into meaning.

\subsection{Motivation}
Sampling a continuous signal produces a discrete sequence.

\subsection{Scope}
This note covers the transform and its inverse.

\section{Method}
The derivation proceeds in three steps.
"""),
    ('display_math', r"""
\section{Transforms}
The Fourier transform of $f$ is
\begin{equation}
F(\omega) = \int_{-\infty}^{\infty} f(t) e^{-i \omega t} \, dt .
\end{equation}
Its inverse recovers the original signal:
\begin{equation}
f(t) = \frac{1}{2\pi} \int_{-\infty}^{\infty} F(\omega) e^{i \omega t} \, d\omega .
\end{equation}
"""),
    ('fractions_indices', r"""
\section{Estimators}
The sample variance is
\[
s^{2} = \frac{1}{n-1} \sum_{i=1}^{n} \left( x_{i} - \bar{x} \right)^{2},
\]
where $\bar{x}$ is the sample mean. The standard error is $s / \sqrt{n}$,
and the coefficient of variation is $s / \bar{x}$.
"""),
    ('matrix', r"""
\section{Linear systems}
Consider the system $A\mathbf{x} = \mathbf{b}$ with
\[
A = \begin{pmatrix} 2 & -1 & 0 \\ -1 & 2 & -1 \\ 0 & -1 & 2 \end{pmatrix},
\qquad
\mathbf{b} = \begin{pmatrix} 1 \\ 0 \\ 1 \end{pmatrix}.
\]
The matrix $A$ is symmetric and positive definite.
"""),
    ('table', r"""
\section{Results}
\begin{center}
\begin{tabular}{lrr}
\hline
Condition & Accuracy & Samples \\
\hline
Clean print & 99.9 & 61 \\
Blurred & 99.8 & 10 \\
Low DPI & 87.5 & 10 \\
\hline
\end{tabular}
\end{center}
Accuracy is reported as a percentage of characters.
"""),
    ('lists', r"""
\section{Procedure}
\begin{enumerate}
\item Normalise the input image.
\item Extract the document structure.
\item Assemble the LaTeX source.
\end{enumerate}

Known limitations:
\begin{itemize}
\item No handwriting in the corpus.
\item English only.
\end{itemize}
"""),
    ('mixed', r"""
\section{Energy}
Einstein's mass--energy relation is $E = mc^{2}$, and the Lorentz factor is
$\gamma = 1 / \sqrt{1 - v^{2}/c^{2}}$.

\subsection{Limits}
\[
\lim_{x \to 0} \frac{\sin x}{x} = 1,
\qquad
\frac{\partial u}{\partial t} = \alpha \nabla^{2} u .
\]

\begin{enumerate}
\item State the assumption.
\item Take the limit.
\end{enumerate}
"""),
    ('cases_align', r"""
\section{Piecewise definitions}
\[
H(x) = \begin{cases}
0 & \text{if } x < 0, \\
1 & \text{if } x \geq 0 .
\end{cases}
\]
\begin{align}
(a+b)^{2} &= a^{2} + 2ab + b^{2} \\
(a-b)^{2} &= a^{2} - 2ab + b^{2}
\end{align}
"""),
]


def build():
    engine = latex_tools.find_engine()
    if not engine:
        print('No LaTeX engine found; cannot render pages.')
        return 1
    try:
        from pdf2image import convert_from_bytes
    except ImportError:
        print('pdf2image is required (and Poppler on PATH).')
        return 1

    os.makedirs(IMG, exist_ok=True)
    manifest = []

    for name, body in PAGES:
        source = _PREAMBLE + '\\begin{document}\n' + body.strip() + '\n\\end{document}\n'
        result = latex_tools.compile_tex(source, want_pdf=True)
        if not result['ok']:
            print(f"  {name}: FAILED to compile - {result['errors'][:200]}")
            continue

        for dpi, quality in ((160, 'hi'), (100, 'lo')):
            pages = convert_from_bytes(result['pdf'], dpi=dpi, fmt='png')
            file_name = f'{name}_{quality}.png'
            pages[0].save(os.path.join(IMG, file_name))
            manifest.append({
                'file': file_name,
                'cond': quality,
                'feature': name,
                'gt_tex': source,
            })
        print(f'  {name}: ok')

    with open(os.path.join(BENCH, 'manifest_pages.json'), 'w',
              encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=1)
    print(f'Wrote {len(manifest)} page images to {IMG}')
    return 0


if __name__ == '__main__':
    sys.exit(build())
