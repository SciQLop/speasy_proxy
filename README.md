# speasy-proxy

[![PyPI version](https://badge.fury.io/py/speasy-proxy.svg)](https://pypi.org/project/speasy-proxy/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

A fast caching proxy server for [speasy](https://github.com/SciQLop/speasy), reducing load on upstream data providers (AMDA, CDAWeb, SSCWeb) and improving response times for space physics data access.

## Using the public instance

A public instance is available at: https://sciqlop.lpp.polytechnique.fr/cache/

speasy uses this proxy by default — no configuration needed. You can browse the available data and interactive API docs at that URL.

---

## Deploying your own instance

### Container (recommended)

Podman is recommended, but Docker works too.

```bash
# Build the image
./docker/build.sh [PORT] [NAME] [SPEASY_PACKAGE]

# Run with Podman
podman run -d -p 6543:6543 \
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
| `GET /is_up` | Health check. |

## Development

```bash
uv sync --dev
uv run pytest
```

## License

MIT
