"""
What the Python pipeline's local fallback produces, for tests/fallback.mjs to
be measured against.

WHY A REFERENCE FILE AND NOT A NUMBER IN THE SUITE. The browser fallback and
contex/pipeline/run.py are meant to be the same converter: the same Tesseract
(compiled to WebAssembly), the same eng.traineddata (tools/build-models.mjs
copies the one this machine has installed), the same pix2text-mfr weights, and
the same layout analysis. A hard-coded expectation would only say the port
still scores what it scored the day it was written. This says whether the two
implementations still agree, which is the question worth asking on every change
to either of them.

Run it from the repository root, with the Python app's virtualenv active:

    python edge/tools/fallback-reference.py

It writes .contex-fallback-ref.json next to the other reference files. The
suite skips its comparison group when that file is absent, so this is optional
-- but a run without it is measuring the browser against nothing.
"""

import contextlib
import io
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'bench'))

from PIL import Image                                       # noqa: E402
from contex.pipeline import run                             # noqa: E402
from score_qa import text_score, structure_score, math_score  # noqa: E402

CORPUS = os.path.join(ROOT, 'bench', 'img_mixed')
MANIFEST = os.path.join(ROOT, 'bench', 'manifest_mixed.json')
OUT = os.path.join(ROOT, '.contex-fallback-ref.json')


def main():
    with open(MANIFEST, encoding='utf-8') as handle:
        manifest = json.load(handle)

    rows = []
    for entry in manifest:
        image = Image.open(os.path.join(CORPUS, entry['file']))
        # _local_document prints its own notices; they are not the measurement.
        with contextlib.redirect_stdout(io.StringIO()):
            tex, equations, _items, _notes = run._local_document([image])
        rows.append({
            'file': entry['file'],
            'feature': entry['feature'],
            'text': text_score(entry['gt_tex'], tex),
            'structure': structure_score(entry['gt_tex'], tex),
            'math': math_score(entry['gt_tex'], tex),
            'equations': [item['latex'] for item in equations],
            'tex': tex,
        })
        row = rows[-1]
        fmt = lambda v: '    n/a' if v is None else f'{v * 100:6.2f}%'  # noqa: E731
        print(f"{entry['file']:<28} text {fmt(row['text'])}  "
              f"structure {fmt(row['structure'])}  math {fmt(row['math'])}",
              flush=True)

    with open(OUT, 'w', encoding='utf-8') as handle:
        json.dump(rows, handle, indent=1)
    print(f'\nwrote {OUT}')


if __name__ == '__main__':
    main()
