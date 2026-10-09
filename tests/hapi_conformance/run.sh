#!/usr/bin/env bash
# HAPI compliance check, offline: the HAPI sub-app over a synthetic inventory (server.py), checked by
# the official HAPI verifier and the official Python client (check.py). Same script locally and in CI.
#
#   tests/hapi_conformance/run.sh
#
# Needs uv, node >= 16, npm and git. The verifier is pinned (bump VERIFIER_SHA deliberately: new
# verifier versions add checks) and cached under ${XDG_CACHE_HOME:-~/.cache}.
set -euo pipefail

VERIFIER_SHA=fc8563105db153216002aa14581b2b690235f5f6  # hapi-server/verifier-nodejs, 2026-05-18
HAPICLIENT_VERSION=0.3.3
PORT=${HAPI_CONFORMANCE_PORT:-8765}

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VERIFIER_DIR=${VERIFIER_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/speasy-proxy/hapi-verifier-$VERIFIER_SHA}

if [ ! -f "$VERIFIER_DIR/verify.js" ]; then
  rm -rf "$VERIFIER_DIR"
  git clone --quiet https://github.com/hapi-server/verifier-nodejs.git "$VERIFIER_DIR"
  git -C "$VERIFIER_DIR" checkout --quiet "$VERIFIER_SHA"
  git -C "$VERIFIER_DIR" submodule update --quiet --init --recursive
  (cd "$VERIFIER_DIR" && npm ci --no-audit --no-fund --silent)
fi

cd "$ROOT"
LOG=$(mktemp)
uv run uvicorn --app-dir tests/hapi_conformance server:app --port "$PORT" > "$LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 120); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/about" && break
  kill -0 $SERVER 2>/dev/null || { echo "conformance server died:"; cat "$LOG"; exit 1; }
  sleep 1
done

uv run --with "hapiclient==$HAPICLIENT_VERSION" python tests/hapi_conformance/check.py \
  --url "http://127.0.0.1:$PORT" --verifier "$VERIFIER_DIR/verify.js"
