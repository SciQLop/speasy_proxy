#!/usr/bin/env bash


python3 /home/speasy/speasy_proxy/speasy_config.py --log-level $SPEASY_PROXY_LOG_LEVEL --cache-size $SPEASY_CACHE_SIZE --cache-path $SPEASY_CACHE_PATH --index-path $SPEASY_INDEX_PATH --enable-proxy $SPEASY_PROXY --proxy-prefix $SPEASY_PROXY_PREFIX --server-port $PORT --proxy-url $SPEASY_PROXY_URL --config-path /home/speasy/speasy_proxy/docker.ini
/home/speasy/.local/bin/pserve /home/speasy/speasy_proxy/docker.ini