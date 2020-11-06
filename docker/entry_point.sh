#!/usr/bin/env bash

python3 /home/spwc/spwc_proxy/spwc_config.py -s $SPWC_CACHE_SIZE -p $SPWC_CACHE_PATH -i $SPWC_INDEX_PATH && /home/spwc/.local/bin/pserve /home/spwc/spwc_proxy/production.ini