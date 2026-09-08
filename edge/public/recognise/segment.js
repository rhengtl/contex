/**
 * Finding the ink on a page -- the browser port of the segmentation half of
 * contex/pipeline/recognise/formulas.py.
 *
 * pix2text-mfr recognises *a formula*; it does not find formulas on a page. So
 * a page holding several equations is segmented first and each region is read
 * on its own. Handing the model a whole page and asking for one expression is
 * where the runs of \qquad came from.
 *
 * These boxes are also the join key the whole fallback turns on. The text
 * engine reports where the words are; this reports where the ink blocks are;
 * both in the coordinate space of the same conditioned page. Overlaying them
 * is what lets assemble.js decide which regions are mathematics and put each
 * one back at the position it occupied. See latex/assemble.js.
 */

// A region shorter than this is noise (a speck, an underline, a stray mark).
const MIN_REGION_HEIGHT = 12;

// Ink coverage below this means the band is not a formula.
const MIN_INK_RATIO = 0.002;

// And above THIS it is not a formula either.
//
// An addition to what formulas.py does, not a port of it, and it earns its
// place on one measured case: a solid dark page -- a photograph taken with a
// finger over the lens, a scan of a black sheet -- has mean 0 and standard
// deviation 0, so the Otsu-style split floors at 60, every pixel is below it,
// and the whole page becomes one band of "ink". It is then nominated (no text
// overlaps it) and handed to the formula model, which duly returns an
// expression. The user gets mathematics that was never on the page.
//
// Real displayed formulas measure 0.2-20% ink against their own crop. Nothing
// legitimate comes close to 90%, so this only ever rejects solid blocks.
const MAX_INK_RATIO = 0.9;

// Padding kept around each crop so ascenders and descenders are not clipped.
const CROP_PADDING = 8;

// The ceiling on how many regions one page may nominate. EQUATION_MAX_REGIONS
// in the Python config; there is no server to read it from here.
const MAX_REGIONS = 12;

/**
 * Boolean ink mask, robust to grey scans -- formulas.py _ink_mask().
 *
 * An Otsu-style split between page and ink with a floor, so a blank page does
 * not turn into all-ink. Returns a Uint8Array of 0/1, which is what every
 * consumer here actually wants to index.
 */
export function inkMask(grey, width, height) {
  let sum = 0;
  for (let i = 0; i < grey.length; i++) sum += grey[i];
  const mean = sum / grey.length;
  let variance = 0;
  for (let i = 0; i < grey.length; i++) {
    const d = grey[i] - mean;
    variance += d * d;
  }
  const sd = Math.sqrt(variance / grey.length);
  const threshold = Math.max(Math.min(mean - sd, 200.0), 60.0);

  const mask = new Uint8Array(width * height);
  let ink = 0;
  for (let i = 0; i < mask.length; i++) {
    if (grey[i] < threshold) { mask[i] = 1; ink++; }
  }
  return { mask, width, height, ink };
}

/** Contiguous rows of ink, merging bands separated by only a small gap. */
function bands({ mask, width, height }, mergeGap) {
  const rows = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[base + x]) { rows[y] = 1; break; }
    }
  }

  const found = [];
  let start = null;
  for (let y = 0; y < height; y++) {
    if (rows[y] && start === null) start = y;
    else if (!rows[y] && start !== null) { found.push([start, y]); start = null; }
  }
  if (start !== null) found.push([start, height]);
  if (!found.length) return [];

  // A fraction is three separate ink rows (numerator, bar, denominator) with
  // tiny gaps between them; two equations are separated by a full line space.
  // Merging on a threshold derived from band height keeps a fraction in one
  // piece while still splitting the equations apart.
  const merged = [found[0].slice()];
  for (const [top, bottom] of found.slice(1)) {
    if (top - merged[merged.length - 1][1] < mergeGap) {
      merged[merged.length - 1][1] = bottom;
    } else {
      merged.push([top, bottom]);
    }
  }
  return merged;
}

/**
 * Candidate regions, top to bottom, as (left, top, right, bottom) boxes.
 *
 * `allowEmpty` distinguishes the two callers, exactly as in Python. A
 * standalone equation upload wants the whole image back when it finds no
 * distinct regions, because the user photographed one formula. The unified
 * pipeline wants an empty list, because "no distinct regions" there means
 * "this page is prose" -- and a whole page of text handed to a formula model
 * is what tight cropping was written to stop.
 */
export function segmentBoxes(masked, { maxRegions = MAX_REGIONS,
                                       allowEmpty = false } = {}) {
  const { mask, width, height, ink } = masked;
  const whole = allowEmpty ? [] : [[0, 0, width, height]];
  if (!ink) return whole;

  const raw = bands(masked, 1);
  if (!raw.length) return whole;

  // Choosing the merge threshold is the whole trick. Measured in Python on a
  // rendered page of display equations: the gaps *inside* a fraction are 1-3px
  // while the gaps *between* equations are 16-18px, against a median band
  // height of 28. A fraction of the band height sits cleanly between the two.
  const heights = raw.map(([t, b]) => b - t).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const mergeGap = Math.max(Math.floor(medianHeight * 0.35), 5);

  let regions = [];
  for (const [top, bottom] of bands(masked, mergeGap)) {
    if (bottom - top < MIN_REGION_HEIGHT) continue;
    let count = 0;
    for (let i = top * width; i < bottom * width; i++) count += mask[i];
    const ratio = count / ((bottom - top) * width);
    if (ratio < MIN_INK_RATIO || ratio > MAX_INK_RATIO) continue;
    regions.push([Math.max(top - CROP_PADDING, 0),
                  Math.min(bottom + CROP_PADDING, height)]);
  }

  if (regions.length <= 1 && !allowEmpty) return whole;

  if (regions.length > maxRegions) {
    // Keep the tallest -- most likely to be equations rather than stray marks
    // -- but restore reading order afterwards.
    regions = regions.slice()
      .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
      .slice(0, maxRegions)
      .sort((a, b) => a[0] - b[0]);
  }

  const boxes = [];
  for (const [top, bottom] of regions) {
    // Crop horizontally as well. pix2text-mfr expects a formula that fills its
    // crop; a full-width strip of mostly blank page is what made it emit runs
    // of \qquad instead of the expression.
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      for (let y = top; y < bottom; y++) {
        if (mask[y * width + x]) {
          if (first < 0) first = x;
          last = x;
          break;
        }
      }
    }
    const left = first < 0 ? 0 : Math.max(first - CROP_PADDING, 0);
    const right = first < 0 ? width : Math.min(last + 1 + CROP_PADDING, width);
    boxes.push([left, top, right, bottom]);
  }
  return boxes;
}

/**
 * Shrink a box to the ink actually inside it -- formulas.py tighten().
 *
 * Needed when a region has been carved vertically: the original band's left
 * and right edges were measured across the whole band, so a sub-range of it
 * can be left with a wide margin, and a loose crop is what produced runs of
 * \qquad.
 */
export function tighten(masked, box) {
  const { mask, width } = masked;
  const [left, top, right, bottom] = box;
  let minX = -1;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = top; y < bottom; y++) {
    const base = y * width;
    for (let x = left; x < right; x++) {
      if (mask[base + x]) {
        if (minY < 0) minY = y;
        maxY = y;
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (minY < 0) return box;

  const boxHeight = bottom - top;
  const boxWidth = right - left;
  return [
    left + Math.max(minX - left - CROP_PADDING, 0),
    top + Math.max(minY - top - CROP_PADDING, 0),
    left + Math.min(maxX - left + 1 + CROP_PADDING, boxWidth),
    top + Math.min(maxY - top + 1 + CROP_PADDING, boxHeight),
  ];
}
