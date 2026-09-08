/**
 * Patch SwiftLaTeX's worker glue so the TeX Live tree can be served as plain
 * static files.
 *
 * WHY. The upstream engine expects a bespoke package server: it reads a
 * `fileid` response header to decide where to cache the file, and it treats
 * HTTP 301 -- not 404 -- as "no such file". Cloudflare Pages serves static
 * assets with ordinary headers and answers 404 for a miss, and `_headers`
 * cannot synthesise a per-file value across ~1,600 files (the limit is 100
 * rules). Routing /pdftex/ through the Worker instead would work, but every
 * compile fetches dozens of files, so it would put the whole TeX tree on the
 * 100,000 requests/day meter -- exactly what spec section 16 says to avoid.
 *
 * WHAT. Two changes, both narrow:
 *   1. derive the cache path from the request key rather than a response
 *      header. The header only ever carried a unique name; the key already is
 *      one, so this is equivalent.
 *   2. treat 404 as "not found" as well as 301.
 *
 * Everything else in the engine is untouched. Run via `npm run build:engine`.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'public/vendor';

const REPLACEMENTS = [
  {
    name: 'fileid -> cacheKey',
    from: 'const fileid=xhr.getResponseHeader("fileid");const savepath=TEXCACHEROOT+"/"+fileid;',
    to: 'const fileid=(xhr.getResponseHeader("fileid")||cacheKey).replace(/[^A-Za-z0-9._-]/g,"_");'
      + 'const savepath=TEXCACHEROOT+"/"+fileid;',
  },
  {
    name: 'pkid -> cacheKey',
    from: 'const pkid=xhr.getResponseHeader("pkid");const savepath=TEXCACHEROOT+"/"+pkid;',
    to: 'const pkid=(xhr.getResponseHeader("pkid")||cacheKey).replace(/[^A-Za-z0-9._-]/g,"_");'
      + 'const savepath=TEXCACHEROOT+"/"+pkid;',
  },
  {
    // ENGINE_PATH is relative, so `new Worker(ENGINE_PATH)` resolves against
    // whatever page loaded the engine. From /tests/harness.html that is
    // /tests/swiftlatexpdftex.js -- a 404, and loadEngine() then never
    // settles, so the compile hangs instead of failing. Absolute path fixes it
    // for every caller.
    name: 'ENGINE_PATH -> absolute',
    from: "var ENGINE_PATH = 'swiftlatexpdftex.js';",
    to: "var ENGINE_PATH = '/vendor/swiftlatexpdftex.js';",
    file: 'PdfTeXEngine.js',
  },
  {
    name: '301 -> 301 or 404',
    from: 'xhr.status===301',
    to: '(xhr.status===301||xhr.status===404)',
    all: true,
  },
];

const sources = {
  'swiftlatexpdftex.js': await readFile(SRC, 'utf8'),
  'PdfTeXEngine.js': await readFile(join(dirname(SRC), 'PdfTeXEngine.js'), 'utf8'),
};

for (const r of REPLACEMENTS) {
  const target = r.file || 'swiftlatexpdftex.js';
  const count = sources[target].split(r.from).length - 1;
  if (count === 0) throw new Error(`patch target not found: ${r.name}`);
  if (!r.all && count !== 1) throw new Error(`${r.name}: expected 1 site, found ${count}`);
  sources[target] = sources[target].split(r.from).join(r.to);
  console.log(`  patched ${r.name} in ${target} (${count} site${count > 1 ? 's' : ''})`);
}

await mkdir(OUT, { recursive: true });
for (const [name, text] of Object.entries(sources)) await writeFile(join(OUT, name), text);
await copyFile(join(dirname(SRC), 'swiftlatexpdftex.wasm'), join(OUT, 'swiftlatexpdftex.wasm'));
console.log(`wrote ${OUT}/`);
