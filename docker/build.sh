#!/usr/bin/env sh

BASEDIR=$(dirname "$0")
PORT=${1:-6543}
NAME=${2:-speasy_proxy}
SPEASY=${3:-speasy}
docker build --build-arg PORT=$PORT --build-arg SPEASY=$SPEASY -t $NAME -f $BASEDIR/Dockerfile $BASEDIR/../../
