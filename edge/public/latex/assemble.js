/**
 * Deciding what is text, what is mathematics, and what order it all goes in --
 * the browser port of contex/pipeline/latex/assemble.py.
 *
 * This is the piece that makes the two recognisers one pipeline. Neither knows
 * about the other; both report geometry in the same coordinate space (the
 * conditioned page), and that shared space is the whole trick. Overlaying the
 * two answers three questions at once:
 *
 *   Which regions are formulas?   The ones Tesseract stumbled over.
 *   Where does each formula go?   At the vertical position its box occupied.
 *   What is the reading order?    Down the page, using Tesseract's own block
 *                                 and paragraph numbering to keep prose
 *                                 together.
 *
 * THE DISCRIMINATOR IS MEASURED, NOT GUESSED. Across bench/img_pages, taking
 * the lowest per-word confidence on each line:
 *
 *     pages without maths   lowest min-conf 43, 81   (and one table at 0)
 *     pages with maths      lowest min-conf 0, 0, 0, 0, 1
 *
 * So a low-confidence run is a reliable *candidate* signal -- every maths page
 * was caught -- but not a classifier, because a table trips it too. That is
 * the right shape for this pipeline: nominate cheaply, transcribe with
 * pix2text, and let looks_like_equation() reject what was not really
 * mathematics.
 *
 * ONE DIFFERENCE FROM PYTHON, and it is a subtraction. There, the AI review
 * gets the last word on a nomination that slipped through, marking headings
 * and prose `not_an_equation` unprompted. Here there is no AI -- being without
 * it is why this code is running at all -- so looksLikeEquation() is the last
 * line of defence rather than the second-to-last. It is unchanged; what is
 * gone is the safety net behind it. That is the honest cost of the fallback,
 * and it is what the notice in app.js is telling the user about.
 */

// Below this Tesseract is guessing at glyphs rather than reading words.
//
// This floor only ever judges lines that are NOT prose -- prose is protected
// separately -- so it is set from where garbled maths actually lands rather
// than from the prose/maths page-level gap. Measured on bench/img_pages, the
// two align equations Tesseract mangled into "(a+b)? =a + 2ab+0?" scored 41
// and 31, while the table rows it read correctly scored 93-96. 50 sits in that
// gap.
export const CONF_FLOOR = 50;

// A nominated region has to be tall enough to be a displayed formula rather
// than a speck or an underline.
const MIN_EQUATION_HEIGHT = 14;

// How much of a text line must sit inside an equation box before that line
// counts as belonging to the formula and its words are dropped. Generous,
// because Tesseract's boxes for garbled maths are ragged.
const OVERLAP = 0.5;

/** Vertical overlap of two boxes as a fraction of the shorter one. */
export function overlap(first, second) {
  const top = Math.max(first[1], second[1]);
  const bottom = Math.min(first[3], second[3]);
  if (bottom <= top) return 0.0;
  const shorter = Math.min(first[3] - first[1], second[3] - second[1]);
  return shorter ? (bottom - top) / shorter : 0.0;
}

const WORD = /[A-Za-z]{3,}/g;

// How many real words (three or more letters) a line needs before it counts as
// a sentence rather than part of a formula. Three separates the cases that
// actually occur: "The Fourier transform of f is" has six, while the garbled
// maths line "lim =1, o =aVu." has two and an equation number "(1)" has none.
const PROSE_WORDS = 3;

/**
 * Is this line a sentence, or something inside a formula?
 *
 * This decides two things at once: a prose line may carve a region, and a
 * prose line is never sent to the formula model.
 *
 * Both directions were measured. Carving on anything confident shredded
 * formulas, because Tesseract reads an equation number "(1)" or a lone
 * numerator "1" perfectly well -- that took a page from 2 equations found to
 * 0. And *not* protecting prose sent "Einstein's mass-energy relation is
 * $E = mc^2$..." to pix2text, which returned it as \mathrm{} letter soup,
 * because a line of prose with inline maths has low confidence too.
 *
 * Inline mathematics therefore stays in the text. Only displayed mathematics
 * -- which occupies its own horizontal band -- goes to the formula model.
 */
export function isProse(text) {
  return ((text || '').match(WORD) || []).length >= PROSE_WORDS;
}

/**
 * Remove confidently-read text lines from a region, returning what is left.
 *
 * The segmenter merges ink separated by less than a line space, so a caption
 * and the formula beneath it routinely arrive as one band -- measured, "The
 * Fourier transform of f is" (confidence 96) merged with the integral below it
 * (confidence 5). Sending the whole band to the formula model would lose the
 * sentence. Subtracting the spans Tesseract read confidently leaves just the
 * part it could not, which is the formula.
 */
function carve(box, confident) {
  let spans = [[box[1], box[3]]];
  for (const line of confident) {
    const lineTop = line.box[1];
    const lineBottom = line.box[3];
    const remaining = [];
    for (const [start, end] of spans) {
      if (lineBottom <= start || lineTop >= end) { remaining.push([start, end]); continue; }
      if (lineTop > start) remaining.push([start, lineTop]);
      if (lineBottom < end) remaining.push([lineBottom, end]);
    }
    spans = remaining;
  }
  return spans.filter(([start, end]) => end - start >= MIN_EQUATION_HEIGHT)
    .map(([start, end]) => [box[0], start, box[2], end]);
}

/**
 * Is this region centred on the page rather than aligned to the margin?
 *
 * Displayed mathematics is centred; prose, headings and table rows start at
 * the left margin. This matters because confidence alone misses a *printed*
 * equation made of ordinary glyphs -- Tesseract read "E=mc" with the
 * superscript as a separate line at confidence 80 and 96, so nothing looked
 * wrong, and the equation was silently left as prose.
 */
export function isCentred(box, pageWidth) {
  if (!pageWidth) return false;
  const leftGap = box[0];
  const rightGap = pageWidth - box[2];
  if (leftGap < pageWidth * 0.12) return false;   // at the margin: ordinary text
  return Math.abs(leftGap - rightGap) < pageWidth * 0.18;
}

/**
 * Decide which regions are worth sending to the formula model.
 *
 * A region is nominated when it is tall enough AND either Tesseract found
 * nothing there (an ink block it could not read at all) or what it did find
 * was low-confidence (it tried and failed). Both are the signature of a region
 * a text engine cannot handle. A region that mixes both is carved: the
 * confident text stays text, and only the rest is nominated.
 *
 * Returns { nominated, rejected } so the caller can report what it skipped
 * rather than silently discarding it.
 */
export function nominate(lines, boxes, pageWidth = 0, floor = CONF_FLOOR) {
  const nominated = [];
  const rejected = [];

  for (const box of boxes) {
    if (box[3] - box[1] < MIN_EQUATION_HEIGHT) {
      rejected.push([box, 'too short to be a displayed formula']);
      continue;
    }

    const covering = lines.filter((line) => overlap(box, line.box) >= OVERLAP);
    if (!covering.length) { nominated.push(box); continue; }

    // Prose keeps its ground whatever its confidence: a confident sentence is
    // text, and an unconfident one is a sentence with inline maths, which the
    // text engine reads better than the formula model would. Carve it out
    // FIRST, then judge what is left on its own -- a caption sitting above a
    // formula must not lend the formula its confidence.
    const prose = covering.filter((line) => isProse(line.text));
    const pieces = prose.length ? carve(box, prose) : [box];
    if (!pieces.length) {
      rejected.push([box, 'the region is prose, not displayed maths']);
      continue;
    }

    for (const piece of pieces) {
      const inside = lines.filter((line) => overlap(piece, line.box) >= OVERLAP);
      if (!inside.length) {
        // Ink the text engine did not report at all. Measured on a rendered
        // PDF, Tesseract returned nothing whatsoever for a displayed
        // derivative -- not even garbage -- so "no words here" has to nominate
        // just as loudly as "bad words here".
        nominated.push(piece);
        continue;
      }
      const weakest = Math.min(...inside.map((line) => line.minConf));
      // Centring is measured on the words themselves, not on the region. A
      // region carved out of a merged band keeps the whole band's left and
      // right edges, which hides the fact that the formula inside it is
      // centred -- measured, that is exactly how a printed E = mc^2 under a
      // handwritten caption got missed.
      const words = [Math.min(...inside.map((line) => line.box[0])), 0,
                     Math.max(...inside.map((line) => line.box[2])), 0];
      if (weakest < floor) nominated.push(piece);
      else if (isCentred(words, pageWidth)) {
        // Read confidently, but sitting centred on the page. Printed algebra
        // is made of ordinary glyphs, so Tesseract reads it happily and
        // confidence never dips -- position is the only signal left that this
        // is a displayed formula.
        nominated.push(piece);
      } else {
        rejected.push([piece, `read as text (min conf ${weakest})`]);
      }
    }
  }
  return { nominated, rejected };
}

// Something that makes an expression mathematical rather than a phrase: a
// relation, an operator, or a script.
const MATH_SIGNAL = new RegExp(
  '[=<>^_+]'
  + '|\\\\(?:int|sum|prod|frac|dfrac|sqrt|lim|partial|nabla|cdot|times|div'
  + '|le|ge|neq|approx|equiv|pm|mp|to|rightarrow|infty|begin\\{(?:cases'
  + '|[pbvV]?matrix|align|array))');

/**
 * Did the formula model actually find mathematics, or was it handed prose?
 *
 * Given text, pix2text-mfr returns the letters spaced out inside \mathrm --
 * "1.1 Motivation" came back as `1. 1 \quad \mathrm{M o t i v a t i o n}`. A
 * real expression always carries a relation, an operator or a script, and that
 * is the difference worth testing.
 *
 * Deliberately permissive: anything with a genuine mathematical signal passes.
 */
export function looksLikeEquation(latex) {
  if (!latex || !latex.trim()) return false;
  return MATH_SIGNAL.test(latex);
}

/**
 * Recover prose from what the formula model returns for a line of writing.
 *
 * Handed handwriting, pix2text-mfr answers with the letters spaced out inside
 * `\mathrm{...}` and word gaps marked `~`. That is not an equation, but it
 * *is* a transcription -- and on handwriting it is often the only one, because
 * Tesseract is 95.4% word-error-rate on handwriting and frequently returns
 * nothing at all for a line.
 *
 * So instead of discarding a rejected region, unwrap it. The result is rough
 * (measured: "phigsics" for "physics") and in Python the AI review is what
 * makes it right; here it is flagged uncertain instead, and counted, so the
 * user is told how much of the page to check. Rough text beats a silently
 * missing line.
 */
export function unwrapText(latex) {
  if (!latex) return '';
  let text = latex.replace(/\\(?:mathrm|mathbf|mathit|mathsf|text|operatorname\*?)\s*/g, ' ');
  text = text.replace(/\\qquad|\\quad|\\,|\\;|\\:/g, ' ');
  text = text.split('\\!').join('');
  // '\x00' is the word gap, so it must survive the character-run join below.
  text = text.split('~').join(' \x00 ');
  text = text.replace(/[{}$]/g, ' ');
  text = text.replace(/\\([A-Za-z]+)/g, '$1');
  text = text.split('\\').join(' ');

  const words = [];
  let run = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (token === '\x00') {
      if (run.length) { words.push(run.join('')); run = []; }
    } else if (token.length === 1 && /[0-9A-Za-z]/.test(token)) {
      run.push(token);
    } else {
      if (run.length) { words.push(run.join('')); run = []; }
      words.push(token);
    }
  }
  if (run.length) words.push(run.join(''));
  return words.join(' ').trim();
}

/**
 * Interleave text lines and recognised equations into one ordered document.
 *
 * Equations win any line they overlap: Tesseract also produced output for that
 * region, and it is garbage by construction, so keeping both would duplicate
 * the content in a mangled form. This is why the merge needs no fuzzy text
 * matching to deduplicate -- the boxes say exactly which words came from the
 * formula.
 *
 * Returns a list of items, each { kind: 'text' | 'equation', ... }, in reading
 * order.
 */
export function assemble(lines, equations, floor = CONF_FLOOR) {
  const consumed = new Set();
  for (const item of equations) {
    lines.forEach((line, index) => {
      if (overlap(item.box, line.box) >= OVERLAP) consumed.add(index);
    });
  }

  const items = [];
  lines.forEach((line, index) => {
    if (consumed.has(index)) return;
    items.push({
      kind: 'text', text: line.text, box: line.box,
      block: line.block, par: line.par, minConf: line.minConf,
      // True when no engine read this confidently -- handwriting, usually.
      // Counted into the result as `uncertainLines`, so the user knows how
      // much of the page to check.
      uncertain: Boolean(line.uncertain) || line.minConf < floor,
    });
  });
  for (const item of equations) {
    items.push({ kind: 'equation', latex: item.latex, box: item.box,
                 index: item.index });
  }

  items.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  return items;
}

// ---------------------------------------------------------------------------
// Turning the assembled items into LaTeX
// ---------------------------------------------------------------------------

// A short line in its own paragraph, with no sentence punctuation, sitting
// above other text -- that is what a heading looks like geometrically.
// Tesseract gives no font-size information, so this is the available signal.
const HEADING_MAX_WORDS = 8;
const NUMBERED = /^\d+(\.\d+)*\s/;

function looksLikeHeading(item, bodyHeight) {
  if (item.kind !== 'text') return false;
  const text = item.text.trim();
  if (!text || text.split(/\s+/).length > HEADING_MAX_WORDS) return false;
  if (/[.,;:]$/.test(text)) return false;
  const height = item.box[3] - item.box[1];
  // Either visibly larger than body text, or numbered like a section.
  return height > bodyHeight * 1.15 || NUMBERED.test(text);
}

function headingLevel(text) {
  const match = NUMBERED.exec(text.trim());
  return match && match[0].includes('.') ? 'subsection' : 'section';
}

/**
 * Emit a complete LaTeX document from the assembled items.
 *
 * `escape` is text.js escapeTex, passed in rather than imported so this module
 * stays free of OCR dependencies and can be tested on its own.
 *
 * The structure is deliberately conservative -- paragraphs, headings,
 * displayed equations. Tables and finer structure are what the AI path
 * recovers and this one does not; guessing at them from bounding boxes alone
 * would invent structure that is not there.
 */
export function toTex(items, escape) {
  const textItems = items.filter((i) => i.kind === 'text');
  const heights = textItems.map((i) => i.box[3] - i.box[1]).sort((a, b) => a - b);
  const bodyHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  const hasMath = items.some((i) => i.kind === 'equation');
  const body = [];
  let paragraph = [];
  let previous = null;
  let currentPage = null;

  const flush = () => {
    if (paragraph.length) { body.push(paragraph.join(' ')); paragraph = []; }
  };

  for (const item of items) {
    // A multi-page document arrives as one pooled list of boxes, tagged with
    // the page each came from. Without a break at the seam LaTeX sets it all
    // as continuous copy: a short page pulls the next page's opening lines up
    // to fill it, and everything after that drifts. Items from a single image
    // carry no page number, and need no break.
    const page = item.page;
    if (page !== undefined && page !== null) {
      if (currentPage !== null && page !== currentPage) {
        flush();
        body.push('\\clearpage');
      }
      currentPage = page;
    }

    if (item.kind === 'equation') {
      flush();
      body.push('\\[\n' + item.latex + '\n\\]');
      previous = item;
      continue;
    }

    if (looksLikeHeading(item, bodyHeight)) {
      flush();
      const text = item.text.trim();
      const level = headingLevel(text);
      // Drop the printed number; LaTeX numbers sections itself.
      const stripped = text.replace(NUMBERED, '').trim() || text;
      body.push(`\\${level}{${escape(stripped)}}`);
      previous = item;
      continue;
    }

    // A new Tesseract paragraph starts a new LaTeX paragraph.
    if (previous !== null && previous.kind === 'text') {
      if (item.par !== previous.par || item.block !== previous.block) flush();
    }
    paragraph.push(escape(item.text));
    previous = item;
  }

  flush();

  const packages = ['\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}'];
  if (hasMath) packages.push('\\usepackage{amsmath}');

  return ('\\documentclass{article}\n'
          + packages.join('\n')
          + '\n\\begin{document}\n\n'
          + body.join('\n\n').trim()
          + '\n\n\\end{document}\n');
}
