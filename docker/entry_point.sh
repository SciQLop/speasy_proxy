#!/usr/bin/env bash

~/.local/bin/uvicorn speasy_proxy:app --root-path $SPEASY_PROXY_PREFIX --port $PORT --proxy-headers --limit-concurrency 10000 --log-config /home/speasy/speasy_proxy/logging.yaml