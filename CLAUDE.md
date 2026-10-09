# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

speasy-proxy is a FastAPI-based caching proxy server for [speasy](https://github.com/SciQLop/speasy), a Python library for accessing space physics data. It serves as an intermediary that caches data from providers like AMDA, CDAWeb, and SSCWeb, reducing load on upstream servers and improving response times.

## Build & Development

```bash
# Setup
uv sync --extra dev

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
- **`frontend/`** — Jinja2 HTML routes from `frontend/routes.py`: `/` (home), `/plot` (interactive uPlot viewer), `/demo_3d` (3D orbit viewer). Templates in `speasy_proxy/templates/`; static assets (Earth texture, logos) under `speasy_proxy/static/`, mounted at `/static/`.
  - **Frontend JS** lives in `speasy_proxy/static/js/` as plain **ES modules served directly — no bundler, no build step, no TypeScript** (edit a `.js`, reload). Shared modules (`common`, `format`, `inventory-tree`, `magnetosphere`, `plot-core`, `spectrogram`, `api-client`, plus `/plot`'s chart layer `plot-view`/`plot-gestures`) are unit-tested with **Vitest** (dev-only; `npm run test:js`, tests in `tests/js/`). Per-page entry modules (`home.js`, `plot.js`, `demo3d.js`) hold the relocated page logic and import the shared modules via relative paths. Each template passes `base_url` to its module via a `window.SPEASY_BASE_URL` global. `/plot` draws with **uPlot**, vendored as an ES module in `static/js/vendor/` (one uPlot per subplot; see `plot-view.js`); `/demo_3d` still uses ECharts + ECharts-GL as CDN globals. `api-client.js` has a swappable codec seam: `jsonCodec` (default) and `cdfCodec` (`cdf-codec.js`, decodes `format=cdf` in-browser via the vendored CDFpp-WASM build in `static/js/vendor/`; opt in with `window.SPEASY_USE_CDF=true`, off by default, JSON fallback on any failure). After editing anything under `static/js/`, run `npm run test:js`. See `speasy_proxy/static/js/README.md`. (CSS still lives inline in the templates — shared `theme.css` extraction was deferred.)
- **`backend/`** — Business logic:
  - `inventory_updater.py` — `InventoryManager`. Eagerly pre-serializes the common inventory variants (JSON + pickle protocol 3 × versions 1..2, per provider plus a synthetic `"all"`) and keeps **only their zstd-compressed copies** in memory (raw copies were ~93% of ~620 MB per worker): zstd requests are O(1), uncompressed ones decompress on demand in the threadpool, never memoized. Rarer valid combinations (pickle protocols 1, 2, 4, 5) are built lazily on first request and memoized. Refreshes both periodically (default every 2h) and lazily per-request (the `trigger_inventory_check` dependency on `/get_data`, self-throttled by `update_interval`). Supports `If-Modified-Since` → 304 and sends `Last-Modified` on 200s. No locks; refresh runs via `asyncio.to_thread` / BackgroundTask.
  - `resample.py` — Server-side downsampling for `max_points` requests. Dispatches to a pluggable backend: `_resample_numba.py` (`@njit`, optional `[fast]` extra) if importable, else `_resample_numpy.py`. Two strategies: `min_max` (preserves per-bucket extremes) and `lttb` (Largest-Triangle-Three-Buckets, per column). Spectrograms (a variable with a second axis) bypass both: one real row per time bucket (`max_points/2` buckets, the most intense row), stamped at the bucket centre so rows are evenly spaced and the `/plot` image only leaves real gaps empty. Both backends MUST return identical indices — `test_resample.py` enforces this with equivalence tests. NaN handling is subtle; keep the two backends in lock-step when editing.
  - `bokeh_backend.py` — Generates interactive Bokeh HTML for the `html_bokeh` output format. Line plots via bokeh; spectrograms rendered through matplotlib pcolormesh → RGBA image → `image_rgba`. Embeds a JS callback that re-fetches `/get_data?format=json` on zoom.
  - `presets.py` — Loads plot preset JSON files from `SPEASY_PROXY_PRESETS_PATH` (default `speasy_proxy/presets/`, shipped in the package: root files show in the /plot sidebar, `featured/` ones also as home-page cards). Result cached in a module global.
- **`config/`** — Configuration via speasy's `ConfigSection`. Settings controlled by environment variables (see below).
- **`index/`** — Persistent key-value state using `diskcache.Index` (tracks `up_since`).
- **`api/pickle.py`** — Shared pickle serialization utility (clamps requested protocol to `pickle.HIGHEST_PROTOCOL`).
- **`api/compression.py`** — `compress_if_asked` (zstd via pyzstd) and `blosc_arrays` (`compression=blosc`: each numeric numpy array of a `python_dict` payload becomes `{"__blosc__": chunk, "dtype", "shape"}`, byte-shuffle + zstd1 via numcodecs, mime `application/x-speasy-blosc-pickle`; takes precedence over `zstd_compression`, unknown values ignored). Client side: SciQLop/speasy#373.

### Key Data Flow
1. Client requests data via `GET /get_data?path=provider/product&start_time=...&stop_time=...`
2. Request is dispatched to speasy's `get_data()` in a thread pool (speasy is synchronous)
3. If `max_points` is set and the result is larger, it is resampled (in a thread pool) via `backend/resample.py`
4. Response is encoded in the requested `format` (`python_dict`/pickle, `speasy_variable`/pickle, `cdf`, `json`, `html_bokeh`) and optionally zstd-compressed (or blosc-compressed per array); `/get_data` also sends a `Server-Timing` header (`queue`/`fetch`/`resample`/`encode` ms)
5. Inventory updates happen on a background timer and are also triggered lazily on requests

Error codes: upstream fetch failure → **502**, encode failure → **500** (both as JSON `{"error", "detail"}`).

### HAPI server (`/hapi`)
`speasy_proxy/hapi/` — a [HAPI](https://hapi-server.org) 3.2 server over speasy, built as a **self-contained FastAPI sub-app** (`create_hapi_app(...)`, mounted in `get_application()`). It imports nothing else from `speasy_proxy`: the proxy passes in `fetch(path, start, stop)`, the `/info` cache path, the max request span and `tree_lock` (the `InventoryManager`'s), so the package can be lifted out on its own. Tests: `speasy_proxy/hapi/test_hapi.py` (offline, fake inventory + fake upstream).
- **Datasets** (`catalog.py`): amda/csa → a speasy dataset; cda → a speasy dataset split per `DEPEND_0` as `cda/<DATASET>@<i>` like CDAWeb's own HAPI server (needs speasy with `DEPEND_0` in the CDA inventory, SciQLop/speasy#401 — CDA is left out otherwise); ssc/cdpp3dview → one dataset per body with one parameter per coordinate frame (`position_gse`, `position_J2000`…, frame lists `SSC_FRAMES`/`CDPP3DVIEW_FRAMES` — a curated subset for 3DView's 106 frames), tagged with `coordinateSystemName`; only the default frame is sampled for `/info`, the others are described as copies (`like`) and fetched on demand. Parameters are fetched by a fetch key (`path?option=value`) so get_data options like the frame reach `fetch(path, start, stop, **options)`. AMDA templated and private parameters are left out.
- **`/info`** (`info.py`) is built from a sample of real data (parameters probe in turn until one finds a window with data, then the others are fetched there and further out), because clients reject `/data` that doesn't match `/info`. The declared sample range holds data for every described parameter; Time is always declared with nanoseconds (a precision read off the sample could truncate finer timestamps elsewhere). Cached in `diskcache` at `<SPEASY_PROXY_INDEX_PATH>/hapi_info` for 7 days (failures for 1 h); bump `INFO_FORMAT_VERSION` in `service.py` when the description logic changes. First `/info` of a dataset can be slow (minutes for CDA virtual variables).
- **`/data`** (`encoding.py`) fetches each requested parameter and writes them on the union of their timestamps, a parameter's missing records as its fill (or NaN); parameters whose spans overlap without a common timestamp are a 1500, as they were never on one time axis. Values are forced to the declared shape/type (csv or binary). float32 fills are spelled as float32 prints so CSV and binary both match `/info`.
- Errors are HAPI status JSON (`status.py`), never FastAPI 422s: query params are parsed by hand.

### Optional Collaboration WebSocket
`ws_collaboration.py` — CRDT-based collaboration endpoint using pycrdt-websocket. Disabled by default; enable via `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE=True`.

### Custom Uvicorn Worker
`UvicornWorker.py` — `SpeasyUvicornWorker` extends uvicorn-worker for gunicorn deployment with proxy header support and configurable log config.

## Environment Variables

- `SPEASY_PROXY_PREFIX` — URL path prefix (root_path for reverse proxy setups)
- `SPEASY_PROXY_CORE_INVENTORY_UPDATE_INTERVAL` — Seconds between inventory refreshes (default: 7200)
- `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE` — Enable WebSocket collaboration endpoint
- `SPEASY_PROXY_LOG_CONFIG_FILE` — Path to logging YAML config
- `SPEASY_PROXY_PRESETS_PATH` — Directory of plot preset JSON files (default `speasy_proxy/presets/`)
- `SPEASY_PROXY_INDEX_PATH` — `diskcache.Index` location for the proxy's own state (default `/tmp`)
- `SPEASY_PROXY_WORKERS` — gunicorn worker count in the Docker entry point (default `2 × nproc`)
- `SPEASY_CACHE_PATH`, `SPEASY_INDEX_PATH` — speasy storage paths (used in Docker)

The Docker image also sets `SPEASY_CORE_HTTP_REWRITE_RULES` to redirect CDAWeb file fetches to a local LPP mirror.

## Testing

```bash
uv run pytest
```

Tests are discovered from `speasy_proxy/` (`test*.py`, per `pyproject.toml`) **and** the top-level `tests/` dir:
- `speasy_proxy/backend/test_resample.py` — resampling behavior + numpy/numba backend equivalence (numba tests skip if not installed).
- `tests/test_api.py` — endpoint integration tests via `fastapi.testclient.TestClient` (hits real providers, so requires network).
- `tests/hapi_conformance/run.sh` — HAPI compliance, offline, also run in CI (`.github/workflows/hapi-conformance.yml`): starts the HAPI sub-app over a synthetic inventory (`server.py`, one dataset per shape speasy data can take) and runs `check.py`, which (1) runs the official verifier (`hapi-server/verifier-nodejs`, pinned by `VERIFIER_SHA`) on every dataset, failing on any failure or any warning not in `ALLOWED_WARNINGS` (each entry has its reason), and (2) checks the data the verifier doesn't parse: strict CSV parse, CSV/binary agreement with the `/info` layout (fill cells exact), and `hapiclient` reading both formats. Needs uv, node and git; a new dataset shape belongs in `server.py`.
