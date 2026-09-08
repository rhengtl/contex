/**
 * Narrow the Firebase auth origin in public/_headers to one exact domain.
 *
 * WHY THIS IS A SCRIPT AND NOT A CONSTANT. The Worker builds its own CSP at
 * request time and reads FIREBASE_AUTH_DOMAIN from config, exactly as
 * security.py did. Static assets cannot: Pages serves them without invoking the
 * Worker -- which is what keeps the TeX tree free -- so their policy is a flat
 * file that has to be written before deploying.
 *
 * The checked-in default is the pattern `https://*.firebaseapp.com`, so the app
 * works before anyone has decided on a project. A pattern is a wider surface
 * than a host, and there is no reason to keep it wider than one domain once the
 * domain is known. Run this then, and commit the result:
 *
 *     node tools/build-headers.mjs contex-28bfd.firebaseapp.com
 *
 * Run it with no argument to go back to the pattern.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PATTERN = 'https://*.firebaseapp.com';
const FILE = resolve(process.env.CONTEX_PUBLIC || 'public', '_headers');

const domain = (process.argv[2] || '').trim();
if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
  console.error(`Not a domain: ${domain}\n` +
                'Pass the project\'s authDomain, e.g. my-project.firebaseapp.com');
  process.exit(1);
}
const replacement = domain ? `https://${domain}` : PATTERN;

const before = await readFile(FILE, 'utf8');
// Whatever is there now -- the pattern, or a domain from a previous run.
const current = /https:\/\/(\*\.firebaseapp\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[ ;])/gi;
const seen = new Set();
const after = before.replace(current, (match) => {
  // Only the Firebase auth origin moves. Everything else named in the policy --
  // gstatic, apis.google.com, the Identity Toolkit -- is fixed.
  if (!/firebaseapp\.com$/i.test(match) &&
      !(domain && match === `https://${domain}`)) return match;
  seen.add(match);
  return replacement;
});

if (before === after) {
  console.log(`_headers already names ${replacement}; nothing to do.`);
} else {
  await writeFile(FILE, after);
  console.log(`_headers: ${[...seen].join(', ')} -> ${replacement}`);
  console.log('Set FIREBASE_AUTH_DOMAIN in wrangler.toml to match, so the ' +
              'Worker\'s own policy agrees with the static one.');
}
