#!/usr/bin/env bash

#~/.local/bin/gunicorn  speasy_proxy:app -w 32 -k uvicorn.workers.UvicornWorker --ws-max-queue=128  --backlog=32 --limit-max-requests=1024 --root-path=$SPEASY_PROXY_PREFIX --host="0.0.0.0" --port=$PORT --proxy-headers --limit-concurrency=10000 --log-config=/home/speasy/speasy_proxy/logging.yaml
~/.local/bin/gunicorn  speasy_proxy:app --timeout 600 --max-requests 10000 --backlog 2048  --worker-connections 1000 -w 32 --threads=8 -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker