#!env sh

BASEDIR=$(dirname "$0")
docker build -t spwc_proxy -f $BASEDIR/Dockerfile $BASEDIR/../../
