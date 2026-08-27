# ConTeX - container image for Cloud Run (or any other container host).
#
# WHY THIS FILE EXISTS AT ALL. Firebase Hosting serves static files; it cannot
# run Python. This app is a Flask server that shells out to a TeX engine,
# Tesseract and Poppler, and loads an ONNX model - so Hosting reaches it
# through a rewrite to a Cloud Run service (see firebase.json), and this is
# what that service runs.
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
# is a preview the user cannot trust. latex_tools reports a missing package
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
# torch first, from the CPU index. The default wheel bundles CUDA and is about
# 2.5 GB; this one is around 200 MB, and there is no GPU on Cloud Run to use
# the difference. Installed ahead of requirements.txt so the pinned version
# there resolves against what is already present.
COPY requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.0 \
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
# all deleted after TEX_STORE_TTL_SECONDS. On Cloud Run /tmp is a tmpfs, so
# this is memory rather than disk - which is why the store has a TTL and a
# per-session cap in the first place.
ENV UPLOAD_FOLDER=/tmp/contex

# Nothing here needs to be root, and the image has a TeX distribution in it.
RUN useradd --create-home --uid 10001 contex \
    && mkdir -p /tmp/contex \
    && chown -R contex:contex /app /tmp/contex
USER contex

# Cloud Run hands the port in $PORT and expects the container to listen on it.
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
    app:app
