"""
Rebuild the INT8 pix2text-mfr the browser recogniser runs on.

WHY THIS EXISTS. `public/models/` is gitignored, for the same reason
`public/texmf/` is: a repository is not a CDN. Everything else under
`public/` that is not in git is produced by a documented command -- except,
until this file, the model. It was quantised once, by hand, and the directory
it came from is gone. An artefact that cannot be regenerated is one disk
failure away from being unrecoverable, and it is not something to discover
after a deploy.

WHAT IT PRODUCES. `onnxruntime.quantization.quantize_dynamic` over the
encoder and decoder of breezedeus/pix2text-mfr. That is what the shipped
weights are: their graphs are full of `MatMulInteger`, which is what dynamic
quantisation emits and nothing else does. The output layout is the one
tools/build-models.mjs reads.

    python tools/build-mfr.py [<output-dir>]    # default model-src/mfr-int8
    npm run build:models -- model-src/mfr-int8

VERIFYING IT. If `public/models/mfr/` already holds a build, this compares the
new files against it and says whether they are byte-identical. They should be:
dynamic quantisation is deterministic for a given ONNX Runtime version. If they
are not -- a newer runtime, a changed default -- the numbers that matter are
still measurable, and `npm run test:formulas` is what measures them: it scores
the shipped module over the same 75-image benchmark S2 used and fails if the
accuracy has drifted.
"""

import hashlib
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, 'model-src', 'mfr-int8')
SHIPPED = os.path.join(REPO, 'public', 'models', 'mfr')

MODEL_ID = 'breezedeus/pix2text-mfr'

# The two graphs, and what build-models.mjs expects them to be called.
PARTS = [('encoder_model.onnx', 'encoder_model_quantized.onnx'),
         ('decoder_model.onnx', 'decoder_model_quantized.onnx')]


def digest(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def source_dir():
    """The full-precision export, from the Hugging Face cache or the hub."""
    from huggingface_hub import snapshot_download
    return snapshot_download(
        MODEL_ID,
        allow_patterns=['*.onnx', 'tokenizer.json', 'tokenizer_config.json',
                        'special_tokens_map.json', 'config.json',
                        'generation_config.json', 'preprocessor_config.json'])


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    out = os.path.abspath(argv[0]) if argv else DEFAULT_OUT

    from onnxruntime.quantization import quantize_dynamic, QuantType

    source = source_dir()
    print(f'source: {source}')
    onnx_out = os.path.join(out, 'onnx')
    os.makedirs(onnx_out, exist_ok=True)

    for name, target in PARTS:
        src = os.path.join(source, name)
        if not os.path.exists(src):
            # Some snapshots keep the graphs under onnx/.
            src = os.path.join(source, 'onnx', name)
        dst = os.path.join(onnx_out, target)
        print(f'quantising {name} -> onnx/{target}')
        # MatMul ONLY, and that restriction is the whole recipe.
        #
        # The default also quantises Conv, which emits ConvInteger -- and
        # ONNX Runtime **Web** has no wasm kernel for it. Measured: a default
        # build loads in Python and fails in the browser with "Could not find
        # an implementation for ConvInteger(10) node with name
        # '/embeddings/patch_embeddings/projection/Conv_quant'". It is 0.9 MB
        # smaller and completely unusable, which is the worst combination for
        # something nobody re-tests.
        #
        # The patch-embedding convolution therefore stays float32. That is
        # where the size difference goes, and the accuracy the suite measures
        # is measured with it float.
        quantize_dynamic(src, dst, weight_type=QuantType.QInt8,
                         op_types_to_quantize=['MatMul'])

    shutil.copyfile(os.path.join(source, 'tokenizer.json'),
                    os.path.join(out, 'tokenizer.json'))

    print(f'\nwrote {out}')
    print('install it with:  npm run build:models -- ' + os.path.relpath(out, REPO))

    # Compare against whatever is currently deployed, if anything.
    pairs = [('encoder.onnx', os.path.join(onnx_out, PARTS[0][1])),
             ('decoder.onnx', os.path.join(onnx_out, PARTS[1][1])),
             ('tokenizer.json', os.path.join(out, 'tokenizer.json'))]
    if all(os.path.exists(os.path.join(SHIPPED, name)) for name, _ in pairs):
        print('\nagainst the build already in public/models/mfr:')
        same = True
        for name, built in pairs:
            a = digest(os.path.join(SHIPPED, name))
            b = digest(built)
            print(f'  {name:<16} {"identical" if a == b else "DIFFERENT"}')
            same = same and a == b
        if not same:
            print('\nThe rebuild is not byte-identical. That is not necessarily '
                  'wrong -- a different ONNX Runtime quantises differently -- '
                  'but the accuracy is no longer assumed. Install it and run '
                  '`npm run test:formulas`, which scores it against the same '
                  '75-image benchmark and fails on a drift.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
