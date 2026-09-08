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
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const PUBLIC = resolve(process.env.CONTEX_PUBLIC || 'public');
const TESTS = resolve(process.env.CONTEX_TESTS || 'tests');
const PORT = Number(process.env.PORT || 8810);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json',
  '.tex': 'text/plain', '.png': 'image/png',
};

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
  } else if (path.startsWith('/tests/')) {
    file = join(TESTS, path.slice('/tests/'.length));
  } else {
    file = join(PUBLIC, path === '/' ? 'index.html' : path.replace(/^\//, ''));
  }

  try {
    const buf = await readFile(file);
    requestLog.push({ path, status: 200, bytes: buf.length });
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': path.startsWith('/texmf/') || path.startsWith('/vendor/')
        ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(buf);
  } catch {
    requestLog.push({ path, status: 404, bytes: 0 });
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`pages-emulator :${PORT}  public=${PUBLIC}`));
