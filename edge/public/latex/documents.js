/**
 * Assembling one LaTeX document out of several.
 * A direct port of contex/pipeline/latex/documents.py.
 *
 * A PDF is converted a page at a time -- see pipeline/run.py for why -- so the
 * pipeline ends up holding one complete document per page and has to splice
 * them into one. That is a text operation on LaTeX source: take the union of
 * the preambles, concatenate the bodies, and keep each page's local settings
 * from leaking into the next.
 *
 * Separate from compile.js because this is authoring, not compiling: it
 * decides what the document says, and never runs anything.
 *
 * PORTING NOTES. Python's re.MULTILINE and JavaScript's /m agree on what ^ and
 * $ mean, and neither lets `.` cross a newline without the DOTALL/`s` flag --
 * so the patterns below are the same patterns. Two idioms needed a second
 * form: Python's `pattern.match(line)` anchors at the start of the string,
 * which JS spells with its own anchored regex (the _AT variants), and a
 * global regex in JS carries lastIndex, so anything used with .test() is
 * deliberately non-global.
 */

const DOCUMENTCLASS = /^\s*\\documentclass\b.*$/m;
const BODY = /\\begin\{document\}([\s\S]*?)\\end\{document\}/;
const TITLE_MACROS = /^\s*\\(?:title|author|date|maketitle)\b.*$/m;
const TITLE_MACROS_G = /^\s*\\(?:title|author|date|maketitle)\b.*$/gm;
const TITLE_MACROS_AT = /^\s*\\(?:title|author|date|maketitle)\b.*$/;

// What separates one source page from the next in a joined document.
const PAGE_BREAK = '\n\n\\clearpage\n\n';

// Styling that describes one page and must not outlive it. \pagecolor is the
// reason this exists: LaTeX applies it to every page from that point on, so a
// navy page one turns the whole document navy while only page one carries the
// light text meant to sit on it -- white on white from page two onward.
// \definecolor is deliberately not here: naming a colour is harmless, and the
// pages that use the name need it to stay in the preamble.
const PAGE_STYLE = /^\s*\\(?:pagecolor|nopagecolor|color|normalcolor)\b.*$/m;
const PAGE_STYLE_AT = /^\s*\\(?:pagecolor|nopagecolor|color|normalcolor)\b.*$/;

// A body that defines macros must not be wrapped in a group: the definition
// would be scoped away and every later page using it would fail to compile.
const MACRO_DEF = /\\(?:new|renew|provide)command|\\def\b|\\newenvironment/;

const XCOLOR = /\\usepackage[^{]*\{[^}]*\bxcolor\b[^}]*\}/;
const COLOR_PACKAGE = /\\usepackage[^{]*\{[^}]*\bx?color\b[^}]*\}/;

// Python's str.splitlines() breaks on a lone \r as well as \n; JS's split('\n')
// does not. Every line is right-stripped afterwards, so the only case this
// actually changes is a classic-Mac line ending, but matching it is free.
const LINES = /\r\n|[\n\r]/;

const rstrip = (s) => s.replace(/\s+$/, '');

/**
 * Return [documentclassLine, preambleLines, body] for one document.
 *
 * A document with no \begin{document} at all is treated as a bare body, which
 * is what a model occasionally returns when a page holds nothing but formulas.
 */
export function splitDocument(tex) {
  const text = tex || '';
  const match = DOCUMENTCLASS.exec(text);
  const documentclass = match ? match[0].trim() : '';

  const bodyMatch = BODY.exec(text);
  if (!bodyMatch) return [documentclass, [], text.trim()];

  const body = bodyMatch[1].trim();
  let head = text.slice(0, bodyMatch.index);
  // Index into `text`, applied to `head` -- exactly as documents.py does it.
  // When the documentclass line sits past the head this yields '', which is
  // the same answer for the same reason.
  if (match) head = head.slice(match.index + match[0].length);
  const preamble = head.split(LINES).filter((l) => l.trim()).map(rstrip);
  return [documentclass, preamble, body];
}

/**
 * What has to be undone at a page boundary, or '' when nothing does.
 *
 * Grouping restores the text colour on its own, but a page background is
 * global by design and has to be turned off explicitly.
 */
function pageReset(preambleText, bodyText) {
  if (!PAGE_STYLE.test(bodyText) && !PAGE_STYLE.test(preambleText)) return '';
  if (XCOLOR.test(preambleText)) {
    // xcolor's own "no background at all", rather than painting white over
    // whatever the page would otherwise show.
    return '\\nopagecolor\\normalcolor';
  }
  if (COLOR_PACKAGE.test(preambleText)) return '\\pagecolor{white}\\normalcolor';
  return '\\normalcolor';
}

/** One page's body, with its formatting confined to that page. */
function scoped(body) {
  if (MACRO_DEF.test(body)) {
    // A definition is not formatting: scoping it away would break every later
    // page that uses it, so this body is left ungrouped.
    return body;
  }
  return '\\begingroup\n' + body + '\n\\endgroup';
}

/**
 * Splice per-page LaTeX documents into one.
 *
 * Converting a multi-page PDF page by page is what lets a conversion survive
 * losing the AI half way through: the pages already done keep their AI output
 * and only the remainder falls back. The cost is that each page arrives as its
 * own complete document, so the preambles have to be reconciled rather than
 * concatenated -- four copies of \usepackage{amsmath} compiles with warnings
 * at best, and four \maketitle calls is three spurious title pages.
 *
 * Package and macro lines are unioned in first-seen order; title macros are
 * kept from the first document that has them and dropped from the rest.
 */
export function mergeDocuments(documents) {
  const kept = (documents || []).filter((doc) => (doc || '').trim());
  if (!kept.length) return '';
  if (kept.length === 1) return kept[0];

  let documentclass = '';
  const preamble = [];
  const seen = new Set();
  const bodies = [];
  let haveTitle = false;

  for (const document of kept) {
    const [thisClass, lines, rawBody] = splitDocument(document);
    if (!documentclass && thisClass) documentclass = thisClass;

    const pageStyle = [];
    for (const line of lines) {
      if (haveTitle && TITLE_MACROS_AT.test(line)) continue;
      if (PAGE_STYLE_AT.test(line)) {
        // A background set in this page's preamble describes this page. Left
        // in the shared preamble it would describe all of them, so it moves
        // into the body it belongs to.
        pageStyle.push(line.trim());
        continue;
      }
      const key = line.split(/\s+/).filter(Boolean).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      preamble.push(line);
    }

    let body = rawBody;
    if (body && haveTitle) {
      body = body.replace(TITLE_MACROS_G, '').trim();
    }
    body = pageStyle.concat(body ? [body] : []).join('\n');
    if (body.trim()) bodies.push(body);
    if (TITLE_MACROS.test(document)) haveTitle = true;
  }

  const parts = [documentclass || '\\documentclass{article}'];
  parts.push(...preamble);
  parts.push('', '\\begin{document}', '');
  // One source page per output page. Without a break here LaTeX sets the
  // bodies as continuous copy, so a short page pulls the next page's opening
  // lines up to fill it and every page after that drifts. \clearpage rather
  // than \newpage: it also flushes pending floats, so a figure from one page
  // cannot be deferred onto a later one.
  //
  // The reset goes after the break, never before it, so the page that asked
  // for a background still gets it and only the pages after it are spared.
  const reset = pageReset(preamble.join('\n'), bodies.join('\n\n'));
  const separator = reset ? ('\n\n\\clearpage\n' + reset + '\n\n') : PAGE_BREAK;
  parts.push(bodies.map(scoped).join(separator));
  parts.push('', '\\end{document}', '');
  return parts.join('\n');
}
