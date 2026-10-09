"""A HAPI (https://hapi-server.org) server over speasy, as a self-contained FastAPI sub-app.

Depends on speasy, FastAPI, numpy, pandas and diskcache only (nothing else from speasy_proxy), so
it can be lifted into its own package. Mount it at a path ending in /hapi:

    app.mount("/hapi", create_hapi_app(fetch=..., info_cache_path=..., max_request_duration=...))
"""
from .app import create_hapi_app

__all__ = ["create_hapi_app"]
