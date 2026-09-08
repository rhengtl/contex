/**
 * Reading a formula, locally -- the browser port of
 * contex/pipeline/recognise/formulas.py.
 *
 * WHY THIS EXISTS AT ALL. It is the fallback, not the main path. When the AI
 * is unavailable the conversion has to be able to finish without it, and
 * run.py is explicit that the fallback must never be taken silently: the user
 * is told it is the lower-quality path and gets to decline. Nothing here runs
 * unless they have said yes.
 *
 * WHY IN THE BROWSER. S2 compared four options and locked this one: INT8
 * pix2text-mfr through ONNX Runtime Web. Measured over the 75-image formula
 * benchmark, INT8 scored 90.26% character accuracy and 80% exact match --
 * against 90.9%/81% for the same model at full precision on the server. The
 * quantisation is not the compromise; running it at all instead of a good
 * model is, and that is what the AI path is for.
 *
 * WHAT IT COSTS. 31.8 MiB of model plus 10.7 MiB of runtime, fetched the first
 * time a fallback happens and cached hard afterwards. formulas.py has the same
 * shape -- run.py's _warm_formula_model() calls loading it "several hundred
 * megabytes" and starts it early precisely because it is slow. Nothing is
 * fetched on the AI path.
 *
 * SINGLE-THREADED, and that is forced. Multi-threaded ONNX needs
 * SharedArrayBuffer, which needs cross-origin isolation, which would break the
 * Firebase auth popup and the gstatic SDK load (spec R3). The measurement
 * above was taken in this configuration, so it is the number that applies.
 */

import { resize } from '/recognise/resample.js';

const ORT_URL = '/vendor/ort/ort.wasm.min.mjs';
const ORT_WASM_DIR = '/vendor/ort/';
const MODEL_DIR = '/models/mfr';

// The image geometry the model was trained on: DeiT/TrOCR preprocessing.
const SIZE = 384;
const MEAN = 0.5;
const STD = 0.5;

// preprocessor_config.json / generation_config.json. `2` is both the start and
// the end token in this checkpoint, which is why the loop seeds with it and
// still stops on it.
const START = 2;
const EOS = 2;
const PAD = 0;

// generation_config.json max_length. A formula that has not ended by here is
// a runaway rather than a long formula; every benchmark image finished well
// inside it.
const MAX_NEW = 200;

let session = null;      // { ort, encoder, decoder, vocab, byteDecoder }
let loading = null;

/**
 * The GPT-2 byte-level alphabet, inverted.
 *
 * The tokenizer stores pieces as printable stand-ins for raw bytes, so a token
 * string has to be mapped back to bytes before it is UTF-8 decoded. Getting
 * this wrong is what makes a working model emit `EEEEEEEE` -- which is exactly
 * what transformers.js did on this checkpoint, and why the decode loop below
 * is written out by hand rather than delegated.
 */
function buildByteDecoder() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(String.fromCodePoint(cs[i]), bs[i]);
  return map;
}

/** Token ids back to the LaTeX they stand for. */
function decodeIds(ids, vocab, byteDecoder) {
  let joined = '';
  for (const id of ids) {
    if (id === START || id === PAD) continue;
    joined += vocab.get(id) ?? '';
  }
  const bytes = [];
  for (const ch of joined) {
    const b = byteDecoder.get(ch);
    if (b !== undefined) bytes.push(b);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * Load the runtime and the model, once per page.
 *
 * `onProgress` is called with a short phrase, because this is a 42 MiB fetch
 * and a silent one looks like a hang.
 */
export function load({ onProgress } = {}) {
  if (session) return Promise.resolve(session);
  if (loading) return loading;

  loading = (async () => {
    const say = (m) => { if (onProgress) onProgress(m); };
    say('Loading the offline formula reader…');

    const ort = await import(ORT_URL);
    // Single-threaded, no SharedArrayBuffer -- see the note at the top.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = ORT_WASM_DIR;

    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    say('Loading the recogniser (this happens once)…');
    const encoder = await ort.InferenceSession.create(`${MODEL_DIR}/encoder.onnx`, opts);
    const decoder = await ort.InferenceSession.create(`${MODEL_DIR}/decoder.onnx`, opts);

    const tok = await (await fetch(`${MODEL_DIR}/tokenizer.json`)).json();
    const vocab = new Map(Object.entries(tok.model.vocab).map(([s, i]) => [i, s]));

    session = { ort, encoder, decoder, vocab, byteDecoder: buildByteDecoder() };
    say('');
    return session;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** True when the model is already in memory, so a caller can skip the notice. */
export function ready() { return session !== null; }

/**
 * DeiTImageProcessor, in the browser -- preprocessor_config.json step for step:
 * resize to 384x384 with PIL's bicubic, rescale by 1/255, normalise by
 * (x - 0.5) / 0.5. No centre crop; the config turns it off.
 *
 * The resize is our own (recognise/resample.js) rather than the canvas's,
 * because the canvas's is a different filter and the model notices -- 69%
 * character accuracy against 90% on the same weights. See the note there.
 *
 * Takes anything canvas can draw: an ImageBitmap, a canvas, an <img>.
 */
function toTensor(ort, source) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;

  // Read the source at its own size, so the filter sees every pixel it should.
  const src = document.createElement('canvas');
  src.width = width;
  src.height = height;
  const sg = src.getContext('2d', { willReadFrequently: true });
  // White behind the drawing: a transparent PNG would otherwise composite
  // against black, and the model would be reading a photograph of nothing.
  sg.fillStyle = '#fff';
  sg.fillRect(0, 0, width, height);
  sg.drawImage(source, 0, 0);
  const { data } = sg.getImageData(0, 0, width, height);

  const scaled = resize(data, width, height, SIZE, SIZE);

  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    // Pillow clamps to a byte on the way out of resize; do the same here so
    // the numbers are the ones the Python path would have produced.
    const r = Math.min(255, Math.max(0, Math.round(scaled[i * 4])));
    const g = Math.min(255, Math.max(0, Math.round(scaled[i * 4 + 1])));
    const b = Math.min(255, Math.max(0, Math.round(scaled[i * 4 + 2])));
    out[i] = (r / 255 - MEAN) / STD;
    out[i + plane] = (g / 255 - MEAN) / STD;
    out[i + 2 * plane] = (b / 255 - MEAN) / STD;
  }
  return new ort.Tensor('float32', out, [1, 3, SIZE, SIZE]);
}

/**
 * Read one formula. Returns { latex, tokens, ms } -- or latex '' when the
 * model produced nothing usable, which the caller treats as an unread region
 * rather than an error.
 *
 * Greedy decode, no sampling: formulas.py runs the model deterministically and
 * so does this. The exported graph carries no KV cache, so each step re-runs
 * the decoder over the whole prefix. That is affordable because the decoder is
 * small, and it is what S2 measured.
 */
export async function recognise(source, { signal } = {}) {
  const t0 = performance.now();
  const { ort, encoder, decoder, vocab, byteDecoder } = await load();

  const pixelValues = toTensor(ort, source);
  const encoded = await encoder.run({ pixel_values: pixelValues });
  const hidden = encoded[encoder.outputNames[0]];

  const ids = [START];
  for (let step = 0; step < MAX_NEW; step++) {
    if (signal && signal.aborted) break;
    const inputIds = new ort.Tensor(
      'int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]);
    const outputs = await decoder.run(
      { input_ids: inputIds, encoder_hidden_states: hidden });
    const logits = outputs[decoder.outputNames[0]];
    const vocabSize = logits.dims[2];
    const offset = (ids.length - 1) * vocabSize;

    let best = 0;
    let bestValue = -Infinity;
    for (let v = 0; v < vocabSize; v++) {
      const value = logits.data[offset + v];
      if (value > bestValue) { bestValue = value; best = v; }
    }
    if (best === EOS) break;
    ids.push(best);
  }

  return {
    latex: decodeIds(ids, vocab, byteDecoder).trim(),
    tokens: ids.length - 1,
    ms: Math.round(performance.now() - t0),
  };
}
