# ConTeX - the container image. This is the deployment unit.
#
# WHY THIS FILE EXISTS AT ALL. Firebase Hosting serves static files; it cannot
# run Python. This app is a Flask server that shells out to a TeX engine,
# Tesseract and Poppler, and loads an ONNX model, so it has to run somewhere
# that can hold all three.
#
# Built for linux/arm64 by .github/workflows/deploy.yml and run by
# docker-compose.yml on an Oracle Ampere VM - see DEPLOYMENT.md. The x86 path
# is kept working throughout so the same file still builds for Cloud Run or any
# other container host.
#
# The three native binaries below are not optional extras. Without a TeX
# engine there is no PDF preview; without Poppler no PDF can be opened at all;
# without Tesseract the local fallback cannot read a page. The app degrades
# honestly when they are missing, but it degrades.

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
# texlive-latex-extra is the large one (~1 GB). It is here because the model
# writes the LaTeX, and a transcribed document can legitimately ask for a
# package outside the base set; a preview that fails on \usepackage{siunitx}
# is a preview the user cannot trust. The engine reports a missing package
# clearly rather than crashing, so this is a quality decision, not a
# correctness one - trim it if image size matters more than preview coverage.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        poppler-utils \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
        texlive-science \
        ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------------------
# Python packages
# ---------------------------------------------------------------------------
# The torch step is architecture-dependent, which is why it is a conditional
# rather than one flat command.
#
# On x86-64, PyPI's torch bundles CUDA and weighs about 2.5 GB. There is no GPU
# on any host this image targets, so it is fetched from the CPU index instead -
# around 200 MB - ahead of requirements.txt, so the pin there resolves against
# what is already installed.
#
# On arm64 there is no CUDA wheel to avoid: PyPI's aarch64 torch is CPU-only
# already, and the CPU index does not carry aarch64 at all. Asking for it there
# fails. So the plain resolve is both correct and smaller.
#
# TARGETARCH is set by BuildKit. Keeping both paths means the same Dockerfile
# builds for the Ampere VM and for a container host on x86 without editing.
ARG TARGETARCH
COPY requirements.txt ./
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.0; \
    fi \
    && pip install -r requirements.txt

# ---------------------------------------------------------------------------
# The formula model
# ---------------------------------------------------------------------------
# Baked in rather than downloaded on first use. The local fallback runs
# precisely when the AI is already unavailable, and having it then pause to
# fetch several hundred megabytes from huggingface.co - possibly failing, on a
# container that may be about to be recycled - is the wrong behaviour at the
# worst moment.
ENV HF_HOME=/opt/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
RUN HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('breezedeus/pix2text-mfr')" \
    && chmod -R a+rX /opt/huggingface

# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------
# .dockerignore is what keeps .env, the service account key, the virtualenv
# and the benchmark corpus out of this. Check it before changing this line.
COPY . .

# Generated results live here: a .tex, its compiled PDF and the page images,
# all deleted after TEX_STORE_TTL_SECONDS. Inside the container this is the
# writable layer, and on a serverless host it is a tmpfs charged against
# memory - which is why the store has a TTL and a per-session cap either way.
ENV UPLOAD_FOLDER=/tmp/contex

# Nothing here needs to be root, and the image has a TeX distribution in it.
RUN useradd --create-home --uid 10001 contex \
    && mkdir -p /tmp/contex \
    && chown -R contex:contex /app /tmp/contex
USER contex

# Which commit this image was built from, reported at /healthz.
#
# Deployment is pull-based: the server fetches new images on a timer, so a
# successful build says nothing about what is actually serving. This is what
# lets the release workflow ask the live site which commit it is running and
# fail if the answer never becomes the right one.
#
# Declared last on purpose. It changes on every single build, and an ARG placed
# higher would invalidate every layer beneath it - including the TeX install and
# the model download.
ARG GIT_SHA=dev
ENV CONTEX_REVISION=$GIT_SHA

# The port the container listens on. Cloud Run overrides $PORT at run time;
# Caddy reaches it at this one.
ENV PORT=8080
EXPOSE 8080

# gthread rather than sync workers: a conversion spends most of its time
# waiting on the model's HTTP response or on a pdflatex subprocess, so threads
# are what keeps a worker useful during it.
#
# --timeout 300 because a ten-page PDF really can take minutes and gunicorn's
# default of 30 seconds would kill the worker in the middle of a legitimate
# conversion. The model call has its own 180s ceiling (AI_QA_REQUEST_TIMEOUT)
# and the compile has 120s (LATEX_COMPILE_TIMEOUT), so this sits above both
# rather than cutting either short.
#
# Shell form, deliberately, despite the JSONArgsRecommended lint: $PORT has to
# be expanded, and Cloud Run supplies it at run time rather than at build time.
# The `exec` is what makes that safe - the shell replaces itself with gunicorn,
# so gunicorn is PID 1 and receives SIGTERM directly, which is the thing the
# lint is actually warning about.
CMD exec gunicorn \
    --bind ":$PORT" \
    --worker-class gthread \
    --workers "${GUNICORN_WORKERS:-2}" \
    --threads "${GUNICORN_THREADS:-8}" \
    --timeout 300 \
    --graceful-timeout 30 \
    --keep-alive 65 \
    --access-logfile - \
    --error-logfile - \
    wsgi:app
