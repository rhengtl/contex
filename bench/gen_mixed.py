"""Render pages that mix handwritten and typewritten prose and mathematics.

The existing corpora are all machine-set LaTeX, which is the easy case. This
one covers the matrix the converter actually has to handle:

                    handwritten        typewritten
    prose               yes                yes
    equations           yes                yes

and every combination of the two axes on one page.

"Handwriting" here is a handwriting *font* - Segoe Script and Lucida
Handwriting for cursive prose, Ink Free for printed-style hand lettering. That
is a proxy, not the real thing: real handwriting is more varied, and a font
never runs two letters together the way a pen does. It is good enough to test
what this corpus is for - whether the pipeline routes, segments and orders the
content correctly - and deliberately not good enough to quote as a handwriting
accuracy figure.

Mathematics is drawn glyph by glyph rather than as a text string, so that
superscripts, subscripts and fraction bars are really raised, lowered and drawn
- writing "E = mc^2" with a literal caret would be testing something the source
document never contains.

    python gen_mixed.py        # writes img_mixed/ and manifest_mixed.json
"""

import json
import os

from PIL import Image, ImageDraw, ImageFont

BENCH = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(BENCH, 'img_mixed')

FONTS = {
    # Typewritten
    'serif': 'C:/Windows/Fonts/times.ttf',
    'serif_italic': 'C:/Windows/Fonts/timesi.ttf',
    # Handwritten
    'hand': 'C:/Windows/Fonts/Inkfree.ttf',
    'cursive': 'C:/Windows/Fonts/segoesc.ttf',
}

_LINE_GAP = 34
_MARGIN = 90


def _font(name, size):
    return ImageFont.truetype(FONTS[name], size)


def _draw_math(draw, x, y, parts, font_name, size, measure_only=False):
    """
    Draw an expression as positioned glyphs, or just measure its width.

    `parts` is a list of (text, role) where role is 'base', 'sup', 'sub' or
    'frac'. A 'frac' part is (numerator, denominator). Returns the width used.
    Centring needs the width before drawing, hence `measure_only`.
    """
    cursor = x
    small = _font(font_name, int(size * 0.62))
    base = _font(font_name, size)

    def put(position, text, font):
        if not measure_only:
            draw.text(position, text, fill=(20, 20, 20), font=font)

    for part in parts:
        role = part[1]
        if role == 'frac':
            numerator, denominator = part[0]
            n_width = draw.textlength(numerator, font=small)
            d_width = draw.textlength(denominator, font=small)
            width = max(n_width, d_width)
            put((cursor + (width - n_width) / 2, y - size * 0.18),
                numerator, small)
            bar_y = y + size * 0.42
            if not measure_only:
                draw.line((cursor, bar_y, cursor + width, bar_y),
                          fill=(20, 20, 20), width=max(2, size // 22))
            put((cursor + (width - d_width) / 2, y + size * 0.48),
                denominator, small)
            cursor += width + size * 0.16
        elif role == 'sup':
            put((cursor, y - size * 0.22), part[0], small)
            cursor += draw.textlength(part[0], font=small) + size * 0.05
        elif role == 'sub':
            put((cursor, y + size * 0.42), part[0], small)
            cursor += draw.textlength(part[0], font=small) + size * 0.05
        else:
            put((cursor, y), part[0], base)
            cursor += draw.textlength(part[0], font=base)
    return cursor - x


def render(blocks, width=1500):
    """blocks = [('text'|'math', content, font_name, size)] laid out top to bottom."""
    height = _MARGIN * 2 + sum(block[3] + _LINE_GAP for block in blocks)
    image = Image.new('RGB', (width, int(height)), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    y = _MARGIN
    for kind, content, font_name, size in blocks:
        if kind == 'math':
            used = _draw_math(draw, 0, 0, content, font_name, size,
                              measure_only=True)
            _draw_math(draw, (width - used) / 2, y, content, font_name, size)
        else:
            draw.text((_MARGIN, y), content, fill=(20, 20, 20),
                      font=_font(font_name, size))
        y += size + _LINE_GAP
    return image


# Expression builders, so the same maths can be set in either hand.
E_MC2 = [('E = mc', 'base'), ('2', 'sup')]
PYTHAG = [('a', 'base'), ('2', 'sup'), (' + b', 'base'), ('2', 'sup'),
          (' = c', 'base'), ('2', 'sup')]
VELOCITY = [('v = u + at', 'base')]
DISPLACE = [('s = ut + ', 'base'), (('1', '2'), 'frac'), ('at', 'base'),
            ('2', 'sup')]
KINETIC = [('E', 'base'), ('k', 'sub'), (' = ', 'base'), (('1', '2'), 'frac'),
           ('mv', 'base'), ('2', 'sup')]

PAGES = [
    ('hand_prose', 'Handwritten prose only', [
        ('text', 'The energy of a particle depends on its mass.', 'cursive', 46),
        ('text', 'This idea changed how physics was understood.', 'cursive', 46),
        ('text', 'We explore the consequences below.', 'cursive', 46),
    ], ['prose:hand']),

    ('print_prose', 'Typewritten prose only', [
        ('text', 'The energy of a particle depends on its mass.', 'serif', 42),
        ('text', 'This idea changed how physics was understood.', 'serif', 42),
        ('text', 'We explore the consequences below.', 'serif', 42),
    ], ['prose:print']),

    ('hand_math', 'Handwritten equations only', [
        ('math', E_MC2, 'hand', 62),
        ('math', PYTHAG, 'hand', 62),
    ], ['math:hand']),

    ('print_math', 'Typewritten equations only', [
        ('math', E_MC2, 'serif_italic', 58),
        ('math', PYTHAG, 'serif_italic', 58),
    ], ['math:print']),

    ('hand_prose_hand_math', 'Handwritten prose with handwritten equations', [
        ('text', 'The energy of a particle is given by', 'cursive', 46),
        ('math', E_MC2, 'hand', 62),
        ('text', 'where c is the speed of light in vacuum.', 'cursive', 46),
    ], ['prose:hand', 'math:hand']),

    ('print_prose_print_math', 'Typewritten prose with typewritten equations', [
        ('text', 'The energy of a particle is given by', 'serif', 42),
        ('math', E_MC2, 'serif_italic', 58),
        ('text', 'where c is the speed of light in vacuum.', 'serif', 42),
    ], ['prose:print', 'math:print']),

    ('hand_prose_print_math', 'Handwritten prose with a typewritten equation', [
        ('text', 'The energy of a particle is given by', 'cursive', 46),
        ('math', E_MC2, 'serif_italic', 58),
        ('text', 'where c is the speed of light in vacuum.', 'cursive', 46),
    ], ['prose:hand', 'math:print']),

    ('print_prose_hand_math', 'Typewritten prose with a handwritten equation', [
        ('text', 'The energy of a particle is given by', 'serif', 42),
        ('math', E_MC2, 'hand', 62),
        ('text', 'where c is the speed of light in vacuum.', 'serif', 42),
    ], ['prose:print', 'math:hand']),

    ('all_mixed', 'Handwritten and typewritten prose and equations together', [
        ('text', 'We begin with the printed definition of velocity.', 'serif', 42),
        ('math', VELOCITY, 'serif_italic', 56),
        ('text', 'Then the displacement follows by integration.', 'cursive', 44),
        ('math', DISPLACE, 'hand', 60),
        ('text', 'Finally the kinetic energy is written as', 'serif', 42),
        ('math', KINETIC, 'hand', 60),
    ], ['prose:print', 'prose:hand', 'math:print', 'math:hand']),

    ('related_math', 'Related equations with surrounding prose', [
        ('text', 'The kinematic equations describe uniform acceleration.',
         'serif', 42),
        ('math', VELOCITY, 'hand', 58),
        ('text', 'The second follows from integrating the first.', 'cursive', 44),
        ('math', DISPLACE, 'hand', 58),
        ('text', 'Both assume the acceleration a is constant.', 'serif', 42),
    ], ['prose:print', 'prose:hand', 'math:hand', 'related']),
]

# What the page actually says, for scoring. Prose is exact; mathematics is the
# expression, normalised the way bench/score_math.py normalises.
TRUTH = {
    'hand_prose': ('The energy of a particle depends on its mass. This idea '
                   'changed how physics was understood. We explore the '
                   'consequences below.', []),
    'print_prose': ('The energy of a particle depends on its mass. This idea '
                    'changed how physics was understood. We explore the '
                    'consequences below.', []),
    'hand_math': ('', ['E = mc^{2}', 'a^{2} + b^{2} = c^{2}']),
    'print_math': ('', ['E = mc^{2}', 'a^{2} + b^{2} = c^{2}']),
    'hand_prose_hand_math': ('The energy of a particle is given by where c is '
                             'the speed of light in vacuum.', ['E = mc^{2}']),
    'print_prose_print_math': ('The energy of a particle is given by where c is '
                               'the speed of light in vacuum.', ['E = mc^{2}']),
    'hand_prose_print_math': ('The energy of a particle is given by where c is '
                              'the speed of light in vacuum.', ['E = mc^{2}']),
    'print_prose_hand_math': ('The energy of a particle is given by where c is '
                              'the speed of light in vacuum.', ['E = mc^{2}']),
    'all_mixed': ('We begin with the printed definition of velocity. Then the '
                  'displacement follows by integration. Finally the kinetic '
                  'energy is written as',
                  ['v = u + at', 's = ut + \\frac{1}{2}at^{2}',
                   'E_{k} = \\frac{1}{2}mv^{2}']),
    'related_math': ('The kinematic equations describe uniform acceleration. '
                     'The second follows from integrating the first. Both '
                     'assume the acceleration a is constant.',
                     ['v = u + at', 's = ut + \\frac{1}{2}at^{2}']),
}


def build():
    os.makedirs(IMG, exist_ok=True)
    manifest = []
    for name, description, blocks, tags in PAGES:
        image = render(blocks)
        file_name = f'{name}.png'
        image.save(os.path.join(IMG, file_name))
        prose, maths = TRUTH[name]
        # A gt_tex as well, so bench/score_qa.py can score this corpus with the
        # same text/structure/math metrics it uses on the others.
        body = prose
        for expression in maths:
            body += '\n\\[\n' + expression + '\n\\]\n'
        gt_tex = ('\\documentclass{article}\n\\usepackage{amsmath}\n'
                  '\\begin{document}\n' + body + '\n\\end{document}\n')
        manifest.append({
            'file': file_name, 'cond': 'mixed', 'feature': name,
            'description': description, 'tags': tags,
            'gt_prose': prose, 'gt_math': maths, 'gt_tex': gt_tex,
        })
        print(f'  {name}: {image.size[0]}x{image.size[1]}  [{", ".join(tags)}]')

    with open(os.path.join(BENCH, 'manifest_mixed.json'), 'w',
              encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=1)
    print(f'Wrote {len(manifest)} pages to {IMG}')
    return 0


if __name__ == '__main__':
    raise SystemExit(build())
