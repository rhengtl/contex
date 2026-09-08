/**
 * The local formula recogniser, scored against the same 75-image benchmark
 * S2 used to choose it.
 *
 * S2 measured the INT8 model at 90.26% character accuracy and 80% exact match
 * (60/75), through a throwaway harness. This runs the SHIPPED module over the
 * same images and checks it has not drifted from that -- a rewrite that
 * quietly loses five points would otherwise look like a passing test suite.
 *
 * The accuracy figures are a property of the model, not of this code, so the
 * bar is "no worse than S2 measured, allowing for a little tokenizer noise"
 * rather than an exact number.
 *
 *     node tests/formulas.mjs [clean|lowres|noisy|blur|photo|all]
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import './serve.mjs';

const PORT = Number(process.env.PORT || 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const BENCH = resolve(process.env.CONTEX_BENCH || '../bench');
const WANT = process.argv[2] || 'all';

// S2's measured baseline, per condition: [char accuracy %, exact matches / 15].
const S2 = {
  clean: [93.83, 12], lowres: [89.94, 13], noisy: [91.56, 12],
  blur: [86.69, 12], photo: [89.29, 11],
};
const S2_OVERALL = { char: 90.26, exact: 60 };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
};

/**
 * bench/score_math.py normalize(), character for character.
 *
 * This matters more than it looks. The model writes `E = m c ^ { 2 }` where the
 * ground truth says `E = mc^2`; both render identically, and the benchmark has
 * always collapsed that before comparing. Scoring without it measures the
 * model's spacing habits rather than whether it read the formula -- which is
 * how the first run of this suite reported 69% for a model the very same corpus
 * scores at 93%.
 */
function normalize(t) {
  let s = (t || '').trim().replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/\\dfrac|\\tfrac/g, '\\frac');
  s = s.replace(/\\left|\\right|\\quad|\\qquad|\\,|\\;|\\!|\\:/g, ' ');
  s = s.replace(/\\operatorname\s*\{([^}]*)\}/g, '\\$1');
  s = s.replace(/\{\s*([A-Za-z0-9])\s*\}/g, '$1');      // {x} -> x
  s = s.replace(/\s+/g, '');
  return s;
}

/** score_math.py tokens(): a control word, or a single character. */
function tokenise(t) {
  return t.match(/\\[A-Za-z]+|[\s\S]/g) || [];
}

/** score_math.py lev(), over strings or over token arrays. */
function lev(a, b) {
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

const manifest = JSON.parse(
  await readFile(join(BENCH, 'manifest_math.json'), 'utf8'));
const wanted = WANT === 'all' ? manifest : manifest.filter((m) => m.cond === WANT);

await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message.slice(0, 200)));
await page.goto(`${BASE}/tests/formulas-harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

check('the recogniser is not loaded until it is asked for',
      (await page.evaluate(() => window.modelReady())) === false);

await fetch(`${BASE}/__reset`);
const loadMs = await page.evaluate(() => window.loadModel(), null);
const loadLog = await (await fetch(`${BASE}/__log`)).json();
const loadBytes = loadLog.filter((r) => r.status === 200)
  .reduce((a, b) => a + b.bytes, 0);
console.log(`model ready in ${loadMs} ms, ${(loadBytes / 1048576).toFixed(2)} MiB ` +
            `over ${loadLog.length} requests\n`);
check('nothing but the runtime and the model was fetched',
      loadLog.every((r) => r.path.startsWith('/vendor/ort/') ||
                           r.path.startsWith('/models/mfr/')),
      loadLog.map((r) => r.path).join(', ').slice(0, 200));

const rows = [];
// score_math.py aggregates edit distance over the whole condition rather than
// averaging per-image accuracies, so the same is done here.
const totals = { ce: 0, nc: 0, te: 0, nt: 0, ex: 0, n: 0 };
console.log('condition   char acc  token acc    exact match    n');
for (const cond of ['clean', 'lowres', 'noisy', 'blur', 'photo']) {
  const set = wanted.filter((m) => m.cond === cond);
  if (!set.length) continue;
  const a = { ce: 0, nc: 0, te: 0, nt: 0, ex: 0, n: 0 };
  for (const m of set) {
    const r = await page.evaluate((u) => window.readFormula(u), `/bench/img_math/${m.file}`);
    const g = normalize(m.gt);
    const p = normalize(r.latex);
    a.ce += lev(g, p); a.nc += g.length;
    a.te += lev(tokenise(g), tokenise(p)); a.nt += tokenise(g).length;
    a.ex += g === p ? 1 : 0; a.n += 1;
    rows.push({ ...m, ...r, gtNorm: g, predNorm: p, exact: g === p });
  }
  for (const k of Object.keys(totals)) totals[k] += a[k];
  const charAcc = (1 - a.ce / a.nc) * 100;
  const tokenAcc = (1 - a.te / a.nt) * 100;
  console.log(`${cond.padEnd(11)}${charAcc.toFixed(2).padStart(6)}%   ` +
              `${tokenAcc.toFixed(2).padStart(6)}%   ` +
              `${a.ex}/${a.n} = ${Math.round(a.ex / a.n * 100)}%`.padStart(14) +
              `${String(a.n).padStart(5)}`);
  if (S2[cond] && set.length === 15) {
    // Two points of slack: the same weights, the same corpus and now the same
    // metric, so a real drift is much larger than this.
    check(`${cond}: character accuracy is no worse than S2 measured`,
          charAcc >= S2[cond][0] - 2,
          `${charAcc.toFixed(2)}% against S2's ${S2[cond][0]}%`);
    check(`${cond}: exact matches are no worse than S2 measured`,
          a.ex >= S2[cond][1] - 1, `${a.ex}/15 against S2's ${S2[cond][1]}/15`);
  }
}

const overallAcc = (1 - totals.ce / totals.nc) * 100;
const overallExact = totals.ex;
const times = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log('-'.repeat(51));
console.log(`OVERALL    ${overallAcc.toFixed(2).padStart(6)}%   ` +
            `${((1 - totals.te / totals.nt) * 100).toFixed(2).padStart(6)}%   ` +
            `${overallExact}/${rows.length} = ${Math.round(overallExact / rows.length * 100)}%`.padStart(14) +
            `${String(rows.length).padStart(5)}`);
console.log(`\nper formula: min ${times[0]} ms, median ` +
            `${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms`);
console.log(`peak heap: ${(Math.max(...rows.map((r) => r.heap)) / 1048576).toFixed(0)} MiB`);

if (WANT === 'all') {
  check('overall character accuracy matches S2',
        overallAcc >= S2_OVERALL.char - 2,
        `${overallAcc.toFixed(2)}% against S2's ${S2_OVERALL.char}%`);
  check('overall exact matches match S2',
        overallExact >= S2_OVERALL.exact - 3,
        `${overallExact}/75 against S2's ${S2_OVERALL.exact}/75`);
}
check('every formula produced some LaTeX',
      rows.every((r) => r.latex.length > 0),
      rows.filter((r) => !r.latex.length).map((r) => r.file).join(', '));
check('nothing decoded to the byte-alphabet failure mode',
      !rows.some((r) => /^E{6,}/.test(r.latex)),
      'a result looks like the transformers.js EEEE bug');

const wrong = rows.filter((r) => !r.exact).slice(0, 6);
if (wrong.length) {
  console.log('\nmismatches (normalised):');
  for (const r of wrong) {
    console.log(`  [${r.cond}] ${r.file}`);
    console.log(`    GT  : ${r.gtNorm}`);
    console.log(`    PRED: ${r.predNorm}`);
  }
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`failing:\n  ${failed.map((f) => f.name).join('\n  ')}`);
process.exit(failed.length ? 1 : 0);
