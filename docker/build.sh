#!/usr/bin/env sh

BASEDIR=$(dirname "$0")
PORT=${1:-6543}
NAME=${2:-spwc_proxy}
docker build --build-arg PORT=$PORT -t $NAME -f $BASEDIR/Dockerfile $BASEDIR/../../
