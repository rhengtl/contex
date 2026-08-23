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

Three steps, all no-ops when they are not needed:

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
_ESTIMATE_MAX_EDGE = 900

# Inputs smaller than this on the long edge are treated as low-DPI captures.
_MIN_USEFUL_EDGE = 1000
_MAX_UPSCALE = 2.0


def _to_gray_array(image):
    return np.asarray(image.convert('L'))


def estimate_skew(image, limit=15.0, step=0.5):
    """
    Return the rotation, in degrees, that makes the page's text lines level.

    Works by rotating a binarised copy through candidate angles and scoring how
    sharply the horizontal ink-projection profile changes from row to row: when
    lines are level, rows are either all text or all whitespace, so the profile
    has steep edges. This is the algorithm from bench/deskew_test.py.
    """
    working = image
    if max(working.size) > _ESTIMATE_MAX_EDGE:
        working = working.copy()
        working.thumbnail((_ESTIMATE_MAX_EDGE, _ESTIMATE_MAX_EDGE),
                          Image.BILINEAR)

    ink = (_to_gray_array(working) < 128).astype(np.uint8) * 255
    if not ink.any():
        return 0.0  # blank page: nothing to align

    best_angle, best_score = 0.0, -1.0
    source = Image.fromarray(ink)
    for angle in np.arange(-limit, limit + step, step):
        rotated = np.asarray(source.rotate(
            float(angle), resample=Image.BILINEAR, fillcolor=0)) > 128
        profile = rotated.sum(axis=1).astype(np.float32)
        score = float(((profile[1:] - profile[:-1]) ** 2).sum())
        if score > best_score:
            best_angle, best_score = float(angle), score
    return best_angle


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


def apply_exif_rotation(image):
    """Honour the camera's orientation tag, if there is one."""
    try:
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


def prepare_image(image, do_deskew=True, do_upscale=True):
    """
    Run the full conditioning chain on a PIL image.

    Returns (image, notes) where notes describes what was actually changed, so
    the caller can surface it or log it. Never raises: a preprocessing failure
    must not cost the user their OCR run.
    """
    notes = []
    if not enabled():
        return image, notes

    try:
        rotated = apply_exif_rotation(image)
        if rotated is not image and rotated.size != image.size:
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
