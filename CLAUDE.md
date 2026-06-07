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
`speasy_proxy/__init__.py` — Creates the FastAPI app via `get_application()`. The app object `app` is the ASGI entry point (e.g., `speasy_proxy:app`).

**Inventory fetch runs at import time** (`spz.update_inventories()` at module level), not in `lifespan`. This is deliberate: production runs gunicorn with `--preload`, so the master process imports the module once (one network fetch), then forks workers that inherit the populated in-memory speasy `tree`. The `lifespan` only calls `mgr.build_inventories()`, which serializes from that in-memory tree with **no network**, then starts the periodic refresh task.

### Layers

- **`api/v1/`** — REST API endpoints, one file per endpoint (get_data, get_inventory, get_cache_entries, get_presets, get_server_status, get_version, get_speasy_version, is_up, chart_roulette, ws_collaboration). Each registers on `api/v1/routes.py`'s shared `router`; `__init__.py` star-imports them all and re-exports the router as `api_router`.
- **`frontend/`** — Jinja2 HTML routes from `frontend/routes.py`: `/` (home), `/plot` (interactive ECharts viewer), `/demo_3d` (3D orbit viewer). Templates in `speasy_proxy/templates/`; static assets (Earth texture, logos) under `speasy_proxy/static/`, mounted at `/static/`.
  - **Frontend JS** lives in `speasy_proxy/static/js/` as plain **ES modules served directly — no bundler, no build step, no TypeScript** (edit a `.js`, reload). Shared modules (`common`, `format`, `inventory-tree`, `magnetosphere`, `plot-core`, `spectrogram`, `api-client`) are unit-tested with **Vitest** (dev-only; `npm run test:js`, tests in `tests/js/`). Per-page entry modules (`home.js`, `plot.js`, `demo3d.js`) hold the relocated page logic and import the shared modules via relative paths. Each template passes `base_url` to its module via a `window.SPEASY_BASE_URL` global; ECharts stays a CDN global. `api-client.js` has a swappable codec seam (JSON now; CDF/WASM later). After editing anything under `static/js/`, run `npm run test:js`. See `speasy_proxy/static/js/README.md`. (CSS still lives inline in the templates — shared `theme.css` extraction was deferred.)
- **`backend/`** — Business logic:
  - `inventory_updater.py` — `InventoryManager`. Pre-serializes every inventory into all format combinations up front (JSON + pickle for every protocol 1..HIGHEST × version 1..2, per provider plus a synthetic `"all"`), so request-time lookup is O(1). Refreshes both periodically (default every 2h) and lazily per-request (the `trigger_inventory_check` dependency on `/get_data`, self-throttled by `update_interval`). Supports `If-Modified-Since` → 304. No locks; refresh runs via `asyncio.to_thread` / BackgroundTask.
  - `resample.py` — Server-side downsampling for `max_points` requests. Dispatches to a pluggable backend: `_resample_numba.py` (`@njit`, optional `[fast]` extra) if importable, else `_resample_numpy.py`. Two strategies: `min_max` (preserves per-bucket extremes) and `lttb` (Largest-Triangle-Three-Buckets, per column). Both backends MUST return identical indices — `test_resample.py` enforces this with equivalence tests. NaN handling is subtle; keep the two backends in lock-step when editing.
  - `bokeh_backend.py` — Generates interactive Bokeh HTML for the `html_bokeh` output format. Line plots via bokeh; spectrograms rendered through matplotlib pcolormesh → RGBA image → `image_rgba`. Embeds a JS callback that re-fetches `/get_data?format=json` on zoom.
  - `presets.py` — Loads plot preset JSON files from `SPEASY_PROXY_PRESETS_PATH` (default `<repo>/presets/`, which does not exist by default → `[]`). Result cached in a module global.
- **`config/`** — Configuration via speasy's `ConfigSection`. Settings controlled by environment variables (see below).
- **`index/`** — Persistent key-value state using `diskcache.Index` (tracks `up_since`).
- **`api/pickle.py`** — Shared pickle serialization utility (clamps requested protocol to `pickle.HIGHEST_PROTOCOL`).
- **`api/compression.py`** — `compress_if_asked` (zstd via pyzstd).

### Key Data Flow
1. Client requests data via `GET /get_data?path=provider/product&start_time=...&stop_time=...`
2. Request is dispatched to speasy's `get_data()` in a thread pool (speasy is synchronous)
3. If `max_points` is set and the result is larger, it is resampled (in a thread pool) via `backend/resample.py`
4. Response is encoded in the requested `format` (`python_dict`/pickle, `speasy_variable`/pickle, `cdf`, `json`, `html_bokeh`) and optionally zstd-compressed
5. Inventory updates happen on a background timer and are also triggered lazily on requests

Error codes: upstream fetch failure → **502**, encode failure → **500** (both as JSON `{"error", "detail"}`).

### Optional Collaboration WebSocket
`ws_collaboration.py` — CRDT-based collaboration endpoint using pycrdt-websocket. Disabled by default; enable via `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE=True`.

### Custom Uvicorn Worker
`UvicornWorker.py` — `SpeasyUvicornWorker` extends uvicorn-worker for gunicorn deployment with proxy header support and configurable log config.

## Environment Variables

- `SPEASY_PROXY_PREFIX` — URL path prefix (root_path for reverse proxy setups)
- `SPEASY_PROXY_CORE_INVENTORY_UPDATE_INTERVAL` — Seconds between inventory refreshes (default: 7200)
- `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE` — Enable WebSocket collaboration endpoint
- `SPEASY_PROXY_LOG_CONFIG_FILE` — Path to logging YAML config
- `SPEASY_PROXY_PRESETS_PATH` — Directory of plot preset JSON files (default `<repo>/presets/`)
- `SPEASY_PROXY_INDEX_PATH` — `diskcache.Index` location for the proxy's own state (default `/tmp`)
- `SPEASY_CACHE_PATH`, `SPEASY_INDEX_PATH` — speasy storage paths (used in Docker)

The Docker image also sets `SPEASY_CORE_HTTP_REWRITE_RULES` to redirect CDAWeb file fetches to a local LPP mirror.

## Testing

```bash
uv run pytest
```

Tests are discovered from `speasy_proxy/` (`test*.py`, per `pyproject.toml`) **and** the top-level `tests/` dir:
- `speasy_proxy/backend/test_resample.py` — resampling behavior + numpy/numba backend equivalence (numba tests skip if not installed).
- `tests/test_api.py` — endpoint integration tests via `fastapi.testclient.TestClient` (hits real providers, so requires network).
