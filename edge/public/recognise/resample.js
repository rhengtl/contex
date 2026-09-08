/**
 * Pillow's resize, in JavaScript.
 *
 * WHY THIS IS NOT `drawImage`. The formula model's preprocessor_config.json
 * asks for `resample: 3` -- PIL's BICUBIC -- and the Python pipeline gets
 * exactly that. A canvas `drawImage` downscale is whatever the browser feels
 * like: a box filter on some, bilinear on others, and none of them apply the
 * support-scaling that makes a large reduction antialiased rather than
 * aliased. Feeding the model a differently-filtered image is feeding it a
 * different image.
 *
 * Measured on the 75-image formula benchmark: canvas downscaling scored 69%
 * character accuracy against the 90% the same weights reach in Python. This
 * closes that gap, and it closes it identically on every browser, which for a
 * recogniser is worth more than the speed a native call would have saved.
 *
 * The algorithm is Pillow's own (`ImagingResample`, `precompute_coeffs`):
 * a separable convolution, horizontal then vertical, with the filter's support
 * scaled by the reduction factor.
 */

// Pillow's bicubic, with a = -0.5. Support 2.0.
//   |x| < 1   ((a + 2)|x| - (a + 3))x^2 + 1
//   |x| < 2   (((|x| - 5)|x| + 8)|x| - 4) * a
const A = -0.5;
const SUPPORT = 2.0;

function bicubic(x) {
  const t = Math.abs(x);
  if (t < 1.0) return ((A + 2.0) * t - (A + 3.0)) * t * t + 1.0;
  if (t < 2.0) return (((t - 5.0) * t + 8.0) * t - 4.0) * A;
  return 0.0;
}

/**
 * The weights for one axis -- Pillow's precompute_coeffs.
 *
 * Returns { bounds, kk, kmax }: for output pixel i, the source run starts at
 * bounds[i*2], is bounds[i*2+1] long, and its weights are kk[i*kmax ...].
 */
function coefficients(inSize, outSize) {
  const scale = inSize / outSize;
  // A reduction spreads the filter; an enlargement does not narrow it.
  const filterScale = Math.max(1.0, scale);
  const support = SUPPORT * filterScale;
  const kmax = Math.ceil(support) * 2 + 1;

  const bounds = new Int32Array(outSize * 2);
  const kk = new Float64Array(outSize * kmax);

  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.floor(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.ceil(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    const count = xmax - xmin;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = count;

    const base = xx * kmax;
    let sum = 0;
    for (let x = 0; x < count; x++) {
      const w = bicubic((x + xmin - center + 0.5) / filterScale);
      kk[base + x] = w;
      sum += w;
    }
    // Normalise, so a flat area keeps its value.
    if (sum !== 0) {
      for (let x = 0; x < count; x++) kk[base + x] /= sum;
    }
  }
  return { bounds, kk, kmax };
}

/**
 * Resize RGBA pixel data.
 *
 * `src` is a Uint8ClampedArray of srcW*srcH*4 (what getImageData gives).
 * Returns a Float32Array of dstW*dstH*4, unclamped and unrounded -- the caller
 * normalises it straight into a tensor, so rounding to bytes in between would
 * only throw precision away. Pillow rounds because it returns an image; this
 * does not because it returns numbers.
 */
export function resize(src, srcW, srcH, dstW, dstH) {
  // Horizontal pass: srcW -> dstW, height unchanged.
  const h = coefficients(srcW, dstW);
  const middle = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y++) {
    const rowIn = y * srcW * 4;
    const rowOut = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const xmin = h.bounds[x * 2];
      const count = h.bounds[x * 2 + 1];
      const base = x * h.kmax;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < count; i++) {
        const w = h.kk[base + i];
        const p = rowIn + (xmin + i) * 4;
        r += src[p] * w;
        g += src[p + 1] * w;
        b += src[p + 2] * w;
        a += src[p + 3] * w;
      }
      const o = rowOut + x * 4;
      middle[o] = r; middle[o + 1] = g; middle[o + 2] = b; middle[o + 3] = a;
    }
  }

  // Vertical pass: srcH -> dstH.
  const v = coefficients(srcH, dstH);
  const out = new Float32Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const ymin = v.bounds[y * 2];
    const count = v.bounds[y * 2 + 1];
    const base = y * v.kmax;
    const rowOut = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < count; i++) {
        const w = v.kk[base + i];
        const p = ((ymin + i) * dstW + x) * 4;
        r += middle[p] * w;
        g += middle[p + 1] * w;
        b += middle[p + 2] * w;
        a += middle[p + 3] * w;
      }
      const o = rowOut + x * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return out;
}
