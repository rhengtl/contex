"""
Formula recognition: breezedeus/pix2text-mfr (TrOCR) on ONNX Runtime.

Part of the local fallback, used when the AI is unavailable. run.py calls
segment_boxes() to find the formula regions on a page, then tighten() and
recognize() to read each one; assemble.py places the results back where their
boxes sat.
"""

import io
import os

import numpy as np
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq

from contex.pipeline import preprocess

# Load model and processor once.
#
# Failing here is not fatal and is not always a fault. Every caller goes
# through is_model_loaded() first, and the fallback simply does its prose half
# without its mathematics half. The verification suite reaches this branch on
# purpose - it binds TrOCRProcessor and ORTModelForVision2Seq to None so the
# module can be imported without fetching several hundred MB of weights - so
# the wording has to read as a degradation rather than a crash.
try:
    print("Loading formula recognition model...")
    processor = TrOCRProcessor.from_pretrained('breezedeus/pix2text-mfr')
    model = ORTModelForVision2Seq.from_pretrained('breezedeus/pix2text-mfr', use_cache=False)
    print("Formula recognition ready.")
except Exception as e:
    print(f"Notice: formula recognition unavailable ({e}). "
          "The fallback will convert text only.")
    processor = None
    model = None

def is_model_loaded():
    return model is not None and processor is not None

def _recognize(image):
    """Run the model on one already-cropped formula image."""
    pixel_values = processor(images=image.convert('RGB'),
                             return_tensors="pt").pixel_values
    generated_ids = model.generate(pixel_values)
    decoded = processor.batch_decode(generated_ids, skip_special_tokens=True)
    return decoded[0].strip() if decoded and decoded[0] else ''


def process_image(file_bytes):
    """
    Recognise a single formula image. Unchanged behaviour, kept for callers
    (and the benchmark in bench/) that expect exactly one string back.
    """
    if not is_model_loaded():
        raise RuntimeError("OCR model not loaded")

    img = Image.open(io.BytesIO(file_bytes)).convert('RGB')
    return _recognize(img) or '[No text recognized]'


# ---------------------------------------------------------------------------
# Multiple equations on one page
# ---------------------------------------------------------------------------
#
# pix2text-mfr recognises a formula; it does not find formulas on a page. So
# when a page holds several equations we segment it first and recognise each
# region on its own. Each equation is then reported separately, in reading
# order, instead of the model being handed a whole page and asked to produce
# one expression from it - which is where the unreliable output came from.

# A region shorter than this is noise (a speck, an underline, a stray mark).
_MIN_REGION_HEIGHT = 12

# Ink coverage below this means the band is not a formula.
_MIN_INK_RATIO = 0.002

# Padding kept around each crop so glyph ascenders/descenders are not clipped.
_CROP_PADDING = 8


def _ink_mask(image):
    """Boolean array, True where there is ink, robust to grey scans."""
    grey = np.asarray(image.convert('L'), dtype=np.float32)
    # Otsu-style split between page and ink, with a floor so a blank page does
    # not turn into all-ink.
    threshold = max(min(grey.mean() - grey.std(), 200.0), 60.0)
    return grey < threshold


def _bands(mask, merge_gap):
    """Contiguous rows of ink, merging bands separated by only a small gap."""
    rows = mask.any(axis=1)
    bands = []
    start = None
    for index, has_ink in enumerate(rows):
        if has_ink and start is None:
            start = index
        elif not has_ink and start is not None:
            bands.append([start, index])
            start = None
    if start is not None:
        bands.append([start, len(rows)])

    if not bands:
        return []

    # A fraction is three separate ink rows (numerator, bar, denominator) with
    # tiny gaps between them; two equations are separated by a full line space.
    # Merging on a gap threshold derived from band height keeps a fraction in
    # one piece while still splitting the equations apart.
    merged = [bands[0]]
    for top, bottom in bands[1:]:
        if top - merged[-1][1] < merge_gap:
            merged[-1][1] = bottom
        else:
            merged.append([top, bottom])
    return merged


def segment_boxes(image, max_regions=None, allow_empty=False):
    """
    Find candidate regions and return their **coordinates**, top to bottom.

    Returns a list of (left, top, right, bottom) boxes in the coordinate space
    of `image`. These boxes are the join key the unified pipeline needs: they
    are what lets an equation be placed back into the text flow at the position
    it actually occupied on the page.

    `allow_empty` distinguishes the two callers. The standalone equation
    converter wants the whole image back when it cannot find distinct regions,
    because the user uploaded a photo of one formula. The unified pipeline
    wants an empty list, because "no distinct regions" there means "this page
    is prose" - and handing a whole page of text to a formula model produces
    the runs of \\qquad that the tight-cropping fix was written to stop.
    """
    max_regions = max_regions or int(os.getenv('EQUATION_MAX_REGIONS', '12'))
    whole = [] if allow_empty else [(0, 0) + image.size]

    mask = _ink_mask(image)
    if not mask.any():
        return whole

    height, width = mask.shape
    raw = _bands(mask, merge_gap=1)
    if not raw:
        return whole

    # Choosing the merge threshold is the whole trick. Measured on a rendered
    # page of display equations: the gaps *inside* a fraction (numerator, bar,
    # denominator) are 1-3px while the gaps *between* equations are 16-18px,
    # against a median band height of 28. A fraction of the band height sits
    # cleanly between the two, so parts of one formula stay together and
    # separate equations still come apart.
    heights = sorted(bottom - top for top, bottom in raw)
    median_height = heights[len(heights) // 2]
    merge_gap = max(int(median_height * 0.35), 5)

    regions = []
    for top, bottom in _bands(mask, merge_gap=merge_gap):
        if bottom - top < _MIN_REGION_HEIGHT:
            continue
        band = mask[top:bottom]
        if band.sum() / float(band.size) < _MIN_INK_RATIO:
            continue
        regions.append((max(top - _CROP_PADDING, 0),
                        min(bottom + _CROP_PADDING, height)))

    if len(regions) <= 1 and not allow_empty:
        return whole

    if len(regions) > max_regions:
        # Keep the tallest regions - the ones most likely to be equations
        # rather than stray marks - but restore reading order afterwards.
        regions = sorted(sorted(regions, key=lambda r: r[1] - r[0],
                                reverse=True)[:max_regions])

    boxes = []
    for top, bottom in regions:
        # Crop horizontally as well. pix2text-mfr expects a formula that fills
        # its crop; handing it a full-width strip of mostly blank page is what
        # made it emit runs of \qquad instead of the expression.
        columns = mask[top:bottom].any(axis=0)
        ink = np.flatnonzero(columns)
        if len(ink):
            left = max(int(ink[0]) - _CROP_PADDING, 0)
            right = min(int(ink[-1]) + 1 + _CROP_PADDING, width)
        else:
            left, right = 0, width
        boxes.append((left, top, right, bottom))
    return boxes


def segment_equations(image, max_regions=None):
    """
    Split a page into candidate equation regions, top to bottom.

    Returns a list of PIL images. A page holding a single expression comes back
    as one region - the whole image - so single-equation uploads behave exactly
    as they always did.
    """
    return [image.crop(box)
            for box in segment_boxes(image, max_regions, allow_empty=False)]


def tighten(image, box):
    """
    Shrink a box to the ink actually inside it.

    Needed when a region has been carved vertically: the original band's left
    and right edges were measured across the whole band, so a sub-range of it
    can be left with a wide margin. pix2text-mfr expects a formula that fills
    its crop - a loose one is what produced runs of \\qquad.
    """
    left, top, right, bottom = box
    try:
        mask = _ink_mask(image.crop(box))
    except Exception:
        return box
    if not mask.any():
        return box

    rows = np.flatnonzero(mask.any(axis=1))
    columns = np.flatnonzero(mask.any(axis=0))
    new_top = top + max(int(rows[0]) - _CROP_PADDING, 0)
    new_bottom = top + min(int(rows[-1]) + 1 + _CROP_PADDING, mask.shape[0])
    new_left = left + max(int(columns[0]) - _CROP_PADDING, 0)
    new_right = left + min(int(columns[-1]) + 1 + _CROP_PADDING, mask.shape[1])
    return (new_left, new_top, new_right, new_bottom)


def recognize(image):
    """Public name for the single-formula recognition step."""
    return _recognize(image)


def process_image_list(file_bytes):
    """
    Recognise every equation on the page, separately and in reading order.

    Returns a list of dicts: {'index': 1, 'latex': '...'}. The ordered list is
    this converter's whole output: it reads each expression and says nothing
    about how they relate or where they sit on the page. The app does not use
    it - run.py places recognised formulas by position instead, via
    segment_boxes(), tighten() and recognize() - so this is kept as the
    module's own page-level entry point alongside process_image().
    """
    if not is_model_loaded():
        raise RuntimeError("OCR model not loaded")

    img = Image.open(io.BytesIO(file_bytes))
    img, _notes = preprocess.prepare_image(img, do_upscale=False)

    equations = []
    for region in segment_equations(img):
        latex = _recognize(region)
        if latex:
            equations.append({'index': len(equations) + 1, 'latex': latex})

    if not equations:
        return [{'index': 1, 'latex': '[No text recognized]'}]
    return equations
    