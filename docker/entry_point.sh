#!/usr/bin/env bash


python3 /home/speasy/speasy_proxy/speasy_config.py --cache-size $SPWC_CACHE_SIZE --cache-path $SPWC_CACHE_PATH --index-path $SPWC_INDEX_PATH --enable-proxy $SPWC_PROXY --proxy-prefix $SPWC_PROXY_PREFIX --server-port $PORT --proxy-url $SPWC_PROXY_URL --config-path /home/speasy/speasy_proxy/docker.ini
/home/speasy/.local/bin/pserve /home/speasy/speasy_proxy/docker.ini