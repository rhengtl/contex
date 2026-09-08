/**
 * Reading the words on a page, locally -- the browser port of
 * contex/pipeline/recognise/tesseract.py.
 *
 * WHY THIS EXISTS. It is the other half of the fallback. When the AI is
 * unavailable, formulas.js reads the mathematics and this reads everything
 * else; assemble.js puts them back in order. Nothing here runs unless the user
 * has agreed to the local path -- run.py is explicit that a downgrade is never
 * silent, and app.js keeps that promise.
 *
 * WHY THE SAME ENGINE. Not "an OCR engine that also runs in a browser":
 * tesseract.js is Tesseract itself, compiled to WebAssembly, and
 * tools/build-models.mjs copies THIS MACHINE's eng.traineddata -- the very
 * file the Python pipeline reads through pytesseract. Same engine, same
 * language data, same page-segmentation mode. That is what makes comparing the
 * two a measurement rather than an analogy.
 *
 * SELF-HOSTED, and that is forced as well as preferred. tesseract.js fetches
 * its core and its language data from a CDN by default; connect-src is 'self'
 * (public/_headers), so those fetches are blocked. Correctly: this is the one
 * path on which nothing about the user's document leaves their machine, and
 * calling out to a third party the moment it runs would make the Privacy
 * Policy untrue. 8.0 MiB, served from our own origin, fetched only on a
 * fallback.
 *
 * LAZY, for the same reason formulas.js is. On the AI path none of it is ever
 * requested; tests/fallback.mjs asserts that rather than assuming it.
 */

const LIB_URL = '/vendor/tesseract/tesseract.esm.min.js';
const WORKER_URL = '/vendor/tesseract/worker.min.js';
const CORE_URL = '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js';
const LANG_PATH = '/models/tessdata';

// LSTM only, because that is the core we ship. pytesseract leaves OEM at 3
// ("default"), which on Tesseract 5 with this traineddata resolves to LSTM
// anyway -- so this is the same engine, said explicitly rather than inferred.
const OEM_LSTM_ONLY = 1;

// PSM 3, fully automatic page segmentation without orientation detection. It
// is pytesseract's default and therefore the Python pipeline's, and the whole
// reason preprocess.js deskews: at PSM 3 a rotated page returns an EMPTY
// STRING rather than a bad one.
const PSM_AUTO = '3';

let worker = null;
let loading = null;

/**
 * Load the engine and the language data, once per page.
 *
 * `onProgress` is called with a short phrase, because this is a multi-megabyte
 * fetch and a silent one looks like a hang.
 */
export function load({ onProgress } = {}) {
  if (worker) return Promise.resolve(worker);
  if (loading) return loading;

  loading = (async () => {
    const say = (m) => { if (onProgress) onProgress(m); };
    say('Loading the offline text reader…');

    const Tesseract = await import(LIB_URL);
    const created = await (Tesseract.createWorker || Tesseract.default.createWorker)(
      'eng', OEM_LSTM_ONLY,
      {
        workerPath: WORKER_URL,
        corePath: CORE_URL,
        langPath: LANG_PATH,
        // Our traineddata is the plain file, not the .gz the CDN serves.
        gzip: false,
        // A same-origin worker can be started directly; the blob-URL dance
        // exists for the cross-origin CDN case we do not have.
        workerBlobURL: false,
        logger: (m) => {
          if (m && m.status === 'recognizing text') {
            say(`Reading the page… ${Math.round((m.progress || 0) * 100)}%`);
          }
        },
      });
    await created.setParameters({ tessedit_pageseg_mode: PSM_AUTO });

    worker = created;
    say('');
    return worker;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** True when the engine is already in memory, so a caller can skip the notice. */
export function ready() { return worker !== null; }

/** Release the engine and its memory. */
export async function unload() {
  const current = worker;
  worker = null;
  loading = null;
  if (current) await current.terminate().catch(() => {});
}

/**
 * Read a page and return its lines **with geometry and confidence**.
 *
 * `image_to_string` throws both away; the unified pipeline needs them for two
 * things:
 *
 *   position    each line's box says where it sits, which is what lets an
 *               equation be spliced back into the right place in the flow.
 *   confidence  Tesseract has no mathematical model, so where a formula is it
 *               guesses at glyphs and its confidence collapses. Measured
 *               across bench/img_pages: prose lines never drop below 43, while
 *               every line overlapping display maths falls to 0-5. That is the
 *               text/maths discriminator, and it costs nothing.
 *
 * Returns [{ text, box: [left, top, right, bottom], minConf, meanConf, block,
 * par, line }], in reading order -- down the page, then across.
 *
 * The grouping is Tesseract's own block/paragraph/line tree rather than
 * Python's regrouping by (block_num, par_num, line_num) over a flat table.
 * Same lines, same numbering: the flat table is that tree, flattened.
 */
export async function extractLines(source, { onProgress } = {}) {
  const engine = await load({ onProgress });
  const { data } = await engine.recognize(source, {}, { blocks: true, text: false });

  const lines = [];
  const blocks = data.blocks || [];
  blocks.forEach((block, blockIndex) => {
    (block.paragraphs || []).forEach((paragraph, parIndex) => {
      (paragraph.lines || []).forEach((line, lineIndex) => {
        const words = [];
        const confs = [];
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;

        for (const word of line.words || []) {
          const text = (word.text || '').trim();
          // Empty text and a negative confidence are both "Tesseract reported
          // a slot, not a word". Python drops them before it groups; so must
          // this, or a line's minimum confidence becomes -1 every time.
          if (!text) continue;
          const confidence = Math.trunc(Number(word.confidence));
          if (!Number.isFinite(confidence) || confidence < 0) continue;
          words.push(text);
          confs.push(confidence);
          const box = word.bbox || {};
          left = Math.min(left, box.x0);
          top = Math.min(top, box.y0);
          right = Math.max(right, box.x1);
          bottom = Math.max(bottom, box.y1);
        }
        if (!words.length) return;

        lines.push({
          text: words.join(' '),
          box: [left, top, right, bottom],
          minConf: Math.min(...confs),
          meanConf: confs.reduce((a, b) => a + b, 0) / confs.length,
          block: blockIndex, par: parIndex, line: lineIndex,
        });
      });
    });
  });

  lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  return lines;
}

// ---------------------------------------------------------------------------
// Making OCR text safe to put in a document
// ---------------------------------------------------------------------------

// Characters that are syntax in LaTeX. Without this, any page containing a '%'
// or an '&' produced a .tex that silently lost content or failed to compile.
const TEX_ESCAPES = new Map(Object.entries({
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}));

// Symbols Tesseract emits as Unicode that LaTeX cannot typeset as literal
// text. Without these a single misread glyph -- a stray guillemet, a maths
// sign picked up from an equation -- makes the whole .tex fail to compile.
const TEX_UNICODE = new Map(Object.entries({
  '≤': '$\\le$', '≥': '$\\ge$', '≠': '$\\neq$',
  '×': '$\\times$', '÷': '$\\div$', '±': '$\\pm$',
  '√': '$\\sqrt{\\ }$', '∞': '$\\infty$', '∑': '$\\sum$',
  '∫': '$\\int$', '∂': '$\\partial$', '→': '$\\rightarrow$',
  '←': '$\\leftarrow$', '⇒': '$\\Rightarrow$',
  '≈': '$\\approx$', '≡': '$\\equiv$', '−': '-',
  '·': '$\\cdot$', '′': "$'$", '°': '$^{\\circ}$',
  '—': '---', '–': '--', '…': '\\ldots{}',
  '“': '``', '”': "''", '‘': '`', '’': "'",
  ' ': ' ',
}));

// Greek arrives whenever a formula bleeds into the text layer.
const GREEK = ('alpha beta gamma delta epsilon zeta eta theta iota kappa '
               + 'lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi '
               + 'chi psi omega').split(' ');
GREEK.forEach((name, index) => {
  if (name === 'omicron' || name === 'sigmaf') return;
  const ch = String.fromCodePoint(0x3b1 + index);
  if (!TEX_UNICODE.has(ch)) TEX_UNICODE.set(ch, `$\\${name}$`);
});

/**
 * Make plain OCR text safe to drop into a LaTeX document.
 *
 * Escapes the ten special characters, maps the Unicode symbols OCR commonly
 * emits onto LaTeX equivalents, and replaces anything left that LaTeX cannot
 * render with '?'. Losing one unrecognisable glyph is far better than losing
 * the whole file to a fatal compile error.
 *
 * This is also a security boundary and not only a compilation one. Everything
 * the local path writes as *text* passes through here, and a backslash becomes
 * \textbackslash{} -- so a page that has the words "\input{/etc/passwd}"
 * printed on it cannot become that command. See tests/fallback.mjs.
 */
export function escapeTex(text) {
  const out = [];
  for (const ch of text || '') {
    if (TEX_ESCAPES.has(ch)) out.push(TEX_ESCAPES.get(ch));
    else if (TEX_UNICODE.has(ch)) out.push(TEX_UNICODE.get(ch));
    else if (ch === '\n' || ch === '\r' || ch === '\t' || ch.codePointAt(0) < 127) out.push(ch);
    else if (ch.codePointAt(0) <= 0xff) out.push(ch);   // Latin-1: T1 sets it
    else out.push('?');
  }
  return out.join('');
}
