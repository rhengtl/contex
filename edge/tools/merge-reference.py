"""
Ground truth for the multi-page merge, produced by the ORIGINAL implementation.

Runs contex/pipeline/latex/documents.py over a set of page groups and writes
both the inputs and the merged output as JSON, so the browser port is compared
against real bytes rather than against a re-description of the rules. Nothing
in contex/ is modified -- this only imports it.

The groups are the behaviours tests/test_contex.py pins (title de-duplication,
one output page per source page, a background that must not outlive its page,
a macro definition that must) plus real ConTeX benchmark output merged in
pairs and triples, because the synthetic pages are short and tidy in a way
model output is not.

    python edge/tools/merge-reference.py <out.json> <corpus-dir>
"""
import json
import os
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT)

from contex.pipeline.latex import documents as D   # noqa: E402
from contex.pipeline.latex import validate as V    # noqa: E402

out_path = sys.argv[1]
corpus_dir = sys.argv[2]


def page(marker):
    """One page of LaTeX as a converter hands it back: a short, whole document."""
    return ('\\documentclass{article}\n\\begin{document}\n'
            + marker + '\n\\end{document}\n')


def coloured(marker, in_preamble=True):
    """A page the model saw as dark: light text on a coloured background."""
    style = '\\pagecolor{blue}\n\\color{white}\n'
    return ('\\documentclass{article}\n\\usepackage{xcolor}\n'
            + (style if in_preamble else '')
            + '\\begin{document}\n'
            + ('' if in_preamble else style)
            + '\\Huge ' + marker + '\n\\end{document}\n')


def plain(marker):
    return ('\\documentclass{article}\n\\usepackage{xcolor}\n'
            '\\begin{document}\n\\Huge ' + marker + '\n\\end{document}\n')


groups = {
    'empty-list': [],
    'blank-only': ['', '   \n'],
    'single-page': [page('ONLYPAGE')],
    'single-untouched': ['\\documentclass{article}\n\\begin{document}\n'
                         'Hi.\n\\end{document}'],
    'title-deduplicated': [
        ('\\documentclass{article}\n\\usepackage{amsmath}\n'
         '\\title{Notes}\n\\begin{document}\n\\maketitle\nPage one.\n'
         '\\end{document}'),
        ('\\documentclass{article}\n\\usepackage{amsmath}\n'
         '\\usepackage{amssymb}\n\\begin{document}\nPage two.\n'
         '\\end{document}'),
    ],
    'three-pages': [page('ALPHAPAGE'), page('BRAVOPAGE'), page('CHARLIEPAGE')],
    'background-in-preamble': [coloured('PAGEONE', True), plain('PAGETWO'),
                               plain('PAGETHREE')],
    'background-in-body': [coloured('PAGEONE', False), plain('PAGETWO'),
                           plain('PAGETHREE')],
    'macro-definition-survives': [
        ('\\documentclass{article}\n\\begin{document}\n'
         '\\newcommand{\\mymark}{DEFINEDMARK}\n\\mymark\n\\end{document}\n'),
        ('\\documentclass{article}\n\\begin{document}\n'
         'Later page says \\mymark\n\\end{document}\n'),
    ],
    'bare-body-no-document-env': [
        '\\documentclass{article}\n\\begin{document}\nReal page.\n\\end{document}\n',
        '$E = mc^{2}$',
    ],
    'title-in-body-only': [
        ('\\documentclass{article}\n\\begin{document}\n\\title{T}\n'
         '\\maketitle\nOne.\n\\end{document}\n'),
        ('\\documentclass{article}\n\\begin{document}\n\\title{T}\n'
         '\\maketitle\nTwo.\n\\end{document}\n'),
    ],
    'whitespace-varied-duplicate-packages': [
        ('\\documentclass{article}\n\\usepackage{amsmath}\n'
         '\\begin{document}\nOne.\n\\end{document}\n'),
        ('\\documentclass{article}\n\\usepackage{amsmath}   \n'
         '\\begin{document}\nTwo.\n\\end{document}\n'),
    ],
}

# Real model output, merged the way a multi-page PDF would be.
corpus = sorted(f for f in os.listdir(corpus_dir) if f.endswith('.tex'))
loaded = {}
for name in corpus:
    with open(os.path.join(corpus_dir, name), encoding='utf-8') as fh:
        loaded[name] = fh.read()

for size in (2, 3):
    for start in range(0, len(corpus) - size + 1, size):
        names = corpus[start:start + size]
        key = f'corpus-{size}-' + '+'.join(n[:-4] for n in names)
        groups[key] = [loaded[n] for n in names]

records = {}
for key, inputs in groups.items():
    merged = D.merge_documents(inputs)
    records[key] = {
        'inputs': inputs,
        'merged': merged,
        # A merge that produces a document the validator rejects is a merge
        # bug, so the answer is pinned here too.
        'issues': V.static_validate(merged) if merged else [],
    }
    print(f'  {key:<58} pages={len(inputs)} -> {len(merged)} chars '
          f'issues={len(records[key]["issues"])}')

with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(records, fh, indent=2)
print(f'\n{len(records)} merge groups -> {out_path}')
