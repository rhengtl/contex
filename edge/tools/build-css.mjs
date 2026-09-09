/**
 * Build public/app.css from design/app.src.css.
 *
 *     npm run build:css
 *
 * This is tools/build_css.py from the Flask application, in JavaScript,
 * and it does the same two things for the same two reasons.
 *
 * 1. Tailwind generates the stylesheet. Deliberately NOT --minify: the
 *    minifier rewrites colours into whichever notation is shortest, and
 *    hsla() does not round-trip every value in this palette exactly --
 *    text-cream-100/70 came back a step lighter. Colour fidelity is not worth
 *    trading for bytes in an application whose whole subject is reproducing a
 *    document faithfully.
 *
 * 2. Comments are removed from the OUTPUT only. The source carries a long
 *    explanation of the design system, the measured contrast ratios and the
 *    font metrics, and shipping all of it to every visitor cost 15 KB of the
 *    built file.
 *
 *    The strip is strictly textual. It cannot reorder a declaration or rewrite
 *    a colour, which is what --minify did, and the check at the end proves it:
 *    if anything but comments differs, the build refuses to write.
 *
 * WHY THE PAGES ARE BUILT FIRST. Tailwind only emits a class it can see in the
 * `content` files, so the stylesheet is a function of the markup. Running this
 * against stale pages silently drops the classes the new ones need -- and a
 * missing utility is invisible until someone looks at the page. `npm run
 * build:ui` runs the two in the right order; use that.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'design/app.src.css');
const OUT = resolve(ROOT, 'public/app.css');
const CONFIG = resolve(ROOT, 'tailwind.config.cjs');

const bytes = (n) => `${n.toLocaleString('en-US')} B`;
/** Comments cannot appear inside a string or a url() in this stylesheet. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (css) => css.replace(/\s+/g, '');

// npx rather than a dependency, exactly as build_css.py does it: the stylesheet
// is committed, so nobody installing this project to run it needs tailwind at
// all -- only somebody changing the design does.
const run = spawnSync(
  'npx', ['--yes', 'tailwindcss@3', '-c', CONFIG, '-i', SRC, '-o', OUT],
  { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });

if (run.status !== 0) {
  process.stderr.write((run.stdout || '') + (run.stderr || ''));
  console.error('\ntailwind build failed');
  process.exit(1);
}

const generated = await readFile(OUT, 'utf8');
const stripped = strip(generated)
  .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
  .trim() + '\n';

if (squash(strip(generated)) !== squash(stripped)) {
  console.error('the strip changed more than comments - refusing');
  process.exit(1);
}

await writeFile(OUT, stripped);

const onDisk = await readFile(OUT);
console.log(OUT);
console.log(`  generated ${bytes(generated.length)} of CSS`
            + `  ->  ${bytes(onDisk.length)} on disk`
            + `  (${bytes(generated.length - stripped.length)} of comments removed)`);
console.log(`  gzip ${bytes(gzipSync(onDisk, { level: 9 }).length)}`);
