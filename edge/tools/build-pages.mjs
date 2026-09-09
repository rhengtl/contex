/**
 * Expand pages/ into the static HTML Pages serves.
 *
 *     npm run build:pages
 *
 * WHY THIS EXISTS. The Flask application's templates all extend base.html,
 * and its own comment says why: before that shell existed "there were four
 * independent documents each carrying their own <head>, which is why they had
 * drifted apart -- the home page set its body font one way and the three auth
 * pages another, only one of the four had a background colour, and none of
 * them had a favicon". Static hosting has no template engine, so the choice
 * was between hand-copying that shell into six files and re-inheriting exactly
 * the drift it was built to stop, or spending sixty lines here. This is the
 * sixty lines.
 *
 * It implements the Jinja constructs those templates actually use and nothing
 * else:
 *
 *     {% extends 'base.html' %}
 *     {% block name %} ... {% endblock %}      (and {{ super() }} is NOT
 *                                               supported; nothing uses it)
 *     {% include 'partials/name.html' %}
 *     {% set page = 'home' %}                  (string literals only)
 *     {% if page == 'home' %} ... {% endif %}
 *     {{ page }}
 *
 * THE ONE THING {% if %} IS FOR is the state the *route* knows: which nav link
 * is the current page. Flask marked it with aria-current="page" in the
 * rendered HTML, and doing it from JavaScript instead would leave the header
 * briefly wrong on every load. A page sets `page` at the top and the header
 * reads it, exactly as templates/partials/header.html read request.endpoint.
 *
 * NOT for the state the *request* knew. In Flask the server also knew whether
 * you were signed in, whether you had accepted the terms and whether a
 * conversion had just finished, so it rendered one branch of each. Here nobody
 * knows any of that until the page is running, so both branches are in the
 * document and app.js shows one -- which is what the edge app already did, and
 * what makes the result cacheable as a static asset for every visitor.
 *
 * Jinja comments are stripped, because they are notes to whoever edits the
 * template rather than to whoever reads the page.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PAGES = resolve(ROOT, 'pages');
const PUBLIC = resolve(ROOT, 'public');

/**
 * Where each page is served from. A directory with an index.html rather than
 * `login.html`, so the address is /login the way Flask's url_for gave it --
 * Workers static assets serve a directory's index for the bare path.
 */
const ROUTES = {
  'index.html': 'index.html',
  'history.html': 'history/index.html',
  'login.html': 'login/index.html',
  'signup.html': 'signup/index.html',
  'forgot-password.html': 'forgot-password/index.html',
  // Not a route. Pages serves this for any path the asset tree does not carry,
  // and looks for it at exactly this name.
  '404.html': '404.html',
};

const source = (name) => readFile(join(PAGES, name), 'utf8');

const BLOCK = /\{%\s*block\s+([a-z_]+)\s*%\}([\s\S]*?)\{%\s*endblock\s*%\}/g;
const INCLUDE = /^([ \t]*)\{%\s*include\s+'([^']+)'\s*%\}[ \t]*$/gm;
const EXTENDS = /\{%\s*extends\s+'([^']+)'\s*%\}\s*/;
const COMMENT = /\{#[\s\S]*?#\}\n?/g;
const SET = /\{%\s*set\s+([a-z_]+)\s*=\s*'([^']*)'\s*%\}\s*/g;
const IF = /\{%\s*if\s+([a-z_]+)\s*==\s*'([^']*)'\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g;
const ELSE = /\{%\s*else\s*%\}/;
const VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Resolve {% if %} and {{ var }} against the page's {% set %} values. */
function fill(html, vars) {
  let out = html.replace(IF, (_, name, value, body) => {
    const [then, otherwise = ''] = body.split(ELSE);
    return vars[name] === value ? then : otherwise;
  });
  out = out.replace(VAR, (whole, name) => (name in vars ? vars[name] : whole));
  if (/\{%\s*(if|set|for)\b/.test(out)) {
    throw new Error('unsupported template tag left in output: '
                    + out.match(/\{%[^%]*%\}/)[0]);
  }
  return out;
}

/** Inline every {% include %}, keeping the indentation of the tag. */
async function expand(html, seen = new Set()) {
  const parts = [];
  let out = html;
  let match;
  INCLUDE.lastIndex = 0;
  while ((match = INCLUDE.exec(html)) !== null) parts.push(match);
  if (!parts.length) return out;

  for (const [tag, indent, name] of parts) {
    if (seen.has(name)) throw new Error(`include loop at ${name}`);
    const body = await expand(await source(name), new Set([...seen, name]));
    const inset = body.replace(COMMENT, '').trimEnd()
      .split('\n').map((line) => (line ? indent + line : line)).join('\n');
    out = out.replace(tag, inset);
  }
  return out;
}

async function build(name, route) {
  let html = await source(name);

  // {% set %} is read off the page and then removed, so the values are in
  // scope for the shell and every partial it pulls in.
  const vars = {};
  html = html.replace(SET, (_, key, value) => { vars[key] = value; return ''; });

  const parent = html.match(EXTENDS);

  if (parent) {
    const blocks = {};
    let match;
    BLOCK.lastIndex = 0;
    while ((match = BLOCK.exec(html)) !== null) blocks[match[1]] = match[2];
    // The shell, with each of its own blocks replaced by the page's, or by
    // nothing at all when the page does not fill it.
    html = (await source(parent[1])).replace(
      BLOCK, (_, key, fallback) => (key in blocks ? blocks[key] : fallback));
  }

  html = fill(await expand(html), vars).replace(COMMENT, '');
  // Blank runs left where a comment or an unfilled block used to be.
  html = html.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').trimStart();

  const out = join(PUBLIC, route);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html);
  return { route, bytes: html.length };
}

const names = (await readdir(PAGES)).filter((n) => n.endsWith('.html'));
const missing = names.filter((n) => !(n in ROUTES) && n !== 'base.html');
if (missing.length) {
  console.error(`pages/ has no route for: ${missing.join(', ')}`);
  console.error('Add it to ROUTES in this file.');
  process.exit(1);
}

const built = [];
for (const [name, route] of Object.entries(ROUTES)) built.push(await build(name, route));
for (const { route, bytes } of built) {
  console.log(`  ${route.padEnd(28)}${bytes.toLocaleString('en-US').padStart(9)} B`);
}
console.log(`${built.length} pages.`);
