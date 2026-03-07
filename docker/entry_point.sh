#!/usr/bin/env bash

mkdir -p $SPEASY_LOG_PATH/speasy $SPEASY_CDAWEB_INVENTORY_DATA_PATH
uv run gunicorn speasy_proxy:app --timeout 600 --max-requests 10000 --backlog 2048 --worker-connections 1000 -w 32 --threads=8 -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker
