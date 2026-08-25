# preprocess.py
"""
Image conditioning applied before any OCR engine sees a page.

This is the cheapest accuracy in the project: it costs no API calls and no
model time, and the benchmark in bench/ already measured what it is worth.
From bench/README.md, on the 10-degree skew set:

    Tesseract char accuracy   28.44%  ->  99.84%   after deskew

At the default page-segmentation mode a rotated page made Tesseract return an
empty string, so the user saw a blank result and no error at all. The
projection-profile deskew below is the same algorithm bench/deskew_test.py
validated, moved into the app and made fast enough for a web request.

Four steps, all no-ops when they are not needed:

  Flatten alpha - a transparent PNG (which is exactly what the Draw canvas
                  produces) turns black when converted to greyscale, because
                  PIL drops the alpha channel rather than compositing it.
  EXIF rotation - phone cameras store orientation as metadata, and a sideways
                  page defeats every OCR engine and every vision model.
  Deskew        - estimate the dominant text angle and rotate it flat.
  Upscale       - very low DPI is the other measured weak spot (87.52%,
                  0/10 exact); enlarging small inputs is the standard fix.
"""

import os

import numpy as np
from PIL import Image, ImageOps

# Below this the angle is noise, and rotating would only resample the image
# for nothing.
_MIN_CORRECTION_DEG = 0.35

# Estimation runs on a downscaled copy: the angle of a page does not change
# with resolution, and this keeps a full-page scan to well under a second.
#
# Measured: dropping this below 900 makes the estimate worse, not merely
# cheaper - at 600 the mean residual skew across the bench corpus rose from
# 0.38 to 0.42 degrees. The saving comes from searching fewer angles instead.
_ESTIMATE_MAX_EDGE = 900

# How far apart the first, coarse sweep places its candidates, and how many of
# its peaks are then examined closely. The refinement is on the real
# 0.5-degree grid, so these decide only how much of the range is skipped.
#
# Three peaks, not one: a blurred page's score curve has several local maxima,
# and following only the best coarse sample walked into the wrong one on 9 of
# 351 measured cases. Keeping the top three reproduces the exhaustive scan
# exactly on all 351. A finer sweep is not the answer either - 1-degree
# steps following one peak were both slower and wrong more often.
_COARSE_STEP = 2.0
_COARSE_PEAKS = 3

# Inputs smaller than this on the long edge are treated as low-DPI captures.
_MIN_USEFUL_EDGE = 1000
_MAX_UPSCALE = 2.0


def _to_gray_array(image):
    return np.asarray(image.convert('L'))


def estimate_skew(image, limit=15.0, step=0.5, coarse=_COARSE_STEP,
                  peaks=_COARSE_PEAKS):
    """
    Return the rotation, in degrees, that makes the page's text lines level.

    Works by rotating a binarised copy through candidate angles and scoring how
    sharply the horizontal ink-projection profile changes from row to row: when
    lines are level, rows are either all text or all whitespace, so the profile
    has steep edges. This is the algorithm from bench/deskew_test.py.

    Searched coarse-to-fine rather than one angle at a time. Scoring every
    candidate on the 0.5-degree grid means 61 rotations of a full page, which
    measured at ~700 ms and ran on every page of every conversion - the largest
    fixed cost in the pipeline outside the model call. Sweeping at 2 degrees
    and then refining the real grid around the three best samples needs 27, and
    every answer still comes from the same candidate set.

    Verified over 351 cases (39 bench images x 9 known skews): the angle is
    identical to the exhaustive scan in all 351. That is the bar this has to
    meet - deskewing is worth 28% to 99.8% character accuracy on a rotated
    page, so a cheaper search that is occasionally wrong would cost far more
    than the milliseconds it saves.
    """
    working = image
    if max(working.size) > _ESTIMATE_MAX_EDGE:
        working = working.copy()
        working.thumbnail((_ESTIMATE_MAX_EDGE, _ESTIMATE_MAX_EDGE),
                          Image.BILINEAR)

    ink = (_to_gray_array(working) < 128).astype(np.uint8) * 255
    if not ink.any():
        return 0.0  # blank page: nothing to align

    source = Image.fromarray(ink)
    scores = {}

    def score(angle):
        angle = round(float(angle), 6)
        if angle not in scores:
            rotated = np.asarray(source.rotate(
                angle, resample=Image.BILINEAR, fillcolor=0)) > 128
            profile = rotated.sum(axis=1).astype(np.float32)
            scores[angle] = float(((profile[1:] - profile[:-1]) ** 2).sum())
        return scores[angle]

    grid = [round(float(a), 6) for a in np.arange(-limit, limit + step, step)]
    if coarse <= step or peaks < 1:
        return max(grid, key=score)

    # Sweep the whole range coarsely, then refine on the full grid around the
    # strongest few samples - so the answer always comes from the same
    # candidate set the exhaustive scan would have chosen from.
    sparse = [a for a in grid
              if abs((a / coarse) - round(a / coarse)) < 1e-9] or grid
    best = sorted(sparse, key=score, reverse=True)[:peaks]
    near = {a for peak in best for a in grid if abs(a - peak) <= coarse}
    return max(near, key=score)


def deskew(image, limit=15.0):
    """
    Rotate a page flat. Returns (image, applied_angle).

    Straight pages are returned untouched - the estimator reports ~0 for them,
    and we skip the rotation entirely rather than resampling for no reason.
    """
    angle = estimate_skew(image, limit=limit)
    if abs(angle) < _MIN_CORRECTION_DEG:
        return image, 0.0
    fill = 255 if image.mode in ('L', '1') else (255, 255, 255)
    rotated = image.rotate(angle, resample=Image.BICUBIC, expand=True,
                           fillcolor=fill)
    return rotated, angle


#: EXIF tag 0x0112. Orientation 1 means "already the right way up".
_ORIENTATION_TAG = 0x0112


def apply_exif_rotation(image):
    """
    Honour the camera's orientation tag, if there is one.

    The tag is read first and the image returned untouched when there is
    nothing to do. ImageOps.exif_transpose() copies the image even when it
    changes nothing, which on a phone capture is tens of megabytes of pixels
    duplicated for no result - and it also destroys the one cheap way for a
    caller to tell whether conditioning changed anything at all.
    """
    try:
        orientation = image.getexif().get(_ORIENTATION_TAG)
        if not orientation or orientation == 1:
            return image
        return ImageOps.exif_transpose(image) or image
    except Exception:
        return image


def upscale_small(image, min_edge=_MIN_USEFUL_EDGE):
    """
    Enlarge very small captures so glyph strokes survive binarisation.

    Returns (image, factor). Capped so a thumbnail cannot be blown up into a
    huge blurry page.
    """
    longest = max(image.size)
    if longest >= min_edge:
        return image, 1.0
    factor = min(min_edge / longest, _MAX_UPSCALE)
    if factor <= 1.01:
        return image, 1.0
    new_size = (max(1, int(image.size[0] * factor)),
                max(1, int(image.size[1] * factor)))
    return image.resize(new_size, Image.LANCZOS), factor


def enabled():
    """Preprocessing can be switched off wholesale for debugging."""
    return os.getenv('OCR_PREPROCESS', 'true').lower() != 'false'


def flatten_alpha(image):
    """
    Composite a transparent image onto white.

    The Draw canvas clears to transparent and strokes in near-black, so its
    PNG is RGBA with an alpha-0 background. PIL's convert('L') discards alpha
    instead of compositing, which turns that background *black* - measured, the
    ink mask then flags 100% of pixels and segmentation collapses to a single
    band. Compositing first takes the same drawing to 0.4% ink and the correct
    band count.
    """
    if image.mode not in ('RGBA', 'LA', 'PA') and 'transparency' not in image.info:
        return image
    try:
        rgba = image.convert('RGBA')
        white = Image.new('RGB', rgba.size, (255, 255, 255))
        white.paste(rgba, mask=rgba.split()[-1])
        return white
    except Exception as exc:
        print(f"Warning: could not flatten transparency ({exc})")
        return image


def prepare_image(image, do_deskew=True, do_upscale=True):
    """
    Run the full conditioning chain on a PIL image.

    Returns (image, notes) where notes describes what was actually changed, so
    the caller can surface it or log it. Never raises: a preprocessing failure
    must not cost the user their OCR run.

    Every step returns the image it was given when it has nothing to do, so
    `result is image` is a reliable "nothing was changed" test. ai_qa relies on
    it to send a camera capture's original bytes to the model untouched rather
    than re-encoding a photo that conditioning did not alter.
    """
    notes = []
    # Flattening is not optional conditioning - without it a drawing is a black
    # rectangle to every engine - so it runs even when preprocessing is off.
    flattened = flatten_alpha(image)
    if flattened is not image:
        notes.append('Placed a transparent image on a white background.')
    image = flattened

    if not enabled():
        return image, notes

    try:
        rotated = apply_exif_rotation(image)
        if rotated is not image:
            notes.append('Applied the photo\'s EXIF orientation.')
        image = rotated

        if do_deskew:
            image, angle = deskew(image)
            if angle:
                notes.append(f'Deskewed by {angle:+.1f} degrees.')

        if do_upscale:
            image, factor = upscale_small(image)
            if factor > 1.0:
                notes.append(f'Upscaled a low-resolution image {factor:.1f}x.')
    except Exception as exc:
        print(f"Warning: preprocessing skipped ({exc})")

    return image, notes
