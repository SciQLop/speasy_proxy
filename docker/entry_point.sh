#!/usr/bin/env bash


python3 /home/spwc/spwc_proxy/spwc_config.py --cache-size $SPWC_CACHE_SIZE --cache-path $SPWC_CACHE_PATH --index-path $SPWC_INDEX_PATH --enable-proxy $SPWC_PROXY --proxy-prefix $SPWC_PROXY_PREFIX --server-port $PORT --proxy-url $SPWC_PROXY_URL --config-path /home/spwc/spwc_proxy/docker.ini
/home/spwc/.local/bin/pserve /home/spwc/spwc_proxy/docker.ini