"""
Derive the app's logo assets from the transparent master.

The master is 1024x1024 with the artwork occupying only the middle 447x445 -
44% padding on every side. Placed as-is in a 32px header slot the mark would
render about 14px of actual ink, so every derivative below is cropped to the
artwork's own bounding box plus a small, equal margin. Nothing is stretched,
recoloured beyond a flat monochrome swap, or otherwise altered in shape.
"""
import os

from PIL import Image, ImageChops, ImageDraw

# Paths are resolved from the project root rather than from the working
# directory, because this script now lives a directory down and would
# otherwise only work when run from exactly one place.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MASTER = os.path.join(ROOT, 'brand', 'contex-logo-transparent.png')
INK = (23, 28, 26)          # ink-900
LIGHT = (244, 241, 235)     # paper-100
PAPER = (251, 250, 248)     # paper-50

master = Image.open(MASTER).convert('RGBA')
box = master.split()[3].getbbox()

# A square crop centred on the artwork, sized to the larger axis plus 6% air,
# so the mark keeps its own proportions and sits optically centred.
cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
side = max(box[2] - box[0], box[3] - box[1]) * 1.12
half = side / 2
mark = master.crop((round(cx - half), round(cy - half),
                    round(cx + half), round(cy + half)))
print(f'master ink bbox {box} -> square crop {mark.size}')


def tint(image, rgb):
    """Recolour a flat monochrome mark, keeping its alpha exactly."""
    solid = Image.new('RGBA', image.size, rgb + (255,))
    solid.putalpha(image.split()[3])
    return solid


def save(image, path, size):
    out = image.resize((size, size), Image.LANCZOS)
    out.save(path, optimize=True, compress_level=9)
    # Reported relative to the project root: the absolute path is
    # noise, and the short form is what the README and the tests use.
    print(f'  {os.path.relpath(path, ROOT)}  {size}x{size}')


# 256, not the master's 512: the largest the mark is ever drawn is the 88px
# processing screen, so 256 covers even a 3x display, and 512 was costing
# ~48 KB for detail no screen resolves. Keep this here rather than trimming the
# files afterwards - a separate optimisation step gets undone the next time
# this script runs.
MARK = 256

# On light surfaces the mark is used exactly as drawn.
save(mark, os.path.join(ROOT, 'static', 'img') + '/contex-mark.png', MARK)

# On the dark surfaces (processing overlay, canvas toolbar, footer) the mark is
# reversed out: the artwork is a single flat colour, so this is the standard
# monochrome reverse, not a recolouring of a multi-colour logo.
save(tint(mark, LIGHT), os.path.join(ROOT, 'static', 'img') + '/contex-mark-light.png', MARK)

# Favicons need an opaque ground; a bare black mark disappears on a dark tab
# strip. Paper is the app's own background, so the tab icon matches the site.
def on_paper(size, pad=0.14):
    tile = Image.new('RGBA', (size, size), PAPER + (255,))
    inner = round(size * (1 - pad * 2))
    tile.alpha_composite(mark.resize((inner, inner), Image.LANCZOS),
                         ((size - inner) // 2, (size - inner) // 2))
    return tile


# Corner radius as a fraction of the icon's width, so every size rounds by the
# same proportion and the icon looks like one shape at 16px and at 48px.
#
# 3/16 was chosen because it lands on a whole pixel at every size the .ico
# ships - 3px at 16, 6px at 32, 9px at 48 - so no size pays for a half-pixel
# radius. It reads as clearly rounded without becoming the iOS squircle
# (~22.4%), which is a different shape and would fight the app's own 4-8px
# radii.
CORNER = 3 / 16

# The mask is drawn 4x oversized and then reduced, because a rounded rectangle
# drawn straight into a 16px bitmap has visibly stepped corners. Reducing a
# 64px draw gives the corner a real anti-aliased edge.
#
# Reduced with BOX rather than LANCZOS: on an exact integer reduction BOX is a
# plain area average, so a corner covering none of the source stays at 0.
# LANCZOS has negative lobes and rang slightly positive there, leaving every
# corner at alpha 3 - a faint pale speck at exactly the pixel meant to be gone.
#
# 4x and not more. It already ramps the arc properly - the corner of a 16px
# icon comes out 0 / 128 / 239 / 255 - and going higher only starts covering
# the outermost pixel itself (6/255 at 16x), which puts the speck back for
# accuracy no tab strip can show.
_MASK_SUPERSAMPLE = 4


def round_corners(tile, radius_fraction=CORNER):
    """Clip a square icon to a rounded square, leaving the corners transparent."""
    size = tile.size[0]
    big = size * _MASK_SUPERSAMPLE
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=round(big * radius_fraction),
        fill=255)
    mask = mask.resize((size, size), Image.BOX)

    out = tile.copy()
    # Multiplied into the existing alpha rather than replacing it, so any
    # transparency already in the tile survives: the corners are cut from
    # whatever was there instead of being painted over it.
    out.putalpha(ImageChops.multiply(out.split()[3], mask))
    return out


# iOS applies its own mask to a home-screen icon, so this one stays square and
# opaque: rounding it here would show as a light seam inside the system's
# rounding. Only the tab icon below is rounded.
on_paper(180).convert('RGB').save(os.path.join(ROOT, 'static', 'img') + '/apple-touch-icon.png', optimize=True)
print('  static/img/apple-touch-icon.png  180x180  (square - iOS masks it)')

round_corners(on_paper(32, pad=0.06)).save(
    os.path.join(ROOT, 'static', 'img') + '/favicon-32.png', optimize=True)
print(f'  static/img/favicon-32.png  32x32  radius {round(32 * CORNER)}px')

# Each size is drawn and rounded at its own resolution rather than letting the
# encoder shrink one 48px tile, so the 16px frame - the one a tab actually
# shows - gets a mask built for 16px.
frames = [round_corners(on_paper(n, pad=0.06)) for n in (48, 32, 16)]
frames[0].save(os.path.join(ROOT, 'static', 'img') + '/favicon.ico', append_images=frames[1:],
               sizes=[(48, 48), (32, 32), (16, 16)])
print('  static/img/favicon.ico  '
      + ', '.join(f'{n}px r{round(n * CORNER)}' for n in (48, 32, 16)))

# Social card: the mark on the app's paper ground, at the 1.91:1 ratio the
# link-preview crops to. No text, because compositing a wordmark here would
# mean shipping a font file to render it once.
card = Image.new('RGB', (1200, 630), PAPER)
inner = 300
card.paste(mark.resize((inner, inner), Image.LANCZOS),
           ((1200 - inner) // 2, (630 - inner) // 2),
           mark.resize((inner, inner), Image.LANCZOS))
card.save(os.path.join(ROOT, 'static', 'img') + '/og-card.png', optimize=True)
print('  static/img/og-card.png  1200x630')
