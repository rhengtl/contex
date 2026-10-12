/**
 * The address ConTeX is published at, read from wrangler.toml.
 *
 * wrangler.toml's custom-domain route is what actually puts the Worker on that
 * hostname, so it is the one place the name is written. The page builder (for
 * the canonical link and the absolute share-card URLs) and the asset checker
 * read it from here rather than carrying copies that could drift from it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const toml = readFileSync(resolve(import.meta.dirname, '..', 'wrangler.toml'), 'utf8');

// [[routes]] tables, each up to the next table header.
const routes = toml.split(/^\[\[routes\]\]\s*$/m).slice(1)
  .map((t) => t.split(/^\[/m)[0]);
const primary = routes.find((t) => /^\s*custom_domain\s*=\s*true\s*$/m.test(t));
const host = primary && primary.match(/^\s*pattern\s*=\s*"([^"]+)"\s*$/m)?.[1];

if (!host) {
  throw new Error('wrangler.toml has no [[routes]] entry with custom_domain = true');
}

/** e.g. https://contex.rhengtl.tech -- no trailing slash. */
export const PRIMARY_ORIGIN = `https://${host}`;
