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
 * WHAT. Three changes, all narrow:
 *   1. derive the cache path from the request key rather than a response
 *      header. The header only ever carried a unique name; the key already is
 *      one, so this is equivalent.
 *   2. treat 404 as "not found" as well as 301.
 *   3. a `preload` command that puts files the page has already downloaded
 *      into the worker's file cache, so a compile does not download them.
 *
 * Everything else in the engine is untouched. Run via `npm run build:engine`.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'public/vendor';

const REPLACEMENTS = [
  {
    // Without this, the 9.88 MB format and every package arrived DURING
    // compileLaTeX(), one blocking XHR at a time, so the compile deadline was
    // timing a download: 60 s at 1.6 Mbps, and "Compilation timed out after
    // 120s" below about 0.8 Mbps -- with every retry starting the download
    // again from zero. A null entry records a known miss, so it is never
    // requested. See public/latex/compile.js preloadInto().
    name: 'preload command',
    from: 'else if(cmd==="flushcache"){cleanDir(WORKROOT)}else{console.error("Unknown command "+cmd)}',
    to: 'else if(cmd==="flushcache"){cleanDir(WORKROOT)}'
      + 'else if(cmd==="preload"){const files=data["files"]||{};let count=0;'
      + 'for(const key in files){const buf=files[key];'
      + 'if(buf===null){texlive404_cache[key]=1;continue}'
      + 'const savepath=TEXCACHEROOT+"/"+key.replace(/[^A-Za-z0-9._-]/g,"_");'
      + 'FS.writeFile(savepath,new Uint8Array(buf));texlive200_cache[key]=savepath;count++}'
      + 'self.postMessage({"cmd":"preload","result":"ok","count":count})}'
      + 'else{console.error("Unknown command "+cmd)}',
  },
  {
    // A file the preload did not cover is still fetched by a synchronous XHR
    // during the compile. Upstream allowed each one 150 s -- longer than the
    // page's whole 120 s compile deadline, so one stalled package on a dead
    // link was reported as "Compilation timed out". 30 s for one file, which
    // at these sizes (tens of KB) is a link that has stopped, not a slow one.
    name: 'per-file download timeout',
    from: 'xhr.timeout=15e4',
    to: 'xhr.timeout=3e4',
    all: true,
  },
  {
    // ...and when one does fail, say so: counted here, reset per compile,
    // returned with the result, so the page can report "files could not be
    // downloaded" instead of a LaTeX error or a timeout. See compile.js.
    name: 'count failed downloads',
    from: 'catch(err){console.log("TexLive Download Failed "+remote_url);return 0}',
    to: 'catch(err){console.log("TexLive Download Failed "+remote_url);self.netfail=(self.netfail|0)+1;return 0}',
    all: true,
  },
  {
    // The other way a fetch fails: an answer that is neither the file nor
    // "no such file" -- a 5xx, or status 0 when the connection drops (which
    // a synchronous XHR reports without throwing).
    name: 'count failed responses',
    from: '_cache[cacheKey]=1;return 0}return 0}',
    to: '_cache[cacheKey]=1;return 0}self.netfail=(self.netfail|0)+1;return 0}',
    all: true,
  },
  {
    name: 'reset the failed-download count per compile',
    from: 'function compileLaTeXRoutine(){prepareExecutionContext();',
    to: 'function compileLaTeXRoutine(){prepareExecutionContext();self.netfail=0;',
  },
  {
    name: 'report the failed-download count',
    from: '"cmd":"compile"}',
    to: '"cmd":"compile","netfail":self.netfail|0}',
    all: true,
  },
  {
    // ...and keep it on the result object the page receives. Reading it off
    // the message with a second listener does not work: the wrapper's own
    // onmessage resolves the compile first, and the caller's continuation
    // runs before any later listener sees the same message.
    name: 'carry the failed-download count in the result',
    file: 'PdfTeXEngine.js',
    from: "nice_report.log = log;",
    to: "nice_report.log = log;\n                                    nice_report.netfail = data['netfail'] | 0;",
  },
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
