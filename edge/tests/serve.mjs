/**
 * A local stand-in for Cloudflare Pages' static hosting, so Stage 2 can be
 * tested without deploying.
 *
 * It reproduces the two behaviours the compile path depends on:
 *   * the _redirects rewrite  /pdftex/:format/:name -> /texmf/:name
 *   * a plain 404 for a file the tree does not carry
 *
 * That second one is the whole point of the engine patch: upstream SwiftLaTeX
 * expects HTTP 301 and a `fileid` header from a bespoke package server, and a
 * static host gives neither.
 */
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { readFile as read } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const PUBLIC = resolve(process.env.CONTEX_PUBLIC || 'public');
const TESTS = resolve(process.env.CONTEX_TESTS || 'tests');
const BENCH = resolve(process.env.CONTEX_BENCH || '../bench');
const PORT = Number(process.env.PORT || 8810);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json',
  '.tex': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
  // .pdfdata, not .pdf. Edge intercepts a same-origin fetch for a URL ending
  // in .pdf and answers 204 with no body, whatever the server sent -- measured,
  // and it is why the multi-page fixture is named the way it is. The app never
  // fetches a PDF by URL (an upload arrives as a File), so this is a test
  // fixture problem only.
  '.pdf': 'application/pdf', '.pdfdata': 'application/pdf',
  '.onnx': 'application/octet-stream',
  '.traineddata': 'application/octet-stream',
};

/**
 * public/_headers, applied the way Pages applies it.
 *
 * WHY THE EMULATOR SENDS THE REAL POLICY. The CSP is the one piece of this
 * application that cannot be unit-tested: it is a header, it is enforced by
 * the browser, and a policy that forbids something the app actually does fails
 * only in production. Serving the real file here means every browser suite
 * runs under the deployed policy, and a violation is a test failure instead of
 * a blank page after a deploy.
 *
 * Only the two forms the file uses: an exact path and a `/prefix/*` glob.
 */
function parseHeaders() {
  let text = '';
  try { text = readFileSync(join(PUBLIC, '_headers'), 'utf8'); } catch { return []; }
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { match: line.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const at = line.indexOf(':');
    if (at < 0 || !current) continue;
    current.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules;
}

const HEADER_RULES = parseHeaders();

function headersFor(path) {
  // The policy covers public/, because that is what Pages serves. The test
  // harnesses live in tests/ and the corpora in bench/; neither is ever
  // deployed, and both use inline module scripts, which 'self' correctly
  // forbids. Applying the app's policy to them would only prove that the
  // harnesses are not the app.
  if (path.startsWith('/tests/') || path.startsWith('/bench/')) return {};
  const out = {};
  for (const rule of HEADER_RULES) {
    const m = rule.match;
    const hit = m === '/*' ? true
      : m.endsWith('/*') ? path.startsWith(m.slice(0, -1))
      : m === path;
    if (hit) Object.assign(out, rule.headers);
  }
  return out;
}

export const requestLog = [];

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (path === '/__log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requestLog));
    return;
  }
  if (path === '/__reset') { requestLog.length = 0; res.writeHead(200).end('ok'); return; }

  // _redirects: PK bitmaps are never hosted.
  if (path.startsWith('/pdftex/pk/')) {
    requestLog.push({ path, status: 404, bytes: 0 });
    res.writeHead(404).end('not found');
    return;
  }

  let file;
  if (path.startsWith('/pdftex/')) {
    const name = path.split('/').pop();
    file = join(PUBLIC, 'texmf', name);
  } else if (path.startsWith('/bench/')) {
    // The benchmark corpora, so the local recognisers can be scored against
    // the same images the AI path was. Rooted at bench/ rather than at one of
    // its folders: the fallback suite needs img_pages and img_mixed as well as
    // img_math, and a route that can only reach one of them is a route that
    // has to be duplicated per corpus.
    file = join(BENCH, path.slice('/bench/'.length));
  } else if (path.startsWith('/tests/')) {
    file = join(TESTS, path.slice('/tests/'.length));
  } else {
    file = join(PUBLIC, path === '/' ? 'index.html' : path.replace(/^\//, ''));
  }

  try {
    // html_handling = "drop-trailing-slash", the way wrangler.toml sets it:
    // /login is served from login/index.html. Without this the emulator
    // answers 404 for every page address in the shell's own navigation, and
    // the suites see an app with no history and no sign-in.
    if (!extname(file)) {
      try { await read(file); } catch { file = join(file, 'index.html'); }
    }
    const buf = await read(file);
    requestLog.push({ path, status: 200, bytes: buf.length });
    res.writeHead(200, {
      ...headersFor(path),
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': path.startsWith('/texmf/') || path.startsWith('/vendor/')
        || path.startsWith('/models/')
        ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(buf);
  } catch {
    requestLog.push({ path, status: 404, bytes: 0 });
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`pages-emulator :${PORT}  public=${PUBLIC}`));
