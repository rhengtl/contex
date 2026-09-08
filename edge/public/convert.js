/**
 * One conversion, end to end -- the browser port of contex/pipeline/run.py's
 * convert() and _convert_pages().
 *
 * WHY IT IS ITS OWN MODULE. This is the part of the app with real decisions in
 * it: whether the AI is available, whether the user has agreed to do without
 * it, which pages the model converted before it stopped, and what to tell them
 * afterwards. In app.js those decisions were tangled with element ids, and a
 * pipeline whose failure modes can only be exercised by clicking is a pipeline
 * whose failure modes are not tested. Everything here takes its I/O through
 * `api` and reports through `ui`, so tests/fallback.mjs can run the whole
 * thing against a Gemini that is down, rate-limited, or dies on page three.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP. run.py:
 *
 *     `allow_fallback` is the user's answer to the warning shown when the AI
 *     is known to be unavailable. Without it this raises FallbackNotAuthorized
 *     rather than quietly returning a lower-quality document - the user gets
 *     to decide whether to wait for the service or accept the local
 *     converters.
 *
 * A degraded conversion is never silent, and never a surprise. It is offered,
 * accepted, and then said again on the finished document.
 */

import { mergeDocuments } from '/latex/documents.js';
import { staticValidate } from '/latex/validate.js';
import { repair } from '/latex/repair.js';
import * as local from '/recognise/local.js';

/**
 * The AI is unavailable and the user has not agreed to the local fallback.
 *
 * Thrown instead of quietly producing a lower-quality document. Carries the
 * status report, so the caller can say which service is down and whether a
 * recovery time is known.
 */
export class FallbackNotAuthorized extends Error {
  constructor(status) {
    super(status?.message || status?.reason || 'AI conversion is unavailable.');
    this.name = 'FallbackNotAuthorized';
    this.status = status || {};
  }
}

/**
 * The one message the user gets about a degraded conversion -- run.py _notice.
 *
 * Exactly one of these ever reaches a result, and it is shown once, on the
 * finished document, not while the conversion is running. Someone watching a
 * progress bar cannot act on "the AI just stopped"; someone about to use the
 * output can, and that is the moment the warning is worth something.
 *
 * Structured rather than prose so the page can lead with the headline and keep
 * the reason as secondary text, instead of one long paragraph nobody reads to
 * the end of.
 */
export function notice({ headline, detail, reason = '', fromPage = 1,
                         totalPages = 1, partial = false }) {
  return {
    headline, detail, reason: (reason || '').trim(), fromPage, totalPages,
    // True when the document is short of content, not merely lower quality --
    // a different and more serious thing to tell someone.
    partial,
  };
}

/** ai.py fenced_latex(), ported. Prefers the last block that is a document. */
export function fencedLatex(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:latex|tex)?\s*\n([\s\S]*?)```/g)]
    .map((m) => m[1]);
  if (fenced.length) {
    for (let i = fenced.length - 1; i >= 0; i--) {
      if (fenced[i].includes('\\documentclass') ||
          fenced[i].includes('\\begin{document}')) return fenced[i].trim();
    }
    return fenced[fenced.length - 1].trim();
  }
  const m = text.match(/(\\documentclass[\s\S]*?\\end\{document\})/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// The model chain
// ---------------------------------------------------------------------------

/**
 * One conversion's journey through the model chain -- ai.py Rotation.
 *
 * A round is one conversion, however many pages it has. It opens on the
 * preferred model and stays there; when that model reports itself out of quota
 * the round advances and stays advanced for the remaining pages, rather than
 * re-probing an exhausted model once per page. A new conversion builds a new
 * round and opens on the preferred model again.
 */
export class Rotation {
  constructor() { this.attempt = 0; this.exhausted = false; this.fatal = ''; }
  advance(to) {
    if (to === null || to === undefined) { this.exhausted = true; return; }
    this.attempt = Math.max(this.attempt, to);
  }
}

/**
 * One page through the Worker.
 *
 * `rotation` is the real round when a quota error is to be believed, and a
 * throwaway one during the speculative concurrent pass -- where a 429 caused
 * by our own burst must not retire a model the service would serve happily one
 * request at a time.
 */
export async function convertOne(unit, rotation, api,
                                 { speculative = false, onStatus } = {}) {
  // Raw bytes, not base64. The Worker pipes them into the Gemini Files API
  // untouched and then writes the generateContent JSON itself, so there is
  // nothing here to encode -- and nothing a payload could break out of.
  const body = unit.bytes instanceof Uint8Array
    ? unit.bytes : new Uint8Array(unit.bytes);
  let attempt = rotation.attempt;
  let thinking = true;

  for (let guard = 0; guard < 10; guard++) {
    const res = await api.convertPage({ body, mime: unit.mime, attempt, thinking });
    if (res.ok) {
      const payload = await res.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '').join('') || '';
      const tex = fencedLatex(text);
      if (tex) return { ok: true, tex, model: res.headers.get('x-contex-model') };
      return { ok: false, fatal: true,
               message: 'The conversion failed. Please try a different file.' };
    }

    const err = await res.json().catch(() => ({}));
    if (!err.retryable) {
      return { ok: false, fatal: true,
               message: err.error || 'The conversion failed. Please try a different file.' };
    }
    if (speculative) {
      // Records nothing and moves nothing. A page that fails here is merely
      // not done yet; the sequential pass will decide what it means.
      return { ok: false, message: err.error || '' };
    }
    if (err.nextAttempt === null || err.nextAttempt === undefined) {
      rotation.exhausted = true;
      rotation.fatal = err.error || 'Every AI model has reached its quota.';
      return { ok: false, message: rotation.fatal };
    }
    if (err.retryWithoutThinking) {
      // This model does not accept a thinking level. Drop it once and retry
      // the same model -- gemini.py ask() does exactly this.
      thinking = false;
    } else {
      attempt = err.nextAttempt;
      thinking = true;
      rotation.advance(attempt);
      if (onStatus) {
        onStatus(`${err.model || 'That model'} is unavailable — trying the next one…`);
      }
    }
  }
  return { ok: false, message: 'The AI conversion service is temporarily unavailable.' };
}

/** run.py _ai_workers: three by default, never more than there are pages. */
export function aiWorkers(count) {
  return count < 2 ? 1 : Math.max(1, Math.min(3, count));
}

/**
 * Convert every unit of a document, in page order -- run.py _convert_units.
 *
 * Pages are independent, so they go out concurrently first. That pass is
 * speculative: a free tier counts requests per minute, and treating a burst's
 * 429 as "this model is finished" would rotate onto a weaker model -- speed
 * bought with accuracy, which is the one trade this pipeline may not make.
 * Whatever is left is retried one at a time through the real round, where a
 * quota error means what it has always meant.
 *
 * Returns {documents, failedAt, reason}: documents in page order up to the
 * first failure, then the page number that failed and why.
 */
export async function convertUnits(units, rotation, api, { onStatus } = {}) {
  const done = new Map();
  const workers = aiWorkers(units.length);
  const say = (m) => { if (onStatus) onStatus(m); };

  if (workers > 1) {
    const queue = [...units];
    await Promise.all(Array.from({ length: workers }, async () => {
      while (queue.length) {
        const unit = queue.shift();
        // A pinned round: one model, and failures private to it.
        const pinned = new Rotation();
        pinned.attempt = rotation.attempt;
        const page = await convertOne(unit, pinned, api, { speculative: true })
          .catch(() => ({ ok: false }));
        if (page.ok) done.set(unit.number, page);
        say(`Converting… ${done.size} of ${units.length} pages`);
      }
    }));
  }

  const documents = [];
  for (const unit of units) {
    let page = done.get(unit.number);
    if (!page || !page.ok) {
      if (rotation.exhausted) {
        return { documents, failedAt: unit.number,
                 reason: rotation.fatal || 'Every AI model has reached its quota.' };
      }
      say(`Converting page ${unit.number} of ${units.length}…`);
      // Sequential, through the real round: this is where a quota error is
      // believed and allowed to move the conversion onto another model.
      page = await convertOne(unit, rotation, api, { onStatus });
    }
    if (!page.ok) {
      return { documents, failedAt: unit.number,
               reason: page.message || 'The AI conversion was unavailable.' };
    }
    documents.push(page.tex);
  }
  return { documents, failedAt: null, reason: '' };
}

// ---------------------------------------------------------------------------
// Describing a finished document
// ---------------------------------------------------------------------------

const MATH_ENV = new RegExp(
  '\\\\\\[|\\\\begin\\{(?:equation\\*?|align\\*?|gather\\*?|multline\\*?|cases'
  + '|[pbvV]?matrix)\\}', 'g');

/** Describe an AI-produced document the way the page counts describe one. */
function summariseTex(tex, pages = 1) {
  const match = /\\begin\{document\}([\s\S]*)\\end\{document\}/.exec(tex || '');
  const body = match ? match[1] : (tex || '');
  const paragraphs = body.split(/\n\s*\n/).filter((b) => b.trim());
  return {
    pages,
    textBlocks: paragraphs.length,
    equations: (body.match(MATH_ENV) || []).length,
    uncertainLines: 0,
  };
}

// ---------------------------------------------------------------------------
// The whole conversion
// ---------------------------------------------------------------------------

/**
 * Convert one upload end to end -- run.py convert() and _convert_pages().
 *
 * `api` supplies the two things that leave this module: `aiStatus()` and
 * `convertPage()`. `ui.status()` reports progress. Everything else -- the
 * decision to fall back, where to resume, what to say afterwards -- is here,
 * and is the same decision tree run.py makes.
 *
 * Returns { tex, items, equations, summary, issues }. Throws
 * FallbackNotAuthorized when the AI is down and the user has not agreed to the
 * local path; throws Error only when the input itself cannot be read.
 */
export async function convertDocument({ units, total, api, ui = {},
                                        allowFallback = false, signal }) {
  const say = (m) => { if (ui.status) ui.status(m); };
  const notes = [];

  const status = await api.aiStatus();
  const useAi = Boolean(status && status.available);
  if (!useAi && !allowFallback) throw new FallbackNotAuthorized(status);

  // Only once the fallback is certain. On the AI path the recognisers are
  // usually never needed, and fetching 50 MiB to use none of it is the kind of
  // thing a user on a phone notices.
  if (!useAi) local.warm(say);

  const unavailable = useAi ? '' : (status?.message || status?.reason || '');
  const pageTotal = total || units.length;

  let documents = [];
  let failedAt = null;
  let reason = '';
  if (useAi) {
    const run = await convertUnits(units, new Rotation(), api, { onStatus: say });
    documents = run.documents;
    failedAt = run.failedAt;
    reason = run.reason;
  }
  const aiPages = documents.length;

  // Everything came from the model.
  if (useAi && failedAt === null && documents.length) {
    const tex = mergeDocuments(documents);
    const summary = {
      ...summariseTex(tex, units.length),
      totalPages: pageTotal, notes, fallbackNotice: null, path: 'ai',
      aiPages, fallbackPages: 0,
    };
    return { tex, items: [], equations: [], summary, issues: staticValidate(tex) };
  }

  // Some or all of the document still needs the local recognisers. The AI
  // stopping is not a reason to ask the user again: they either authorised the
  // fallback before we started, or the AI was up when we started and has
  // failed since -- and re-prompting mid-document would throw away the pages
  // that already converted.
  const start = (failedAt || 1);
  const remaining = units.slice(start - 1);

  let localResult;
  try {
    // Warming is a no-op if it already happened; on the mid-document failure
    // path it has not, and this is the first moment we know it is needed.
    local.warm(say);
    localResult = await local.localDocument(remaining,
      { firstNumber: start, onProgress: say, signal });
  } catch (err) {
    // Work the AI already finished must survive the failure of the thing meant
    // to rescue it.
    if (!documents.length) throw err;
    console.warn('Notice: the local fallback could not run:', err);
    const tex = mergeDocuments(documents);
    const summary = {
      ...summariseTex(tex, aiPages),
      totalPages: pageTotal, notes, path: 'mixed', aiPages, fallbackPages: 0,
      fallbackNotice: notice({
        headline: `Only the first ${aiPages} of ${pageTotal} pages could be converted.`,
        detail: 'The AI stopped part way through and this browser could not '
                + 'convert the rest either, so the document ends at page '
                + `${aiPages}. What is here is unaffected.`,
        reason: String(err && err.message || err),
        fromPage: start, totalPages: pageTotal, partial: true,
      }),
    };
    return { tex, items: [], equations: [], summary, issues: staticValidate(tex) };
  }

  notes.push(...localResult.notes);

  let fallbackNotice;
  let tex;
  let path;
  if (documents.length) {
    // Resume exactly where the AI stopped: pages already converted keep their
    // AI output and are spliced in front of the locally converted tail, so
    // nothing is redone and nothing is lost.
    fallbackNotice = notice({
      headline: `AI conversion stopped after page ${aiPages} of ${pageTotal}.`,
      detail: `Pages ${start} to ${pageTotal} were converted in this browser `
              + 'without AI, so their quality may be lower — especially complex '
              + `layout, tables and unclear handwriting. Pages 1 to ${aiPages} `
              + 'are unaffected.',
      reason, fromPage: start, totalPages: pageTotal,
    });
    tex = mergeDocuments([...documents, localResult.tex]);
    path = 'mixed';
  } else {
    fallbackNotice = notice({
      headline: 'This document was converted without AI.',
      detail: 'It was converted in this browser instead, so quality may be '
              + 'lower — especially complex layout, tables and unclear '
              + 'handwriting.',
      reason: reason || unavailable || 'The AI service was unavailable.',
      fromPage: 1, totalPages: pageTotal,
    });
    tex = localResult.tex;
    path = 'converters';
  }

  // The local QA pass -- latex/repair.js. run.py reaches here with the AI
  // either off or just failed, so there is nothing to ask for a repair; what
  // can be fixed without understanding the document is fixed here.
  const repaired = repair(tex);
  if (repaired.fixes.length) notes.push(...repaired.fixes);
  tex = repaired.tex;

  const uncertain = localResult.items.filter(
    (i) => i.kind === 'text' && i.uncertain && i.text.trim());

  const summary = {
    pages: pageTotal,
    totalPages: pageTotal,
    textBlocks: localResult.items.filter((i) => i.kind === 'text').length,
    equations: localResult.equations.length,
    uncertainLines: uncertain.length,
    notes,
    fallbackNotice,
    path,
    aiPages,
    fallbackPages: remaining.length,
  };
  return { tex, items: localResult.items, equations: localResult.equations,
           summary, issues: staticValidate(tex) };
}
