/**
 * Conditioning a page before any recogniser sees it -- the browser port of
 * contex/pipeline/preprocess.py.
 *
 * This is the cheapest accuracy in the project, and bench/README.md already
 * measured what it is worth. On the 10-degree skew set:
 *
 *     Tesseract char accuracy   28.44%  ->  99.84%   after deskew
 *
 * At the default page-segmentation mode a rotated page makes Tesseract return
 * an empty string, so without this the user sees a blank result and no error
 * at all. That is the single worst failure mode the fallback has, and four
 * cheap steps remove it:
 *
 *   flatten alpha   the Draw canvas produces a transparent PNG, and every
 *                   "convert to greyscale" in every engine drops alpha instead
 *                   of compositing it -- which turns the background BLACK.
 *                   Measured in Python: the ink mask then flags 100% of pixels
 *                   and segmentation collapses to one band.
 *   EXIF rotation   a phone stores orientation as metadata; a sideways page
 *                   defeats every OCR engine there is.
 *   deskew          estimate the dominant text angle and rotate it flat.
 *   upscale         very low DPI is the other measured weak spot (87.52%,
 *                   0/10 exact lines).
 *
 * Every step returns what it was given when it has nothing to do, so the
 * `notes` it produces say what actually changed rather than what was tried.
 *
 * WHAT IS DIFFERENT FROM PYTHON, and why. Two things, both forced and both
 * benign:
 *
 *   The decompression-bomb ceiling is the browser's problem here, not ours: a
 *   30000x30000 PNG is decoded by the browser into its own memory, and
 *   createImageBitmap rejects what it cannot hold. MAX_PIXELS is still
 *   enforced, because a 3.6 GB decode that "succeeds" and then makes the tab
 *   unresponsive is not better than a refusal.
 *
 *   EXIF is applied by the decoder rather than read by us. `imageOrientation:
 *   'from-image'` is what ImageOps.exif_transpose() does, done by the platform
 *   that already parsed the file.
 */

import { resize, LANCZOS } from '/recognise/resample.js';

// 64 megapixels, exactly as preprocess.py. A 300 DPI A4 scan is about 8.7, so
// nothing legitimate is refused.
const MAX_PIXELS = 64_000_000;

// Below this the angle is noise, and rotating would only resample for nothing.
const MIN_CORRECTION_DEG = 0.35;

// Estimation runs on a downscaled copy: the angle of a page does not change
// with resolution. Measured in Python, dropping this below 900 makes the
// estimate worse rather than merely cheaper.
const ESTIMATE_MAX_EDGE = 900;

// How far apart the coarse sweep places candidates, and how many of its peaks
// are then examined on the real grid. Three peaks, not one: a blurred page's
// score curve has several local maxima, and following only the best coarse
// sample walked into the wrong one on 9 of 351 measured cases.
const COARSE_STEP = 2.0;
const COARSE_PEAKS = 3;

// Inputs smaller than this on the long edge are treated as low-DPI captures.
const MIN_USEFUL_EDGE = 1000;
const MAX_UPSCALE = 2.0;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * PIL's convert('L'): ITU-R 601-2 luma, truncated to a byte.
 *
 * Written out rather than left to the browser because every threshold below is
 * calibrated against the Python numbers, and a different luma weighting moves
 * every one of them.
 */
export function greyscale(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return out;
}

/** The page as one RGBA buffer, which is what everything downstream reads. */
export function pixelsOf(canvas) {
  return context(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Bytes to a canvas, with the camera's orientation honoured.
 *
 * Drawn onto white rather than onto nothing, which is flatten_alpha() and is
 * not optional conditioning: without it a drawing is a black rectangle to
 * every engine downstream. Whether it changed anything is reported, because
 * prepare() has to be able to say what it did.
 */
export async function decodeImage(source, { type = 'image/png' } = {}) {
  const blob = source instanceof Blob ? source
    : new Blob([source instanceof Uint8Array ? source : new Uint8Array(source)],
               { type });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      throw new Error(
        `That image is ${Math.round(bitmap.width * bitmap.height / 1e6)} ` +
        'megapixels, which is too large to convert in the browser.');
    }
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    const ctx = context(canvas);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    // Did compositing actually do anything? Cheap: only the alpha channel, and
    // only until the first transparent pixel.
    const probe = makeCanvas(bitmap.width, bitmap.height);
    const pctx = context(probe);
    pctx.drawImage(bitmap, 0, 0);
    const alpha = pctx.getImageData(0, 0, probe.width, probe.height).data;
    let transparent = false;
    for (let p = 3; p < alpha.length; p += 4) {
      if (alpha[p] !== 255) { transparent = true; break; }
    }
    return { canvas, transparent };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Deskew
// ---------------------------------------------------------------------------

/**
 * PIL's Image.rotate(angle, resample=BILINEAR, fillcolor=0) on a binary page.
 *
 * Same size, about the centre, no expansion -- the estimator only ever wants
 * the score, and growing the canvas would change the profile it scores.
 *
 * THE SIGN IS PIL'S, and getting it wrong is not a cosmetic error: the
 * estimator returns the angle the deskew then applies, so an inverted one
 * rotates a crooked page FURTHER. Measured before this was fixed, a 7-degree
 * page came out at 14 and Tesseract's line count fell from 7 to 3.
 *
 * Image.rotate() negates the angle before it builds the matrix -- so a
 * positive angle turns the content anticlockwise, as its documentation says,
 * and the inverse map that produces is:
 *
 *     x' =  cos(a)(x - cx) - sin(a)(y - cy) + cx
 *     y' =  sin(a)(x - cx) + cos(a)(y - cy) + cy
 */
function rotateBinary(src, width, height, degrees) {
  const out = new Uint8Array(width * height);
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const sx = cos * dx - sin * dy + cx - 0.5;
      const sy = sin * dx + cos * dy + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * width + x0;
      const top = src[i] * (1 - fx) + src[i + 1] * fx;
      const bottom = src[i + width] * (1 - fx) + src[i + width + 1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * The rotation, in degrees, that makes the page's text lines level.
 *
 * Rotates a binarised copy through candidate angles and scores how sharply the
 * horizontal ink-projection profile changes from row to row: when lines are
 * level, rows are either all text or all whitespace, so the profile has steep
 * edges. This is bench/deskew_test.py's algorithm, and preprocess.py's
 * coarse-to-fine search over it -- 27 rotations rather than 61, verified in
 * Python to give an identical answer on all 351 measured cases.
 */
export function estimateSkew(grey, width, height,
                             { limit = 15.0, step = 0.5, coarse = COARSE_STEP,
                               peaks = COARSE_PEAKS } = {}) {
  // Work at the estimator's resolution, as Python thumbnails to it.
  let w = width;
  let h = height;
  let source = grey;
  const longest = Math.max(width, height);
  if (longest > ESTIMATE_MAX_EDGE) {
    const factor = ESTIMATE_MAX_EDGE / longest;
    w = Math.max(1, Math.floor(width * factor));
    h = Math.max(1, Math.floor(height * factor));
    // Nearest neighbour: the input is about to be thresholded to one bit, so a
    // smoother reduction would only be thrown away.
    source = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(height - 1, Math.floor(y / factor));
      for (let x = 0; x < w; x++) {
        source[y * w + x] = grey[sy * width + Math.min(width - 1, Math.floor(x / factor))];
      }
    }
  }

  const ink = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < ink.length; i++) {
    if (source[i] < 128) { ink[i] = 255; any = true; }
  }
  if (!any) return 0.0;   // blank page: nothing to align

  const cache = new Map();
  const score = (angle) => {
    const key = angle.toFixed(6);
    if (cache.has(key)) return cache.get(key);
    const rotated = rotateBinary(ink, w, h, angle);
    let previous = 0;
    let total = 0;
    for (let y = 0; y < h; y++) {
      let row = 0;
      const base = y * w;
      for (let x = 0; x < w; x++) if (rotated[base + x] > 128) row++;
      if (y > 0) {
        const change = row - previous;
        total += change * change;
      }
      previous = row;
    }
    cache.set(key, total);
    return total;
  };

  const grid = [];
  for (let a = -limit; a <= limit + 1e-9; a += step) grid.push(Number(a.toFixed(6)));
  if (coarse <= step || peaks < 1) {
    return grid.reduce((best, a) => (score(a) > score(best) ? a : best), grid[0]);
  }

  const sparse = grid.filter((a) => Math.abs(a / coarse - Math.round(a / coarse)) < 1e-9);
  const best = (sparse.length ? sparse : grid)
    .slice().sort((x, y) => score(y) - score(x)).slice(0, peaks);
  const near = grid.filter((a) => best.some((peak) => Math.abs(a - peak) <= coarse));
  return near.reduce((winner, a) => (score(a) > score(winner) ? a : winner), near[0]);
}

/**
 * Rotate a page flat. Returns { canvas, angle }.
 *
 * Straight pages come back untouched -- the estimator reports ~0 for them, and
 * resampling a full-resolution scan for nothing is the largest avoidable cost
 * on this path.
 */
export function deskew(canvas, grey) {
  const angle = estimateSkew(grey, canvas.width, canvas.height);
  if (Math.abs(angle) < MIN_CORRECTION_DEG) return { canvas, angle: 0.0 };

  const radians = angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = Math.round(canvas.width * cos + canvas.height * sin);
  const height = Math.round(canvas.width * sin + canvas.height * cos);

  const out = makeCanvas(width, height);
  const ctx = context(out);
  // White, not transparent: this is a page, and expand=True leaves corners
  // that every threshold downstream would otherwise read as solid ink.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(width / 2, height / 2);
  // Canvas turns clockwise for a positive angle because y points down; PIL
  // turns anticlockwise. Same rotation, opposite sign.
  ctx.rotate(-radians);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return { canvas: out, angle };
}

// ---------------------------------------------------------------------------
// Upscale
// ---------------------------------------------------------------------------

/**
 * Enlarge a very small capture so glyph strokes survive binarisation.
 *
 * Lanczos, as preprocess.py uses, through our own resampler rather than
 * drawImage -- for the reason resample.js gives: the canvas filter is
 * browser-dependent, and a recogniser that scores differently in Firefox than
 * in Chrome is not one whose numbers mean anything.
 */
export function upscaleSmall(canvas, minEdge = MIN_USEFUL_EDGE) {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest >= minEdge) return { canvas, factor: 1.0 };
  const factor = Math.min(minEdge / longest, MAX_UPSCALE);
  if (factor <= 1.01) return { canvas, factor: 1.0 };

  const width = Math.max(1, Math.floor(canvas.width * factor));
  const height = Math.max(1, Math.floor(canvas.height * factor));
  const source = pixelsOf(canvas);
  const scaled = resize(source.data, canvas.width, canvas.height,
                        width, height, LANCZOS);

  const out = makeCanvas(width, height);
  const image = context(out).createImageData(width, height);
  for (let i = 0; i < width * height * 4; i++) {
    image.data[i] = Math.min(255, Math.max(0, Math.round(scaled[i])));
  }
  context(out).putImageData(image, 0, 0);
  return { canvas: out, factor };
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Run the full conditioning chain. Returns { canvas, grey, notes }.
 *
 * Never throws for a conditioning failure: preprocess.py is explicit that a
 * preprocessing problem must not cost the user their conversion, so a step
 * that fails is skipped and said.
 *
 * `grey` is returned alongside because everything after this -- segmentation,
 * the ink mask, the recognisers -- wants it, and computing it once here saves
 * a full-page pass per consumer.
 */
export function prepare(canvas, { deskewPage = true, upscale = true,
                                  transparent = false } = {}) {
  const notes = [];
  if (transparent) notes.push('Placed a transparent image on a white background.');

  let working = canvas;
  let grey = greyscale(pixelsOf(working));

  try {
    if (deskewPage) {
      const turned = deskew(working, grey);
      if (turned.angle) {
        working = turned.canvas;
        grey = greyscale(pixelsOf(working));
        const sign = turned.angle > 0 ? '+' : '';
        notes.push(`Deskewed by ${sign}${turned.angle.toFixed(1)} degrees.`);
      }
    }
    if (upscale) {
      const bigger = upscaleSmall(working);
      if (bigger.factor > 1.0) {
        working = bigger.canvas;
        grey = greyscale(pixelsOf(working));
        notes.push(`Upscaled a low-resolution image ${bigger.factor.toFixed(1)}x.`);
      }
    }
  } catch (err) {
    notes.push('Some page conditioning could not be applied.');
    console.warn('preprocessing skipped:', err);
  }

  return { canvas: working, grey, notes };
}
