/**
 * Does every asset this application asks for at runtime actually exist?
 *
 * WHY THIS IS NOT PARANOIA. Three of the four large payloads here -- the TeX
 * Live tree, the ONNX runtime and model, and tesseract.js with its language
 * data -- are **not in git**. They are produced by `npm run build:*` from
 * sources that live outside the repository. That is the right trade (a
 * repository is not a CDN) and it has one failure mode: a deploy from a clean
 * checkout that forgot a build step is a deploy where the preview never
 * compiles, or the offline conversion 404s halfway through a 50 MB download,
 * and NOTHING in the test suite would say so, because the test suite runs
 * against this machine, where those files happen to be present.
 *
 * So this reads the source for every absolute path it fetches, imports or
 * links, resolves each one the way Cloudflare Pages would -- including
 * _redirects -- and reports what is missing and which build command produces
 * it. It is a pre-deploy check, and it is meant to be run from a clean
 * checkout as well as from a working one.
 *
 *     node tools/check-assets.mjs [--json]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const PUBLIC = resolve(process.env.CONTEX_PUBLIC || 'public');
const JSON_OUT = process.argv.includes('--json');

/**
 * Which command produces a path that is not in git, so a failure names the fix
 * rather than only the symptom.
 */
const PRODUCED_BY = [
  [/^\/texmf\//, 'npm run build:texmf'],
  [/^\/pdftex\//, 'npm run build:texmf'],
  [/^\/vendor\/PdfTeXEngine\.js$/, 'npm run build:engine'],
  [/^\/vendor\/swiftlatex/, 'npm run build:engine'],
  [/^\/vendor\/pdf-lib\//, 'npm run build:pdflib'],
  [/^\/vendor\/ort\//, 'npm run build:models'],
  [/^\/vendor\/tesseract\//, 'npm run build:models'],
  [/^\/models\//, 'npm run build:models -- <mfr-source-dir>'],
  [/^\/vendor\/pdfjs\//, 'vendored by hand -- see the Stage 2 notes'],
];

const producer = (path) => (PRODUCED_BY.find(([re]) => re.test(path)) || [, 'in git'])[1];

/** Every file under public/, so a reference can be checked without I/O races. */
async function walk(dir, base = '') {
  const out = new Set();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const nested of await walk(join(dir, entry.name), rel)) out.add(nested);
    } else {
      out.add(rel);
    }
  }
  return out;
}

/**
 * public/_redirects, applied the way Pages applies it.
 *
 * Only the two forms this project uses: a `:param` rewrite and a `*` wildcard.
 * A reference that resolves through a redirect is checked against its TARGET,
 * which is the whole point -- /pdftex/32/cmr10.pfb has to find
 * /texmf/cmr10.pfb or the engine stalls on a font.
 */
async function redirects() {
  const text = await readFile(join(PUBLIC, '_redirects'), 'utf8').catch(() => '');
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [from, to, status] = trimmed.split(/\s+/);
    if (!from || !to) continue;
    rules.push({ from, to, status: Number(status || 302) });
  }
  return rules;
}

function applyRedirects(path, rules) {
  for (const rule of rules) {
    if (rule.from.endsWith('/*')) {
      const prefix = rule.from.slice(0, -1);
      if (path.startsWith(prefix)) return { path: rule.to, status: rule.status };
      continue;
    }
    const names = [];
    const pattern = new RegExp('^' + rule.from.replace(/:([A-Za-z_]+)/g, (_m, name) => {
      names.push(name);
      return '([^/]+)';
    }) + '$');
    const match = pattern.exec(path);
    if (!match) continue;
    let target = rule.to;
    names.forEach((name, i) => { target = target.replace(`:${name}`, match[i + 1]); });
    return { path: target, status: rule.status };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the source asks for
// ---------------------------------------------------------------------------

// An absolute path in a string literal, an import, or an HTML attribute.
// Deliberately broad: a missed reference is the failure this file exists to
// prevent, and a false positive only costs a line in the ignore list below.
const IN_CODE = /['"`](\/[A-Za-z0-9_@./-]*\.[A-Za-z0-9]+)['"`]/g;
const IN_HTML = /(?:src|href)\s*=\s*["'](\/[^"']+)["']/g;

// Paths that are references but not files.
const NOT_ASSETS = [
  /^\/api\//,            // the Worker
  /^\/legal\/\$/,        // built from a template literal; both are checked below
];

/** Template-literal paths the regex above cannot resolve, listed explicitly. */
const DYNAMIC = [
  '/legal/terms.html',
  '/legal/privacy.html',
  // formulas.js builds these from MODEL_DIR.
  '/models/mfr/encoder.onnx',
  '/models/mfr/decoder.onnx',
  '/models/mfr/tokenizer.json',
  // text.js hands langPath to tesseract.js, which appends the language.
  '/models/tessdata/eng.traineddata',
  // ort.wasm.min.mjs loads its own glue and kernels from wasmPaths.
  '/vendor/ort/ort-wasm-simd-threaded.mjs',
  '/vendor/ort/ort-wasm-simd-threaded.wasm',
  // PdfTeXEngine.js starts this as a Worker, and the emscripten glue inside it
  // then fetches the kernels beside itself. Neither path is written in our own
  // source, and both are fatal if absent -- the preview simply never appears.
  '/vendor/swiftlatexpdftex.js',
  '/vendor/swiftlatexpdftex.wasm',
];

async function sources(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      // vendor/ and models/ are third-party payloads, not our source. Their own
      // internal fetches are covered by DYNAMIC above.
      if (rel === '/vendor' || rel === '/models' || rel === '/texmf') continue;
      out.push(...await sources(join(dir, entry.name), rel));
    } else if (['.js', '.mjs', '.html', '.css'].includes(extname(entry.name))) {
      out.push({ rel, full: join(dir, entry.name) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const files = await walk(PUBLIC);
const rules = await redirects();
const referenced = new Map();   // path -> Set of files that ask for it

for (const { rel, full } of await sources(PUBLIC)) {
  const text = await readFile(full, 'utf8');
  for (const pattern of [IN_CODE, IN_HTML]) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const path = m[1];
      if (NOT_ASSETS.some((re) => re.test(path))) continue;
      if (!referenced.has(path)) referenced.set(path, new Set());
      referenced.get(path).add(rel);
    }
  }
}
for (const path of DYNAMIC) {
  if (!referenced.has(path)) referenced.set(path, new Set(['(resolved at runtime)']));
}

/**
 * A directory's index, which is how a page address becomes a file.
 *
 * wrangler.toml sets html_handling = "drop-trailing-slash", so /login is
 * served from login/index.html -- the address Flask's url_for('auth.login')
 * gave, without the redirect the default would add. Every internal link in the
 * shell is one of these, so without this rule the checker calls the whole
 * navigation missing.
 */
function asPage(path) {
  if (extname(path)) return null;
  const clean = path.replace(/\/$/, '');
  return `${clean === '' ? '' : clean}/index.html`;
}

const missing = [];
const found = [];
for (const [path, from] of [...referenced].sort()) {
  const rewritten = applyRedirects(path, rules);
  if (rewritten && rewritten.status === 404) continue;   // deliberately absent
  const direct = rewritten ? rewritten.path : path;
  const page = asPage(direct);
  const target = files.has(direct) ? direct : (page && files.has(page) ? page : direct);
  const entry = { path, target, from: [...from], producer: producer(path) };
  if (files.has(target)) found.push(entry);
  else missing.push(entry);
}

// A representative slice of the TeX tree, because a single missing font file
// stalls the engine and the reference to it is generated, never written down.
// The format file is the one that matters most: 9.9 MB, fetched on every cold
// compile, and without it the engine loads and then does nothing.
const TEXMF_SAMPLE = ['swiftlatexpdftex.fmt', 'cmr10.pfb', 'cmmi10.pfb',
                      'cmsy10.pfb', 'article.cls', 'amsmath.sty',
                      'inputenc.sty', 'fontenc.sty', 't1enc.def'];
const texmfMissing = TEXMF_SAMPLE.filter((n) => !files.has(`/texmf/${n}`));

let bytes = 0;
for (const path of files) {
  bytes += (await stat(join(PUBLIC, path.slice(1)))).size;
}

if (JSON_OUT) {
  console.log(JSON.stringify({ found: found.length, missing, texmfMissing,
                               files: files.size, bytes }, null, 1));
} else {
  console.log(`public/ holds ${files.size} files, `
              + `${(bytes / 1048576).toFixed(1)} MiB.`);
  console.log(`${found.length} referenced assets resolved.\n`);
  for (const entry of found) {
    const via = entry.target === entry.path ? '' : `  -> ${entry.target}`;
    console.log(`  ok    ${entry.path}${via}`);
  }
  if (texmfMissing.length) {
    console.log(`\n  MISSING from the TeX tree: ${texmfMissing.join(', ')}`);
  }
  if (missing.length) {
    console.log('\nMISSING:');
    for (const entry of missing) {
      console.log(`  ${entry.path}`);
      console.log(`     asked for by: ${entry.from.join(', ')}`);
      console.log(`     produced by:  ${entry.producer}`);
    }
  }
  console.log(missing.length || texmfMissing.length
    ? `\n${missing.length + texmfMissing.length} missing. This deploy would fail at runtime.`
    : '\nEverything this application fetches at runtime is present.');
}
process.exit(missing.length || texmfMissing.length ? 1 : 0);
