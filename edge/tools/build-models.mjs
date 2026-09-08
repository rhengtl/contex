/**
 * Assemble the local-fallback assets into public/.
 *
 * Two payloads, both large, both static, both fetched only when a conversion
 * actually falls back -- which on the AI path is never. They are kept out of
 * git for the same reason public/texmf/ is: a repository is not a CDN, and
 * both are reproducible from a command.
 *
 *   public/vendor/ort/     ONNX Runtime Web, from node_modules. The
 *                          single-threaded SIMD build: the site is not
 *                          cross-origin isolated (spec R3), so there is no
 *                          SharedArrayBuffer and the threaded/jsep builds
 *                          would only be dead weight.
 *   public/models/mfr/     pix2text-mfr, INT8. Encoder, decoder and tokenizer.
 *   public/vendor/tesseract/  tesseract.js and its WebAssembly core.
 *   public/models/tessdata/   eng.traineddata -- the language data.
 *
 * The model directory is whatever S2 produced; point MFR_SRC at it.
 *
 *     node tools/build-models.mjs [<mfr-source-dir>] [<eng.traineddata>]
 *
 * WHY THE LANGUAGE DATA IS VENDORED. tesseract.js fetches it from
 * tessdata.projectnaptha.com by default. connect-src is 'self' (see
 * public/_headers), so that fetch is blocked -- correctly: the OCR fallback is
 * the one path on which nothing about the user's document leaves the machine,
 * and reaching a third-party CDN the moment it runs would make the Privacy
 * Policy untrue. It is served from our own origin instead.
 */
import { mkdir, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUBLIC = resolve(process.env.CONTEX_PUBLIC || 'public');
const ORT_SRC = resolve('node_modules/onnxruntime-web/dist');
// Resolved only when there is something to resolve: resolve('') is the current
// directory, which is truthy, which made the "no model source given" branch
// below unreachable and turned a bare run into a copy from ./onnx.
const MFR_ARG = process.argv[2] || process.env.MFR_SRC || '';
const MFR_SRC = MFR_ARG ? resolve(MFR_ARG) : '';
const TESS_SRC = resolve('node_modules/tesseract.js/dist');
const TESS_CORE_SRC = resolve('node_modules/tesseract.js-core');

/**
 * Where to find eng.traineddata.
 *
 * An installed Tesseract is preferred over a download, and not for
 * convenience: the Python pipeline reads pages with whatever `tesseract` is on
 * this machine, so copying that machine's own language data is what makes the
 * browser port and the reference implementation the SAME recogniser rather
 * than two builds of one that happen to agree.
 */
const TESSDATA_CANDIDATES = [
  process.argv[3], process.env.TESSDATA_SRC,
  process.env.TESSDATA_PREFIX && join(process.env.TESSDATA_PREFIX, 'eng.traineddata'),
  'C:/Program Files/Tesseract-OCR/tessdata/eng.traineddata',
  'C:/Program Files (x86)/Tesseract-OCR/tessdata/eng.traineddata',
  'D:/Apps/Tesseract-OCR/tessdata/eng.traineddata',
  '/usr/share/tesseract-ocr/5/tessdata/eng.traineddata',
  '/usr/share/tesseract-ocr/4.00/tessdata/eng.traineddata',
  '/usr/share/tessdata/eng.traineddata',
  '/opt/homebrew/share/tessdata/eng.traineddata',
];

// The library, the worker it spawns, and the core.
//
// The single-file `.wasm.js` core, not the `.js` + separate `.wasm` pair: the
// worker only ever builds the `.wasm.js` name itself, and pointing corePath at
// an exact file to save 0.9 MiB would leave the emscripten glue resolving the
// .wasm relative to a path we control less well than we control this. SIMD, to
// match the ONNX build above, and LSTM-only, which is the engine Tesseract 5
// uses for `eng` anyway.
const TESS_FILES = [
  [TESS_SRC, 'tesseract.esm.min.js'],
  [TESS_SRC, 'worker.min.js'],
  [TESS_CORE_SRC, 'tesseract-core-simd-lstm.wasm.js'],
];

// The runtime, and only the pieces the wasm backend actually loads.
const ORT_FILES = [
  'ort.wasm.min.mjs',                 // the API surface, wasm backend only
  'ort-wasm-simd-threaded.mjs',       // the emscripten glue
  'ort-wasm-simd-threaded.wasm',      // the kernels
];

// The model. Named plainly on disk so the loader has no version in its paths.
const MFR_FILES = [
  ['onnx/encoder_model_quantized.onnx', 'encoder.onnx'],
  ['onnx/decoder_model_quantized.onnx', 'decoder.onnx'],
  ['tokenizer.json', 'tokenizer.json'],
];

async function sizeOf(path) {
  return (await stat(path)).size;
}

let total = 0;
const manifest = [];

const ortOut = join(PUBLIC, 'vendor', 'ort');
await mkdir(ortOut, { recursive: true });
for (const name of ORT_FILES) {
  const from = join(ORT_SRC, name);
  await copyFile(from, join(ortOut, name));
  const bytes = await sizeOf(from);
  total += bytes;
  manifest.push({ file: `vendor/ort/${name}`, bytes });
  console.log(`  ${(bytes / 1048576).toFixed(2).padStart(7)} MiB  vendor/ort/${name}`);
}

if (!MFR_SRC) {
  console.log('\nNo pix2text-mfr source given, so only the runtime was copied.');
  console.log('Pass the INT8 model directory (the one holding onnx/ and ' +
              'tokenizer.json) to install the recogniser.');
} else {
  const mfrOut = join(PUBLIC, 'models', 'mfr');
  await mkdir(mfrOut, { recursive: true });
  for (const [from, to] of MFR_FILES) {
    const source = join(MFR_SRC, from);
    await copyFile(source, join(mfrOut, to));
    const bytes = await sizeOf(source);
    total += bytes;
    manifest.push({ file: `models/mfr/${to}`, bytes });
    console.log(`  ${(bytes / 1048576).toFixed(2).padStart(7)} MiB  models/mfr/${to}`);
  }
  await writeFile(join(mfrOut, 'manifest.json'),
                  JSON.stringify({ files: manifest }, null, 2));
}

// -- the text recogniser ----------------------------------------------------

const tessOut = join(PUBLIC, 'vendor', 'tesseract');
await mkdir(tessOut, { recursive: true });
for (const [dir, name] of TESS_FILES) {
  const from = join(dir, name);
  await copyFile(from, join(tessOut, name));
  const bytes = await sizeOf(from);
  total += bytes;
  manifest.push({ file: `vendor/tesseract/${name}`, bytes });
  console.log(`  ${(bytes / 1048576).toFixed(2).padStart(7)} MiB  vendor/tesseract/${name}`);
}

const tessdata = TESSDATA_CANDIDATES.find((path) => path && existsSync(path));
if (!tessdata) {
  console.error('\nCould not find eng.traineddata. Pass its path as the second '
                + 'argument, or set TESSDATA_SRC. Without it the local text '
                + 'recogniser cannot run and every fallback converts '
                + 'mathematics only.');
  process.exit(1);
}
const tessdataOut = join(PUBLIC, 'models', 'tessdata');
await mkdir(tessdataOut, { recursive: true });
await copyFile(tessdata, join(tessdataOut, 'eng.traineddata'));
{
  const bytes = await sizeOf(tessdata);
  total += bytes;
  manifest.push({ file: 'models/tessdata/eng.traineddata', bytes });
  console.log(`  ${(bytes / 1048576).toFixed(2).padStart(7)} MiB  ` +
              `models/tessdata/eng.traineddata  (from ${tessdata})`);
}

// Pages refuses a single asset over 25 MiB. Fail here rather than at deploy
// time, and check everything rather than only the model that grew into it
// once.
for (const entry of manifest) {
  if (entry.bytes > 25 * 1024 * 1024) {
    console.error(`\n${entry.file} is ${(entry.bytes / 1048576).toFixed(2)} MiB, ` +
                  'over the 25 MiB per-asset limit for Pages.');
    process.exit(1);
  }
}
await writeFile(join(PUBLIC, 'models', 'manifest.json'),
                JSON.stringify({ files: manifest }, null, 2));

console.log(`\n${manifest.length} files, ${(total / 1048576).toFixed(2)} MiB total.`);
console.log('None of it is fetched unless a conversion falls back to the ' +
            'local path.');
