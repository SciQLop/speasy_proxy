# speasy-proxy

[![PyPI version](https://badge.fury.io/py/speasy-proxy.svg)](https://pypi.org/project/speasy-proxy/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

A fast caching proxy server for [speasy](https://github.com/SciQLop/speasy), reducing load on upstream data providers (AMDA, CDAWeb, SSCWeb) and improving response times for space physics data access.

## Using the public instance

A public instance is available at: https://sciqlop.lpp.polytechnique.fr/cache/

speasy uses this proxy by default — no configuration needed. You can browse the available data and interactive API docs at that URL.

### From any language (curl, JS, Julia, IDL, Matlab...)

```bash
BASE=https://sciqlop.lpp.polytechnique.fr/cache
# One hour of ACE IMF from AMDA, as JSON
curl "$BASE/get_data?path=amda/imf&start_time=2020-01-01T00:00:00&stop_time=2020-01-01T01:00:00&format=json"
# Same, as an ISTP CDF file (keeps all metadata)
curl -OJ "$BASE/get_data?path=amda/imf&start_time=2020-01-01T00:00:00&stop_time=2020-01-01T01:00:00&format=cdf"
# At most ~2000 points per component, server-side downsampled
curl "$BASE/get_data?path=amda/imf&start_time=2020-01-01&stop_time=2020-02-01&format=json&max_points=2000"
```

- `path` is `<provider>/<product id>`. Browse `/plot` to find one: the selected product's path shows under the search box, and its Code button prints ready-made requests.
- Times are ISO-8601 (UTC when no offset is given) or Unix epoch seconds.
- Formats: `json` and `cdf` are language-neutral. `python_dict` and `speasy_variable` are Python pickles (what speasy itself uses). `html_bokeh` is an interactive plot page.
- JSON: fill values and NaN are `null`; times (`axes[0].values`) are int64 nanoseconds since 1970-01-01 UTC — parse them as 64-bit integers, not floats.
- Errors are JSON `{"error", "detail"}`: 400 bad time range, 404 unknown provider/product, 422 invalid parameter, 502 upstream provider failure.

---

## Deploying your own instance

### Container (recommended)

Podman is recommended, but Docker works too.

```bash
# Build the image
./docker/build.sh [PORT] [NAME] [SPEASY_PACKAGE]

# Run with Podman (--stop-timeout must exceed gunicorn's 30 s graceful timeout,
# otherwise a stop SIGKILLs requests still in flight; podman's default is 10 s)
podman run -d -p 6543:6543 --stop-timeout 40 \
  -v speasy-cache:/data \
  -v speasy-index:/index \
  speasy_proxy
```

### From source

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync

# Development
uv run uvicorn speasy_proxy:app --reload

# Production
uv run gunicorn speasy_proxy:app -k speasy_proxy.UvicornWorker.SpeasyUvicornWorker
```

## Configuration

All settings are controlled via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SPEASY_PROXY_PREFIX` | URL path prefix (for reverse proxy setups) | |
| `SPEASY_PROXY_CORE_INVENTORY_UPDATE_INTERVAL` | Seconds between inventory refreshes | `7200` |
| `SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE` | Enable CRDT collaboration WebSocket | `False` |
| `SPEASY_PROXY_LOG_CONFIG_FILE` | Path to logging YAML config | |
| `SPEASY_PROXY_PRESETS_PATH` | Directory of `/plot` preset JSON files | shipped `presets/` |
| `SPEASY_PROXY_INDEX_PATH` | Proxy's own state (`diskcache.Index`) | `/tmp` |
| `SPEASY_PROXY_WORKERS` | gunicorn workers (Docker entry point) | `2 × nproc` |
| `SPEASY_PROXY_CORE_MAX_QUERY_SPAN_DAYS` | Longest `/get_data` time range accepted | `18300` |
| `SPEASY_PROXY_CORE_INVENTORY_SYNC_POLL_INTERVAL` | Seconds between cross-worker inventory syncs | `60` |
| `SPEASY_PROXY_CORE_INVENTORY_RETRY_BACKOFF` | Seconds before retrying a failed inventory refresh | `300` |
| `SPEASY_PROXY_CORE_INVENTORY_LEASE_TTL` | TTL of the cross-worker refresh lease (s) | `600` |
| `SPEASY_PROXY_CORE_INVENTORY_SHARED_PATH` | Shared inventory store directory | `<index path>/inventory_shared` |
| `SPEASY_PROXY_CORE_CACHE_SCRUB_INTERVAL` | Seconds between full cache scrubs | `604800` |
| `SPEASY_PROXY_CORE_CACHE_SCRUB_STATE_PATH` | Scrub schedule/lease store (must persist) | `<speasy index>/speasy_proxy_scrub` |
| `SPEASY_CACHE_PATH` | Cache storage path | |
| `SPEASY_INDEX_PATH` | Index storage path | |

## API Overview

The full interactive API documentation is available at `/docs` on any running instance.

Key endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /get_data` | Fetch data by product path and time range. Supports multiple output formats (pickle, CDF, JSON, interactive Bokeh HTML) and optional zstd compression. |
| `GET /get_inventory` | Retrieve the product inventory for a provider or all providers. Supports `If-Modified-Since` for conditional requests. |
| `GET /get_cache_entries` | List cached data entries. |
| `GET /get_version` | Proxy version. |
| `GET /get_speasy_version` | Version of the underlying speasy library. |
| `GET /is_up` | Is an upstream provider reachable (`?provider=amda`). |
| `GET /healthz` | Liveness probe for this server; never contacts a provider. |

## Development

```bash
uv sync --dev
uv run pytest
```

## License

MIT
