"""Measure what the AI QA layer adds to each converter.

The question this answers is not "is the AI good at OCR" - the AI does no OCR
here. It is: **does reviewing the converter's output against the original page
make the result better, worse, or no different?** So every page is scored twice,
before and after the review, and the difference is the number that matters.

Two modes:

    --mode direct     AI-first: the model reads the page itself, no local
                      converters at all. Only the "after" column is meaningful.
    --mode unified    Both converters merged by position, then review_page().
                      Corpus: img_pages/ - this is the one that measures the
                      shipped pipeline, so it is the default.
    --mode textract   Tesseract -> .tex, then review_document()
                      Corpus: img_pages/ - whole rendered pages, ground truth
                      is the .tex they were rendered from.
    --mode equations  pix2text  -> [eq, ...], then review_equations()
                      Corpus: img_math/ - isolated formulas, ground truth is
                      the expression itself. Deliberately NOT the page corpus:
                      the reviewer is supposed to discard prose the segmenter
                      mistook for mathematics, and scoring that against a full
                      page would count doing so as a loss.
                      (loads the ONNX model, so it is slower to start)

Three metrics, because character accuracy alone would be misleading - the
reviewer is allowed to write different LaTeX as long as it says the same thing:

    text        character accuracy of the prose, LaTeX markup stripped
    structure   how many of the source's sections/lists/tables/display-math
                elements are present
    compiles    whether the .tex actually builds

Usage, from bench/:

    python gen_pages.py                    # build the corpus first
    python score_qa.py --mock              # check the harness, no API calls
    python score_qa.py --limit 4           # cheap sample of the real thing
    python score_qa.py --mode equations
    python score_qa.py --provider anthropic
"""

import argparse
import json
import os
import re
import sys
import time

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(BENCH))  # the app package lives one level up
sys.path.insert(0, BENCH)

from score_math import lev, normalize  # reuse the existing LaTeX normaliser
import ai_qa  # noqa: E402
import latex_tools  # noqa: E402
import textract_fast  # noqa: E402

_STRUCTURE = {
    'section': r'\\section\b',
    'subsection': r'\\subsection\b',
    'enumerate': r'\\begin\{enumerate\}',
    'itemize': r'\\begin\{itemize\}',
    'item': r'\\item\b',
    'tabular': r'\\begin\{tabular\}',
    'matrix': r'\\begin\{[pbv]?matrix\}',
    'cases': r'\\begin\{cases\}',
    'align': r'\\begin\{align',
    'equation': r'\\begin\{equation',
    'frac': r'\\frac\b',
    'sum': r'\\sum\b',
    'int': r'\\int\b',
    'sqrt': r'\\sqrt\b',
}

_MATH_PATTERNS = (
    r'\$\$(.+?)\$\$', r'\$(.+?)\$', r'\\\[(.+?)\\\]',
    r'\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?)\}(.+?)'
    r'\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?)\}',
)


def body_of(tex):
    match = re.search(r'\\begin\{document\}(.*?)\\end\{document\}', tex or '',
                      re.DOTALL)
    return match.group(1) if match else (tex or '')


def plain_text(tex):
    """The prose a reader would see, with markup and mathematics removed."""
    body = body_of(tex)
    body = re.sub(r'\\begin\{.*?\}|\\end\{.*?\}', ' ', body)
    for pattern in _MATH_PATTERNS:
        body = re.sub(pattern, ' ', body, flags=re.DOTALL)
    body = re.sub(r'\\[a-zA-Z@]+\*?', ' ', body)     # commands
    body = re.sub(r'[{}$&\\~^_#]', ' ', body)        # leftover syntax
    body = re.sub(r'%.*', ' ', body)                 # comments
    return ' '.join(body.split()).lower()


def text_score(gt_tex, pred_tex):
    gt, pred = plain_text(gt_tex), plain_text(pred_tex)
    if not gt:
        return None
    return max(0.0, 1 - lev(gt, pred) / len(gt))


def structure_score(gt_tex, pred_tex):
    gt_body, pred_body = body_of(gt_tex), body_of(pred_tex)
    gt = {n: len(re.findall(p, gt_body)) for n, p in _STRUCTURE.items()}
    pred = {n: len(re.findall(p, pred_body)) for n, p in _STRUCTURE.items()}
    total = sum(gt.values())
    if not total:
        return None
    return sum(min(gt[n], pred[n]) for n in gt) / total


def math_score(gt_tex, pred_tex):
    """Pairwise character accuracy over the page's mathematics."""
    def expressions(tex):
        body = body_of(tex)
        found = []
        for pattern in _MATH_PATTERNS:
            for match in re.findall(pattern, body, re.DOTALL):
                expression = normalize(match)
                if expression:
                    found.append(expression)
        return found

    gt, pred = expressions(gt_tex), expressions(pred_tex)
    if not gt:
        return None
    remaining = list(pred)
    errors = chars = 0
    for expression in gt:
        chars += len(expression)
        if not remaining:
            errors += len(expression)
            continue
        best_index, best_cost = 0, None
        for index, candidate in enumerate(remaining):
            cost = lev(expression, candidate)
            if best_cost is None or cost < best_cost:
                best_index, best_cost = index, cost
        errors += best_cost
        remaining.pop(best_index)
    return max(0.0, 1 - errors / chars) if chars else 1.0


def _fmt(value):
    return f'{value:>7.2%}' if value is not None else '    n/a'


def _delta(before, after):
    if before is None or after is None:
        return '       '
    change = after - before
    if abs(change) < 0.0005:
        return '     ='
    return f'{change:+7.2%}'


def run_direct(path, file_name, mock):
    """
    AI-first: the model reads the page itself, no converter draft at all.

    The "before" column is empty by construction - there is no local output to
    score - so only the "after" numbers mean anything in this mode. That is
    itself the point: with nothing to fall back on, a failed call is a failed
    conversion.
    """
    with open(path, 'rb') as handle:
        data = handle.read()
    if mock:
        return '', '', {'status': 'mock'}
    result = ai_qa.convert_page(data, file_name)
    return '', result['tex'], result


def run_unified(path, file_name, mock):
    """Both converters merged by position, then one review."""
    import convert
    with open(path, 'rb') as handle:
        data = handle.read()
    built = convert.convert(data, file_name, review=not mock)
    review = built['qa']
    review['detected'] = len(built['equations'])
    return built['raw_tex'], built['tex'], review


def run_textract(path, file_name, mock):
    """Raw Tesseract .tex, then the reviewed one."""
    text = textract_fast.extract_text_from_file(path)
    raw = textract_fast.generate_tex_source(text)
    if mock:
        return raw, raw, {'status': 'mock'}
    with open(path, 'rb') as handle:
        review = ai_qa.review_document(handle.read(), file_name, raw)
    return raw, review['tex'], review


def run_equations(path, file_name, mock):
    """Raw equation list laid out plainly, then the reviewed .tex."""
    import equation
    with open(path, 'rb') as handle:
        data = handle.read()
    detected = equation.process_image_list(data)
    raw = ai_qa.equations_to_tex(detected)
    if mock:
        return raw, raw, {'status': 'mock', 'detected': len(detected)}
    review = ai_qa.review_equations(data, file_name, detected)
    review['detected'] = len(detected)
    return raw, review['tex'], review


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',
                        choices=('unified', 'direct', 'textract', 'equations'),
                        default='unified')
    parser.add_argument('--corpus', choices=('pages', 'mixed', 'math'),
                        default='pages',
                        help="'pages' = rendered LaTeX pages (printed only); "
                             "'mixed' = handwritten and typewritten prose and "
                             "mathematics in every combination. Ignored in "
                             "equations mode, which has its own corpus.")
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--cond', default=None, help='only this condition (hi/lo)')
    parser.add_argument('--provider', default=None,
                        help='gemini or anthropic (default: configured)')
    parser.add_argument('--model', default=None,
                        help='override the model for this run (both pipelines); '
                             'omit to use the per-pipeline default')
    parser.add_argument('--mock', action='store_true',
                        help='no API calls; scores the converter alone')
    # The free tier limits requests per MINUTE, not just per day, and a
    # benchmark is the one workload that reliably trips it: a run with no pause
    # lost 8 of 8 pages to 429s. The app itself makes 1-3 calls per conversion
    # and never sees this.
    parser.add_argument('--sleep', type=float, default=12.0,
                        help='seconds to pause between pages (default 12, to '
                             'stay under the free tier per-minute limit); '
                             '0 to disable')
    parser.add_argument('--out', default=None)
    args = parser.parse_args(argv)

    # Each mode gets the corpus whose ground truth actually answers its
    # question. Scoring equation output against a whole *page* would punish the
    # reviewer for correctly discarding prose the segmenter mistook for an
    # expression - so equations are measured on isolated formulas instead,
    # where the ground truth is the formula itself.
    if args.mode == 'equations' or args.corpus == 'math':
        name, folder, generator = 'manifest_math.json', 'img_math', 'gen_math.py'
    elif args.corpus == 'mixed':
        name, folder, generator = 'manifest_mixed.json', 'img_mixed', 'gen_mixed.py'
    else:
        name, folder, generator = 'manifest_pages.json', 'img_pages', 'gen_pages.py'

    manifest_path = os.path.join(BENCH, name)
    if not os.path.exists(manifest_path):
        print(f'No {name} - run: python {generator}')
        return 1
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle)

    # The math corpus stores a bare expression; wrap it so the same scorers
    # apply to both corpora.
    for row in manifest:
        if 'gt_tex' not in row:
            row['gt_tex'] = '\\[' + row['gt'] + '\\]'
            row.setdefault('feature', row['cond'])

    if args.cond:
        manifest = [row for row in manifest if row['cond'] == args.cond]
    if args.limit:
        manifest = manifest[:args.limit]

    if args.model:
        os.environ['AI_QA_MODEL'] = args.model
    if args.provider:
        os.environ['AI_QA_PROVIDER'] = args.provider

    if not args.mock:
        if not ai_qa.enabled():
            print('AI QA is not configured - set GEMINI_API_KEY (or use --mock).')
            return 1
        info = ai_qa.provider_info()
        # Each pipeline runs its own model, so report the one this mode uses.
        role = ('equations' if args.mode == 'equations' else 'document')
        print(f"reviewer: {info['name']}   "
              f"model: {args.model or info['models'][role]}   "
              f"role: {role}")
    print(f"mode: {args.mode}   pages: {len(manifest)}\n")

    runner = {'unified': run_unified, 'direct': run_direct,
              'textract': run_textract, 'equations': run_equations}[args.mode]
    header = f"  {'page':<26}{'text':>9}{'':>8}{'structure':>11}{'':>8}{'math':>9}{'':>8}  compiles"
    print(header)

    rows = []
    totals = {k: [0.0, 0] for k in ('text_b', 'text_a', 'struct_b', 'struct_a',
                                    'math_b', 'math_a')}
    compiles = {'before': 0, 'after': 0}
    failures = 0
    started = time.time()

    for index, row in enumerate(manifest):
        if index and args.sleep and not args.mock:
            time.sleep(args.sleep)
        path = os.path.join(BENCH, folder, row['file'])
        try:
            raw, reviewed, review = runner(path, row['file'], args.mock)
        except Exception as exc:
            print(f"  {row['file']:<26} FAILED: {exc}")
            failures += 1
            continue

        scores = {}
        for label, tex in (('b', raw), ('a', reviewed)):
            scores[f'text_{label}'] = text_score(row['gt_tex'], tex)
            scores[f'struct_{label}'] = structure_score(row['gt_tex'], tex)
            scores[f'math_{label}'] = math_score(row['gt_tex'], tex)
        for key, value in scores.items():
            if value is not None:
                totals[key][0] += value
                totals[key][1] += 1

        compiles['before'] += bool(latex_tools.compile_tex(raw)['ok'])
        after_ok = bool(latex_tools.compile_tex(reviewed)['ok'])
        compiles['after'] += after_ok

        print(f"  {row['file']:<26}"
              f"{_fmt(scores['text_b'])}{_delta(scores['text_b'], scores['text_a'])}"
              f"{_fmt(scores['struct_b']):>11}{_delta(scores['struct_b'], scores['struct_a'])}"
              f"{_fmt(scores['math_b'])}{_delta(scores['math_b'], scores['math_a'])}"
              f"  {'yes' if after_ok else 'no'}   {review.get('status', '')}")

        rows.append({'file': row['file'], 'feature': row['feature'],
                     'cond': row['cond'], 'scores': scores,
                     'qa_status': review.get('status')})

    print()
    print(f"  {'':<26}{'before':>9}{'after':>9}")
    for label, before, after in (('text', 'text_b', 'text_a'),
                                 ('structure', 'struct_b', 'struct_a'),
                                 ('math', 'math_b', 'math_a')):
        if totals[before][1]:
            b = totals[before][0] / totals[before][1]
            a = totals[after][0] / totals[after][1]
            print(f"  {label:<26}{b:>9.2%}{a:>9.2%}   ({a - b:+.2%})")
    scored = len(manifest) - failures
    print(f"  {'compiles':<26}{compiles['before']:>9}{compiles['after']:>9}"
          f"   of {scored}")
    print(f"  {'failed':<26}{failures:>9}")
    print(f"  elapsed {time.time() - started:.1f}s")

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as handle:
            json.dump({'mode': args.mode, 'rows': rows}, handle, indent=1)
        print(f'wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
