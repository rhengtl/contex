"""
Ground truth for Stage 2 parity, produced by the ORIGINAL implementation.

Runs contex/pipeline/latex/validate.py and engine.py over the same documents
the browser harness compiles, and writes the results as JSON. Nothing in
contex/ is modified -- this only imports it.

    python edge/tools/python-reference.py <out.json> <dir> [<dir> ...]
"""
import json
import os
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT)

from contex.pipeline.latex import validate as V   # noqa: E402
from contex.pipeline.latex import engine as E     # noqa: E402

out_path = sys.argv[1]
dirs = sys.argv[2:]

records = {}
for d in dirs:
    for name in sorted(os.listdir(d)):
        if not name.endswith('.tex'):
            continue
        with open(os.path.join(d, name), encoding='utf-8') as fh:
            tex = fh.read()
        key = os.path.splitext(name)[0]
        result = E.compile_tex(tex, want_pdf=True)
        records[key] = {
            'issues': V.static_validate(tex),
            'unsafe': V.unsafe_constructs(tex),
            'compile': {
                'attempted': result['attempted'],
                'ok': result['ok'],
                'missing_packages': result['missing_packages'],
                'reason': result['reason'],
                'pdf_bytes': len(result['pdf']) if result.get('pdf') else 0,
                'errors_head': (result['errors'] or '').split('\n')[0][:120],
            },
        }
        print(f"  {key:<34} issues={len(records[key]['issues']):<2} "
              f"unsafe={len(records[key]['unsafe'])} "
              f"ok={result['ok']} pdf={records[key]['compile']['pdf_bytes']}")

with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(records, fh, indent=2)
print(f"\n{len(records)} records -> {out_path}")
