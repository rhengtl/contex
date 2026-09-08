/**
 * The local converter path -- the browser port of the fallback half of
 * contex/pipeline/run.py (_recognize_regions, analyse_page, _local_document).
 *
 * WHAT THIS IS FOR. When the AI is unavailable, or fails part way through a
 * document, the conversion still has to finish. run.py's rule is that the
 * downgrade is never silent: the user is told this is the lower-quality path
 * and gets to decline it. app.js keeps that promise; nothing here runs until
 * they have said yes.
 *
 * WHAT MOVED, AND WHAT DID NOT. The structure is unchanged, step for step,
 * because the structure is what was measured. Two things are genuinely
 * different and both are consequences of there being no server:
 *
 *   Rasterising    a PDF page reaches the recognisers as pixels via pdf.js,
 *                  where Python used pdf2image and Poppler. Same 200 DPI.
 *
 *   Warming        run.py starts loading the formula model in a background
 *                  thread while page one is being read, because the load is
 *                  13.6 seconds and would otherwise land mid-conversion.
 *                  warm() does the same with a promise nobody awaits -- and
 *                  here it is worth more, because the load is a 42 MiB
 *                  download rather than a disk read.
 *
 * ONE THING IS GONE, and it is the important one to be honest about. In Python
 * the AI review sits behind this path and repairs what it produces. Here there
 * is no AI -- its absence is the reason this is running -- so what the
 * recognisers say is what the user gets, flagged and counted rather than
 * corrected. See `uncertainLines` in the summary, and the notice app.js shows.
 */

import * as preprocess from '/recognise/preprocess.js';
import * as segment from '/recognise/segment.js';
import * as text from '/recognise/text.js';
import * as formulas from '/recognise/formulas.js';
import * as assemble from '/latex/assemble.js';
import { sanitiseMath } from '/latex/repair.js';
import { rasterise } from '/preview.js';

/**
 * Begin loading both recognisers without waiting for either.
 *
 * Only called once the fallback is certain. On the AI path they are never
 * needed, and fetching 50 MiB to use none of it is the kind of thing a user on
 * a phone notices.
 */
let warming = null;
export function warm(onProgress) {
  if (!warming) {
    warming = Promise.allSettled([
      text.load({ onProgress }),
      formulas.load({ onProgress }),
    ]);
  }
  return warming;
}

/** True when both engines are already in memory. */
export function ready() { return text.ready() && formulas.ready(); }

/** Reset the warm-up memo. Tests use it; nothing in the app does. */
export function reset() { warming = null; }

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

/** Crop a box out of a canvas, for handing one region to the formula model. */
function crop(canvas, [left, top, right, bottom]) {
  const width = Math.max(1, Math.round(right - left));
  const height = Math.max(1, Math.round(bottom - top));
  const out = preprocess.makeCanvas(width, height);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, Math.round(left), Math.round(top), width, height,
                0, 0, width, height);
  return out;
}

/**
 * Did the decoder get stuck rather than read something?
 *
 * A guard formulas.py does not have, added because the fallback suite caught
 * what it is for. On a heavily degraded photograph the greedy decode fell into
 * a cycle and returned `\sin\theta` twenty-four times; unwrapText() duly
 * recovered "sin theta sin theta cos theta sin theta..." and assemble() put
 * that in the document as a line of prose the page did not contain.
 *
 * Greedy decoding loops -- that is a property of the algorithm, not of this
 * page -- and a loop is recognisable without knowing anything about the
 * content: a real sentence does not spend three quarters of its words on three
 * distinct tokens. Salvage is a best effort, so declining to salvage is always
 * an available answer; inventing a sentence is not.
 */
function looksLikeLoop(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  return new Set(words).size / words.length <= 0.25;
}

/**
 * Run the formula model over the nominated crops, in reading order.
 *
 * Returns { found, salvaged } where `salvaged` holds regions that turned out
 * not to be mathematics. Those must never simply be dropped: when the text
 * engine also read nothing there -- which is routine for handwriting --
 * discarding the region deletes a line of the document outright. Measured on a
 * handwritten page, exactly that happened to "This idea changed how physics
 * was understood."
 */
async function recogniseRegions(page, masked, boxes, lines, { signal, onProgress } = {}) {
  const found = [];
  const salvaged = [];
  const dropped = [];

  for (const [index, box] of boxes.entries()) {
    if (signal && signal.aborted) break;
    if (onProgress) onProgress(`Reading equation ${index + 1} of ${boxes.length}…`);
    let latex = '';
    let tight = box;
    try {
      tight = segment.tighten(masked, box);
      const result = await formulas.recognise(crop(page, tight), { signal });
      latex = result.latex;
    } catch (err) {
      console.warn('Notice: formula recognition failed for one region:', err);
      continue;
    }
    if (!latex) continue;

    if (assemble.looksLikeEquation(latex)) {
      // The one place arbitrary LaTeX enters a document this app compiles: an
      // expression is inserted verbatim, because escaping it would destroy it.
      // Screened before it becomes part of anything. See latex/repair.js.
      const safe = sanitiseMath(latex);
      if (!safe.ok) {
        console.warn(`Notice: an expression was dropped (${safe.reason}).`);
        dropped.push(safe.reason);
        continue;
      }
      found.push({ index: found.length + 1, latex: safe.latex, box: tight });
      continue;
    }

    // Not mathematics. If the text engine read this region, its answer stands
    // and there is nothing to salvage. If it did not, the formula model's
    // reading is all we have.
    const covered = lines.some((line) => assemble.overlap(tight, line.box) >= 0.5);
    if (covered) continue;
    const recovered = assemble.unwrapText(latex);
    if (recovered && !looksLikeLoop(recovered)) {
      salvaged.push({ text: recovered, box: tight, uncertain: true });
    }
  }
  return { found, salvaged, dropped };
}

/**
 * Run both recognisers over one already-conditioned page.
 *
 * Returns { items, equations, notes } where `items` is the interleaved reading
 * order produced by assemble().
 *
 * Neither engine failing is fatal, and that is deliberate rather than
 * defensive: a page with only prose on it converts perfectly well without the
 * formula model, and a page of pure mathematics converts without the text one.
 * Losing both is what makes a page unreadable, and even then the other pages
 * of the document survive.
 */
export async function analysePage(page, { signal, onProgress } = {}) {
  const notes = [];
  let lines = [];

  try {
    if (onProgress) onProgress('Reading the text…');
    lines = await text.extractLines(page, { onProgress });
  } catch (err) {
    console.warn('Notice: text extraction failed:', err);
    notes.push('The text engine could not read this page.');
  }

  const grey = preprocess.greyscale(preprocess.pixelsOf(page));
  const masked = segment.inkMask(grey, page.width, page.height);

  let equations = [];
  let salvaged = [];
  let formulaModel = formulas.ready();
  if (!formulaModel) {
    try { await formulas.load({ onProgress }); formulaModel = true; } catch (err) {
      console.warn('Notice: the formula model could not be loaded:', err);
    }
  }

  if (formulaModel) {
    const boxes = segment.segmentBoxes(masked, { allowEmpty: true });
    const { nominated } = assemble.nominate(lines, boxes, page.width);
    const read = await recogniseRegions(page, masked, nominated, lines,
                                        { signal, onProgress });
    equations = read.found;
    salvaged = read.salvaged;
    if (read.dropped.length) {
      notes.push(`${read.dropped.length} recognised expression(s) were rejected `
                 + 'as unusable and left out.');
    }
  } else {
    notes.push('The formula model is not loaded, so equations were not '
               + 'recognised separately on this page.');
  }

  // Lines the text engine could not read at all, recovered from the formula
  // model. Rough, and flagged as such: the flag is what the result counts as
  // `uncertainLines`, so the user is told how much of the page is a guess.
  for (const item of salvaged) {
    lines.push({ text: item.text, box: item.box, minConf: 0, meanConf: 0,
                 block: 0, par: 0, line: 0, uncertain: true });
  }
  if (salvaged.length) {
    notes.push(`${salvaged.length} line(s) could not be read by the text engine `
               + 'and were recovered approximately.');
  }

  return { items: assemble.assemble(lines, equations), equations, notes };
}

// ---------------------------------------------------------------------------
// A whole document
// ---------------------------------------------------------------------------

/**
 * A unit's bytes as conditioned pages.
 *
 * Plural, because a unit is not always one page. aiUnits() splits a PDF into
 * one single-page unit each, but a PDF that pdf-lib will not split arrives
 * whole -- and treating that as one page dropped everything after the first.
 */
async function pagesOf(unit) {
  if ((unit.mime || '').includes('pdf') || /\.pdf$/i.test(unit.name || '')) {
    const canvases = await rasterise(unit.bytes);
    return canvases.map((canvas) => preprocess.prepare(canvas, {}));
  }
  const decoded = await preprocess.decodeImage(unit.bytes, { type: unit.mime });
  return [preprocess.prepare(decoded.canvas, { transparent: decoded.transparent })];
}

/**
 * Convert units with the local recognisers only.
 *
 * Returns { tex, equations, items, notes }. Used both for a whole document and
 * for the tail of one whose AI conversion stopped part way, which is why the
 * page and equation numbering start where the caller says rather than at one.
 */
export async function localDocument(units, { firstNumber = 1, equationOffset = 0,
                                             signal, onProgress } = {}) {
  const allItems = [];
  const allEquations = [];
  const notes = [];
  let offset = 0;
  let number = firstNumber - 1;

  for (const unit of units) {
    if (signal && signal.aborted) break;

    // Opening the unit is its own failure: a unit that will not decode costs
    // no page numbers, because it produced none.
    let prepared;
    try {
      prepared = await pagesOf(unit);
    } catch (err) {
      number += 1;
      console.warn(`Notice: page ${number} could not be opened:`, err);
      notes.push(`Page ${number} could not be read and was skipped.`);
      continue;
    }

    for (const { canvas: page, notes: pageNotes } of prepared) {
      if (signal && signal.aborted) break;
      number += 1;
      const at = number;
      const say = (message) => {
        if (onProgress) onProgress(`Page ${at}: ${message}`);
      };

      let items;
      let equations;
      try {
        notes.push(...pageNotes.map((note) => `Page ${at}: ${note}`));
        const analysed = await analysePage(page, { signal, onProgress: say });
        items = analysed.items;
        equations = analysed.equations;
        notes.push(...analysed.notes.map((note) => `Page ${at}: ${note}`));
      } catch (err) {
        // One page that will not convert must not cost the caller the pages
        // that already did. Record it and carry on.
        console.warn(`Notice: page ${at} could not be converted:`, err);
        notes.push(`Page ${at} could not be read and was skipped.`);
        continue;
      }

      // Shift every box down by the pages already seen, so a multi-page
      // document sorts into one continuous reading order.
      for (const item of items) {
        const box = item.box;
        item.box = [box[0], box[1] + offset, box[2], box[3] + offset];
        item.page = at;
      }
      for (const item of equations) {
        item.index = equationOffset + allEquations.length + 1;
        item.page = at;
        allEquations.push(item);
      }
      allItems.push(...items);
      offset += page.height;
    }
  }

  return {
    tex: assemble.toTex(allItems, text.escapeTex),
    equations: allEquations,
    items: allItems,
    notes,
  };
}
