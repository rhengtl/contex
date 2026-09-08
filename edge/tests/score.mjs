/**
 * bench/score_qa.py and bench/score_math.py, ported.
 *
 * The point of porting rather than inventing: a browser pipeline scored with a
 * different metric from the Python one cannot be compared to it, and comparing
 * them is the entire question Stage 4 has to answer. These are the same
 * functions, so the numbers are the same numbers.
 *
 * The first run of the formula suite is the cautionary tale. It reported 69%
 * for a model the very same corpus scores at 93%, because it compared raw
 * strings and score_math.py has always collapsed `{x}` -> `x` first. The
 * measurement was wrong, not the model.
 */

/** score_math.py normalize(), character for character. */
export function normalize(t) {
  let s = (t || '').trim().replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/\\dfrac|\\tfrac/g, '\\frac');
  s = s.replace(/\\left|\\right|\\quad|\\qquad|\\,|\\;|\\!|\\:/g, ' ');
  s = s.replace(/\\operatorname\s*\{([^}]*)\}/g, '\\$1');
  s = s.replace(/\{\s*([A-Za-z0-9])\s*\}/g, '$1');
  s = s.replace(/\s+/g, '');
  return s;
}

/** score_math.py lev(), over strings or over token arrays. */
export function lev(a, b) {
  if (a.length === b.length && String(a) === String(b)) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

const STRUCTURE = {
  section: /\\section\b/g,
  subsection: /\\subsection\b/g,
  itemize: /\\begin\{itemize\}/g,
  enumerate: /\\begin\{enumerate\}/g,
  item: /\\item\b/g,
  tabular: /\\begin\{tabular\}/g,
  display: /\\\[|\\begin\{(?:equation|align|gather|multline)\*?\}/g,
  frac: /\\frac\b/g,
  int: /\\int\b/g,
  sqrt: /\\sqrt\b/g,
};

const MATH_PATTERNS = [
  /\$\$([\s\S]+?)\$\$/g,
  /\$([\s\S]+?)\$/g,
  /\\\[([\s\S]+?)\\\]/g,
  new RegExp('\\\\begin\\{(?:equation\\*?|align\\*?|gather\\*?|multline\\*?)\\}'
             + '([\\s\\S]+?)\\\\end\\{(?:equation\\*?|align\\*?|gather\\*?'
             + '|multline\\*?)\\}', 'g'),
];

export function bodyOf(tex) {
  const m = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(tex || '');
  return m ? m[1] : (tex || '');
}

/** The prose a reader would see, with markup and mathematics removed. */
export function plainText(tex) {
  let body = bodyOf(tex);
  body = body.replace(/\\begin\{[\s\S]*?\}|\\end\{[\s\S]*?\}/g, ' ');
  for (const pattern of MATH_PATTERNS) body = body.replace(pattern, ' ');
  body = body.replace(/\\[a-zA-Z@]+\*?/g, ' ');
  body = body.replace(/[{}$&\\~^_#]/g, ' ');
  body = body.replace(/%.*/g, ' ');
  return body.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

export function textScore(gtTex, predTex) {
  const gt = plainText(gtTex);
  const pred = plainText(predTex);
  if (!gt) return null;
  return Math.max(0, 1 - lev(gt, pred) / gt.length);
}

export function structureScore(gtTex, predTex) {
  const gtBody = bodyOf(gtTex);
  const predBody = bodyOf(predTex);
  let total = 0;
  let hit = 0;
  for (const [, pattern] of Object.entries(STRUCTURE)) {
    const g = (gtBody.match(pattern) || []).length;
    const p = (predBody.match(pattern) || []).length;
    total += g;
    hit += Math.min(g, p);
  }
  return total ? hit / total : null;
}

/** Pairwise character accuracy over the page's mathematics. */
export function mathScore(gtTex, predTex) {
  const expressions = (tex) => {
    const body = bodyOf(tex);
    const found = [];
    for (const pattern of MATH_PATTERNS) {
      for (const m of body.matchAll(pattern)) {
        const expression = normalize(m[1]);
        if (expression) found.push(expression);
      }
    }
    return found;
  };

  const gt = expressions(gtTex);
  const remaining = expressions(predTex);
  if (!gt.length) return null;

  let errors = 0;
  let chars = 0;
  for (const expression of gt) {
    chars += expression.length;
    if (!remaining.length) { errors += expression.length; continue; }
    let bestIndex = 0;
    let bestCost = null;
    remaining.forEach((candidate, index) => {
      const cost = lev(expression, candidate);
      if (bestCost === null || cost < bestCost) { bestIndex = index; bestCost = cost; }
    });
    errors += bestCost;
    remaining.splice(bestIndex, 1);
  }
  return chars ? Math.max(0, 1 - errors / chars) : 1.0;
}

export const pct = (v) => (v === null || v === undefined ? '    n/a'
  : `${(v * 100).toFixed(2).padStart(6)}%`);
