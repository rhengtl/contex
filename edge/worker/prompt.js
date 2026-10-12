/**
 * The conversion prompt, ported verbatim from
 * contex/pipeline/recognise/ai.py (_DIRECT_SYSTEM, _DIRECT_PROMPT).
 *
 * This file is parity-critical. The generated LaTeX is a function of this text,
 * so it is copied exactly rather than paraphrased -- including the priority
 * ordering, the note that "unusual is not wrong", and the fenced-block reply
 * contract that fencedLatex() in gemini.js depends on. If ai.py changes, change
 * this with it and re-run bench/score_qa.py against both.
 */

export const DIRECT_SYSTEM = `You convert a scanned or photographed page into LaTeX. You are reading the page
yourself - there is no OCR draft to check.

Priorities, in order:
1. Fidelity to the page. Every piece of content present, correct, and in the
   same reading order. Nothing invented, nothing omitted, nothing duplicated.
2. Structure that matches the page - headings as headings, lists as lists,
   tables as tables, paragraphs kept whole, displayed mathematics displayed and
   inline mathematics inline.
3. Valid, compilable LaTeX.

The page may be handwritten, printed, or both, in prose and in mathematics.
Typeset all of it the same way: a handwritten sentence and a printed one both
become ordinary LaTeX prose, a handwritten formula and a printed one both
become ordinary LaTeX mathematics. What it was written with changes how
carefully you must read, not how it is typeset.

On mathematics, **unusual is not wrong.** Transcribe what the page shows. Never
normalise an expression into a more familiar one because the one written looks
strange, unconventional or dimensionally odd. If the page shows it that way,
write it that way.

Rules:
- Emit a complete document: \\documentclass, preamble, \\begin{document} ...
  \\end{document}.
- Load only packages the content needs; an unused \\usepackage is a defect.
- Never use \\includegraphics - the file will not exist.
- Escape LaTeX special characters in ordinary prose (% & _ # $).
- If something is genuinely illegible, give your best reading and mark it with
  a % comment rather than dropping it.

Reply with the document in a single fenced block and nothing else:

\`\`\`latex
...document...
\`\`\`
`;

export const DIRECT_PROMPT =
  'Convert the attached page to LaTeX, following your instructions exactly.\n';

/**
 * Ordered fallback candidates. Every entry is free-tier eligible, and every
 * entry is a DISTINCT model -- checked against the live API, not just the docs.
 *
 * The principles are the ones gemini.py set down (recoverable from git history
 * at 45dc49b^:contex/services/llm/gemini.py):
 *
 *   - The first entry is the preference, chosen on measured reading quality
 *     rather than recency. gemini-3.1-flash-lite scored 0.6214 on socOCRbench,
 *     tied with the best free-tier model; gemini-3.6-flash, the best measured
 *     reader at 0.6225, is second.
 *   - A model with a thin free daily quota goes last, where it is a fine
 *     last resort and a poor primary.
 *   - Nothing speculative: rotating onto a name that does not exist turns one
 *     exhausted quota into a run of confusing errors.
 *
 * October 2026. Google deprecated gemini-3.5-flash and gemini-3.7-flash and now
 * serves them by routing: a request to 3.5-flash is answered by 3.6-flash, and
 * one to 3.7-flash by 3.8-flash (the reply's modelVersion says so). Left in
 * place, the chain read [3.1-flash-lite, 3.6, 3.6, 3.8] -- the third slot
 * re-asked the model that had just run out, under another name the outage
 * record does not connect to it, and the status line named a model that was
 * not the one answering. So:
 *
 *   gemini-3.5-flash  -> gemini-3.5-flash-lite  a genuinely separate model,
 *       GA since July 2026, Google's named successor to 3.1-flash-lite, and
 *       verified to accept this file's generation config unchanged.
 *   gemini-3.7-flash  -> gemini-3.8-flash  what was already answering, by its
 *       own name. Kept last: it is 3.7's successor and the free quota on
 *       full-size Flash releases has been the first to run out.
 *
 * Neither newcomer has been through socOCRbench, which is why neither leads.
 * gemini-3.1-flash-lite has a published shutdown of 2027-05-07; benchmark
 * gemini-3.5-flash-lite against it well before then and promote it if it holds
 * up, rather than discovering the date from a chain that has lost its head.
 */
export const MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];
