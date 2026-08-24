#!/usr/bin/env bash

mkdir -p $SPEASY_LOG_PATH/speasy $SPEASY_CDAWEB_INVENTORY_DATA_PATH
# --no-sync: the image is fully assembled at build time (uv sync + the
# $SPEASY override in the Dockerfile). Without it, `uv run` silently
# re-syncs the venv against uv.lock's "speasy>=1.6.0" pin before every
# start, discarding a git-based SPEASY override back to the locked PyPI
# version.
uv run --no-sync gunicorn speasy_proxy:app --preload --timeout 600 --max-requests 10000 --max-requests-jitter 1000 --backlog 2048 -w ${SPEASY_PROXY_WORKERS:-$(( $(nproc) * 2 ))} -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker
