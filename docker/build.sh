#!/usr/bin/env sh

BASEDIR=$(dirname "$0")
PORT=${1:-6543}
NAME=${2:-spwc_proxy}
SPWC=${3:-spwc}
docker build --build-arg PORT=$PORT --build-arg SPWC=$SPWC -t $NAME -f $BASEDIR/Dockerfile $BASEDIR/../../
