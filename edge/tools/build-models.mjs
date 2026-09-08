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
 *
 * The model directory is whatever S2 produced; point MFR_SRC at it.
 *
 *     node tools/build-models.mjs [<mfr-source-dir>]
 */
import { mkdir, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PUBLIC = resolve(process.env.CONTEX_PUBLIC || 'public');
const ORT_SRC = resolve('node_modules/onnxruntime-web/dist');
const MFR_SRC = resolve(process.argv[2] || process.env.MFR_SRC || '');

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
  // Pages refuses a single asset over 25 MiB, and the encoder is the one that
  // could grow into it. Fail here rather than at deploy time.
  for (const entry of manifest) {
    if (entry.bytes > 25 * 1024 * 1024) {
      console.error(`\n${entry.file} is ${(entry.bytes / 1048576).toFixed(2)} MiB, ` +
                    'over the 25 MiB per-asset limit for Pages.');
      process.exit(1);
    }
  }
  await writeFile(join(mfrOut, 'manifest.json'),
                  JSON.stringify({ files: manifest }, null, 2));
}

console.log(`\n${manifest.length} files, ${(total / 1048576).toFixed(2)} MiB total.`);
console.log('None of it is fetched unless a conversion falls back to the ' +
            'local path.');
