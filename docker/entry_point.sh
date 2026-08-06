#!/usr/bin/env bash

mkdir -p $SPEASY_LOG_PATH/speasy $SPEASY_CDAWEB_INVENTORY_DATA_PATH
uv run gunicorn speasy_proxy:app --preload --timeout 600 --max-requests 10000 --backlog 2048 -w ${SPEASY_PROXY_WORKERS:-$(( $(nproc) * 2 ))} -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker
