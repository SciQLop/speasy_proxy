"""The HAPI servers' products, read from the HAPI project's nightly metadata dumps.

speasy lists the HAPI servers empty and loads one only when it is first used. Served as is, /plot shows no HAPI
product, and describing every dataset from the servers themselves takes a request per dataset (~10k). The dumps
(https://github.com/hapi-server/server-metadata) hold each server's /catalog?depth=all, one file per server.
Only the served inventory is built from them: speasy's own tree stays lazy, so get_data still loads from the server.
"""
import json
import logging
import urllib.request
from typing import Callable
from urllib.parse import quote

from speasy.core.hapi.inventory import build_inventory
from speasy.core.inventory.indexes import DatasetIndex, SpeasyIndex

log = logging.getLogger(__name__)

_DUMP_URL = "https://hapi-server.org/meta/catalog/{id}-all.json"


def dump_url(server_id: str) -> str:
    return _DUMP_URL.format(id=quote(server_id, safe=""))


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=120) as response:
        return json.load(response)


def _meta(node: SpeasyIndex) -> dict:
    """Read from __dict__: attribute access on speasy's lazy HAPI nodes would load them from their server."""
    return {k: v for k, v in node.__dict__.items() if not k.startswith("__spz_") and not isinstance(v, SpeasyIndex)}


def _server(key: str, listed: SpeasyIndex, fetch: Callable[[str], dict]) -> SpeasyIndex:
    """A server without a dump (or whose dump fails) stays as speasy lists it: browsable, with no product."""
    node = SpeasyIndex(name=key, provider=listed.spz_provider(), uid=key, meta=_meta(listed))
    url = dump_url(listed.__dict__.get("id", key))
    try:
        build_inventory(node, {}, fetch(url)["catalog"], dataset_type=DatasetIndex)
    except Exception as e:  # pylint: disable=broad-except
        log.warning(f"No HAPI dump for {key} ({url}): {e!r}")
    return node


def hapi_inventory(servers: SpeasyIndex, fetch: Callable[[str], dict] = fetch_json) -> SpeasyIndex:
    """A copy of speasy's HAPI tree (``servers``) with each server filled from its dump."""
    root = SpeasyIndex(name=servers.spz_name(), provider=servers.spz_provider(), uid=servers.spz_uid(),
                       meta=_meta(servers))
    for key, listed in servers.__dict__.items():
        if isinstance(listed, SpeasyIndex):
            root.__dict__[key] = _server(key, listed, fetch)
    return root
