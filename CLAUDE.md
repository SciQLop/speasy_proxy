# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

speasy-proxy is a FastAPI-based caching proxy server for [speasy](https://github.com/SciQLop/speasy), a Python library for accessing space physics data. It serves as an intermediary that caches data from providers like AMDA, CDAWeb, and SSCWeb, reducing load on upstream servers and improving response times.

## Build & Development

```bash
# Setup
uv sync --dev

# Run locally (development)
uv run uvicorn speasy_proxy:app --reload

# Run tests
uv run pytest

# Production (via gunicorn with custom worker)
uv run gunicorn speasy_proxy:app -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker

# Container (Podman recommended)
docker/build.sh
```

Build system: **hatchling** (pyproject.toml), managed with **uv**. Version bumps use **bump-my-version** (updates pyproject.toml, `speasy_proxy/__init__.py`, and VERSION file).

## Architecture

### Application Entry Point
`speasy_proxy/__init__.py` — Creates the FastAPI app via `get_application()`. The `lifespan` context manager triggers initial inventory update on startup. The app object `app` is the ASGI entry point (e.g., `speasy_proxy:app`).

### Layers

- **`api/v1/`** — REST API endpoints mounted under the v1 router. Each endpoint is in its own file (get_data, get_inventory, get_cache_entries, etc.). Routes are registered on `api/v1/routes.py`'s `router`, re-exported via `__init__.py`.
- **`frontend/`** — HTML-serving routes (home page via Jinja2 templates, 404 page). Uses its own router from `frontend/routes.py`.
- **`backend/`** — Business logic:
  - `inventory_updater.py` — Periodically refreshes provider inventories (default: every 2 hours). Pre-serializes inventories in all format/protocol combinations (JSON + pickle with multiple protocol versions). Thread-safe with a lock.
  - `bokeh_backend.py` — Generates interactive Bokeh HTML plots for the `html_bokeh` output format. Supports line plots and spectrograms.
- **`config/`** — Configuration via speasy's `ConfigSection`. Settings are controlled by environment variables (e.g., `SPEASY_PROXY_PREFIX`, `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE`, `SPEASY_PROXY_CORE_INVENTORY_UPDATE_INTERVAL`).
- **`index/`** — Persistent key-value state using `diskcache.Index` (tracks uptime, etc.).
- **`api/pickle.py`** — Shared pickle serialization utility.

### Key Data Flow
1. Client requests data via `GET /get_data?path=provider/product&start_time=...&stop_time=...`
2. Request is dispatched to speasy's `get_data()` in a thread pool
3. Response is encoded in the requested format (python_dict/pickle, CDF, JSON, html_bokeh) and optionally zstd-compressed
4. Inventory updates happen on a background timer and are also triggered lazily on requests

### Optional Collaboration WebSocket
`ws_collaboration.py` — CRDT-based collaboration endpoint using pycrdt-websocket. Disabled by default; enable via `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE=True`.

### Custom Uvicorn Worker
`UvicornWorker.py` — `SpeasyUvicornWorker` extends uvicorn-worker for gunicorn deployment with proxy header support and configurable log config.

## Environment Variables

- `SPEASY_PROXY_PREFIX` — URL path prefix (root_path for reverse proxy setups)
- `SPEASY_PROXY_CORE_INVENTORY_UPDATE_INTERVAL` — Seconds between inventory refreshes (default: 7200)
- `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE` — Enable WebSocket collaboration endpoint
- `SPEASY_PROXY_LOG_CONFIG_FILE` — Path to logging YAML config
- `SPEASY_CACHE_PATH`, `SPEASY_INDEX_PATH` — Storage paths (used in Docker)

## Testing

Tests live alongside source code in `speasy_proxy/` (pytest discovers `test*.py` files there per `pyproject.toml`). Currently no test files exist in the repo.
