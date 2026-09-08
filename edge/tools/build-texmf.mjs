/**
 * Prepare public/texmf for static hosting.
 *
 * kpathsea asks for many files by FORMAT rather than by filename, so font
 * metrics arrive as bare names -- "ecrm1000" means ecrm1000.tfm. The S3 test
 * server probed a list of extensions to resolve those; a static host cannot.
 * So every .tfm also gets an extensionless copy, which turns the probe into a
 * plain hit.
 *
 * Cost is a few megabytes of duplicated metrics, on a tier where static
 * storage and bandwidth are both free and unmetered. The alternative -- routing
 * /pdftex/ through the Worker so it can probe -- would put every package fetch
 * on the 100,000 requests/day meter.
 */
import { readdir, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.argv[2] || 'public/texmf';
const names = await readdir(DIR);
const have = new Set(names);

let made = 0;
let bytes = 0;
for (const name of names) {
  if (!name.endsWith('.tfm')) continue;
  const bare = name.slice(0, -4);
  if (have.has(bare)) continue;
  await copyFile(join(DIR, name), join(DIR, bare));
  bytes += (await stat(join(DIR, name))).size;
  made += 1;
}

const after = (await readdir(DIR)).length;
console.log(`extensionless aliases: +${made} (${(bytes / 1048576).toFixed(2)} MiB)`);
console.log(`texmf now ${after} files`);
if (after > 20000) {
  console.error(`WARNING: ${after} files exceeds the Pages limit of 20,000`);
  process.exitCode = 1;
}
