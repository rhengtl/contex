"""
Build static/css/app.css from static/css/tailwind.src.css.

    python build_css.py

Two steps, and the second one is the reason this is a script rather than a
single npx invocation.

1. Tailwind generates the stylesheet. Deliberately NOT --minify: the minifier
   rewrites colours into whichever notation is shortest, and hsla() does not
   round-trip every value in this palette exactly - text-cream-100/70 came back
   a step lighter. Colour fidelity is not worth trading for bytes in an app
   whose whole subject is reproducing a document faithfully.

2. Comments are removed from the OUTPUT only. The source carries a long
   explanation of the design system, the measured contrast ratios and the font
   metrics, and all of it was being shipped to every visitor: 15 KB of the
   built file, 5.2 KB of it after gzip, which is most of the difference between
   this stylesheet and the much smaller one it replaced.

   This is a strictly textual removal of /* ... */ runs. It does not touch a
   colour, a unit, a selector or a declaration order, so it cannot do what
   --minify did. Run with --verify to prove that on the live pages.
"""
import gzip
import os
import re
import subprocess
import sys

SRC = os.path.join('static', 'css', 'tailwind.src.css')
OUT = os.path.join('static', 'css', 'app.css')


def _kb(count):
    return f'{count:,} B'


def build():
    result = subprocess.run(
        ['npx', '--yes', 'tailwindcss@3', '-i', SRC, '-o', OUT],
        capture_output=True, text=True, shell=(os.name == 'nt'))
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit('tailwind build failed')

    with open(OUT, encoding='utf-8') as handle:
        generated = handle.read()

    # A CSS comment cannot appear inside a string or a url() in this
    # stylesheet - there are no content: strings carrying "/*" and no data:
    # URIs - so a plain non-greedy sweep is exact here.
    stripped = re.sub(r'/\*.*?\*/', '', generated, flags=re.S)
    stripped = re.sub(r'\n[ \t]*\n[ \t]*\n+', '\n\n', stripped).strip() + '\n'

    with open(OUT, 'w', encoding='utf-8') as handle:
        handle.write(stripped)

    # The sizes on disk, not the lengths of the strings: this runs on Windows,
    # where text mode writes CRLF, so the two differ by a few thousand bytes.
    with open(OUT, 'rb') as handle:
        on_disk = handle.read()
    print(f'{OUT}')
    print(f'  generated {_kb(len(generated))} of CSS'
          f'  ->  {_kb(len(on_disk))} on disk'
          f'  ({_kb(len(generated) - len(stripped))} of comments removed)')
    print(f'  gzip {_kb(len(gzip.compress(on_disk, 9)))}')

    # Nothing but comments may differ.
    if re.sub(r'/\*.*?\*/', '', generated, flags=re.S).replace(' ', '').replace('\n', '') \
            != stripped.replace(' ', '').replace('\n', ''):
        raise SystemExit('the strip changed more than comments - refusing')
    return stripped


if __name__ == '__main__':
    build()
