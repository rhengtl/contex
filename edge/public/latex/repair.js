/**
 * Repairing a document nobody can ask a model to fix.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT AN API CALL. run.py's fallback ends at
 * `_compile_only()`, and the comment there is the whole argument:
 *
 *     Local validation only. Reaching here means the AI is either switched off
 *     or has just failed, and asking a dead service to repair the document
 *     would spend the full retry backoff to arrive at the same answer - on
 *     exactly the path where the user is already waiting longer than usual.
 *
 * So the QA step on this path has to be something the browser can do alone.
 * That rules out anything that needs to understand the document, and rules IN
 * exactly the class of faults this path actually produces -- which is a short
 * and very specific list, because almost everything the local converter emits
 * is written by assemble.js and is correct by construction.
 *
 * THE ONE UNTRUSTED THING IS THE MATHEMATICS. Everything the local path writes
 * as prose goes through escapeTex(), which turns a backslash into
 * \textbackslash{}. But a recognised formula is inserted between \[ and \]
 * *verbatim*, because escaping it would destroy it -- that is the entire point
 * of recognising it. pix2text-mfr's output is therefore the one place where
 * arbitrary LaTeX enters a document this app compiles, and it is not a
 * trustworthy writer: it is a 20M-parameter model that has been handed a photo
 * and, on a bad region, will emit an unclosed \left, a stray brace, half a
 * \begin{matrix}, or a control word that happens to be in its vocabulary.
 *
 * sanitiseMath() is that boundary. It runs on every expression BEFORE it
 * becomes part of a document, and it is a screen rather than a rewriter: an
 * expression that reaches outside the document is dropped whole, not patched.
 * repair() is the document-level pass behind it, for what survives.
 *
 * NEITHER IS THE LAST LINE OF DEFENCE. compile() refuses an unsafe construct
 * before the engine is even loaded, and validate.js is run on the finished
 * document either way. This is a repair, not a gate; the gate is downstream
 * and stays there.
 */

import { staticValidate, unsafeConstructs } from '/latex/validate.js';

/** Brace depth, ignoring escaped braces. Returns { unmatchedOpen, strayClose }. */
function braceBalance(source) {
  let depth = 0;
  let stray = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }      // \{ and \} are literals
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) stray += 1; else depth -= 1;
    }
  }
  return { unmatchedOpen: depth, strayClose: stray };
}

/** Drop closing braces that never had an opener. */
function dropStrayCloses(source) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { out.push(source.slice(i, i + 2)); i += 1; continue; }
    if (ch === '{') { depth += 1; out.push(ch); continue; }
    if (ch === '}') {
      if (depth === 0) continue;                 // nothing to close
      depth -= 1;
      out.push(ch);
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

const COUNT_LEFT = /\\left(?![a-zA-Z])/g;
const COUNT_RIGHT = /\\right(?![a-zA-Z])/g;

function countOf(source, pattern) {
  return (source.match(pattern) || []).length;
}

// Commands that belong to a numbered equation environment and are a FATAL
// error inside \[ ... \]. The model emits \tag most often, and it emits it for
// a good reason: it can see the "(2)" printed beside the equation and is
// transcribing it. Measured on a rendered page of Fourier transforms, that
// produced `\tag * { \omega } ( 2 )`, which validates structurally -- braces
// and delimiters all balance -- and then fails the compile with "Missing $
// inserted". Stripped rather than kept: a tag carries no content, LaTeX
// numbers equations itself, and the alternative is a document that will not
// build.
const EQUATION_ONLY = /\\(?:tag|label)\s*\*?\s*\{[^}]*\}|\\(?:notag|nonumber)(?![a-zA-Z])/g;

/**
 * Is there a `\\` or `&` outside every environment in this expression?
 *
 * Both are fatal in a bare display: `\[ a \\ b \]` is "Missing $ inserted" and
 * a stray `&` is "Misplaced alignment tab". Inside an array, matrix or cases
 * they are ordinary, so the question is about nesting rather than presence.
 */
function hasTopLevelAlignment(source) {
  let depth = 0;
  for (const m of source.matchAll(/\\begin\s*\{[^}]*\}|\\end\s*\{[^}]*\}|\\\\|&/g)) {
    const token = m[0];
    if (token.startsWith('\\begin')) depth += 1;
    else if (token.startsWith('\\end')) depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
  }
  return false;
}

/** Environments opened and not closed, innermost last. */
function openEnvironments(source) {
  const stack = [];
  for (const m of source.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    const env = m[2].trim();
    if (m[1] === 'begin') stack.push(env);
    else if (stack.length && stack[stack.length - 1] === env) stack.pop();
    else if (stack.length) stack.pop();          // mismatched: closes something
  }
  return stack;
}

/**
 * Make one recognised expression safe to place in a document.
 *
 * Returns { latex, ok, reason }. `ok: false` means the expression is dropped
 * rather than fixed -- the caller keeps the region as an unread one, which is
 * the same thing that happens when the model returns nothing at all.
 *
 * Dropping rather than sanitising is deliberate. A formula that contains
 * \input is not a formula with a mistake in it; it is a region the model
 * misread badly enough to emit a file-reading primitive, and whatever the
 * right transcription was, it was not that. Editing it would leave a
 * plausible-looking expression that is certainly wrong.
 */
export function sanitiseMath(latex) {
  let source = (latex || '').trim();
  if (!source) return { latex: '', ok: false, reason: 'empty' };

  // 1. Reaching outside the document. Dropped whole, never patched.
  const unsafe = unsafeConstructs(source);
  if (unsafe.length) {
    return { latex: '', ok: false, reason: `unsafe construct: ${unsafe.join(', ')}` };
  }

  // 2. A math shift inside \[ ... \] closes the display and everything after
  //    it is set as text. The model emits one occasionally around a
  //    sub-expression it was unsure of.
  if (source.includes('$')) source = source.split('$').join('');

  // 3. A comment character would swallow the \] that closes the display. The
  //    model has no reason to emit one and the document has no use for it.
  if (source.includes('%')) source = source.split('%').join('\\%');

  // 4. Braces. Stray closes go; unclosed opens are closed at the end, which is
  //    where TeX would have wanted them for a superscript or a \frac argument.
  const balance = braceBalance(source);
  if (balance.strayClose) source = dropStrayCloses(source);
  const after = braceBalance(source);
  if (after.unmatchedOpen) source += '}'.repeat(after.unmatchedOpen);

  // 5. \left without \right is a fatal TeX error rather than a cosmetic one.
  //    '\right.' is the empty delimiter, so the expression keeps its shape.
  const left = countOf(source, COUNT_LEFT);
  const right = countOf(source, COUNT_RIGHT);
  if (left > right) source += '\\right.'.repeat(left - right);
  else if (right > left) source = '\\left.'.repeat(right - left) + source;

  // 6. Environments. \begin{matrix} with no \end is the common one, from a
  //    matrix whose bottom row fell outside the crop.
  const open = openEnvironments(source);
  for (const env of open.slice().reverse()) source += `\\end{${env}}`;

  // 7. Commands that only exist inside a numbered equation environment.
  if (EQUATION_ONLY.test(source)) {
    EQUATION_ONLY.lastIndex = 0;
    source = source.replace(EQUATION_ONLY, ' ');
  }
  EQUATION_ONLY.lastIndex = 0;

  // 8. Line breaks and alignment tabs need an environment to live in. The
  //    model produces them for a multi-line derivation it read as one region,
  //    and the transcription is right -- it is the container that is missing.
  //    `aligned` is amsmath's, and toTex() loads amsmath whenever there is any
  //    mathematics at all, so it is always available where this is needed.
  if (hasTopLevelAlignment(source)) {
    source = `\\begin{aligned}${source}\\end{aligned}`;
  }

  source = source.trim();
  if (!source) return { latex: '', ok: false, reason: 'nothing left' };
  return { latex: source, ok: true, reason: '' };
}

/**
 * Validate an assembled document and repair it if it will not build --
 * ai.finalise_document()'s job, done locally.
 *
 * Returns { tex, fixes, issues }: the document, what was changed, and whatever
 * still does not validate. Never throws and never returns nothing: a document
 * that cannot be repaired is still the user's document, and the caller offers
 * the .tex either way.
 *
 * Bounded on purpose. This fixes structure and only structure -- it does not
 * know what the page said, so it cannot invent content, and it must not try.
 */
export function repair(tex) {
  const fixes = [];
  const source = tex || '';
  if (!source.trim()) return { tex: source, fixes, issues: staticValidate(source) };

  const before = staticValidate(source);
  if (!before.length) return { tex: source, fixes, issues: [] };

  // Everything below works on the body; the preamble is ours and is correct.
  const match = source.match(/^([\s\S]*\\begin\{document\})([\s\S]*?)(\\end\{document\}[\s\S]*)$/);
  if (!match) {
    // No skeleton at all. Nothing here can invent one safely -- wrapping a
    // fragment whose preamble we cannot see would produce a document that
    // fails differently.
    return { tex: source, fixes, issues: before };
  }
  let [, head, body, tail] = match;

  const strays = braceBalance(body);
  if (strays.strayClose) {
    body = dropStrayCloses(body);
    fixes.push(`Removed ${strays.strayClose} unmatched closing brace(s).`);
  }

  const open = openEnvironments(body);
  if (open.length) {
    for (const env of open.slice().reverse()) body += `\n\\end{${env}}`;
    fixes.push(`Closed ${open.length} unclosed environment(s): ${open.join(', ')}.`);
  }

  const depth = braceBalance(body).unmatchedOpen;
  if (depth) {
    body += '}'.repeat(depth);
    fixes.push(`Closed ${depth} unclosed brace(s).`);
  }

  const left = countOf(body, COUNT_LEFT);
  const right = countOf(body, COUNT_RIGHT);
  if (left > right) {
    body += '\\right.'.repeat(left - right);
    fixes.push(`Balanced ${left - right} \\left without \\right.`);
  } else if (right > left) {
    body = '\\left.'.repeat(right - left) + body;
    fixes.push(`Balanced ${right - left} \\right without \\left.`);
  }

  // \[ and \] are written in pairs by assemble.js, so an imbalance means a
  // page whose equation body contained one. Close the display rather than
  // leaving the rest of the document set as mathematics.
  const opens = countOf(body, /\\\[/g);
  const closes = countOf(body, /\\\]/g);
  if (opens > closes) {
    body += '\n\\]'.repeat(opens - closes);
    fixes.push(`Closed ${opens - closes} unterminated display equation(s).`);
  }

  // An odd number of '$' leaves the rest of the document in maths.
  const dollars = (body.replace(/\\\$/g, '').match(/\$/g) || []).length;
  if (dollars % 2 === 1) {
    body += '$';
    fixes.push('Closed an unterminated inline equation.');
  }

  const repaired = head + body + tail;
  const after = staticValidate(repaired);

  // Keep the repair only if it actually helped. A pass that leaves the
  // document no better off should leave it unchanged, so what the user
  // downloads is what the recognisers produced.
  if (after.length >= before.length) {
    return { tex: source, fixes: [], issues: before };
  }
  return { tex: repaired, fixes, issues: after };
}
