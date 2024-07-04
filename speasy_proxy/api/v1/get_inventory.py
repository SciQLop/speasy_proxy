import time
from dateutil import parser
from datetime import UTC
from fastapi import Response, Request
from .routes import router
from fastapi import status

from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from speasy_proxy.backend.inventory_updater import ensure_update_inventory
import pyzstd
import logging
import uuid
from .query_parameters import QueryProvider, QueryZstd, QueryFormat, QueryPickleProto

from speasy_proxy.api import pickle_data

log = logging.getLogger(__name__)


def _get_inventory(provider):
    if provider == "all":
        if 'build_date' not in tree.__dict__:
            build_dates = [parser.parse(tree.__dict__[provider].build_date) for provider in tree.__dict__.keys()]
            tree.__dict__["build_date"] = max(build_dates).isoformat()
        return SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
    return tree.__dict__[provider]


def encode_output(inventory: SpeasyIndex, format, pickle_proto):
    if format == "python_dict":
        return pickle_data(to_dict(inventory), pickle_proto), "application/python-pickle"
    elif format == 'json':
        return to_json(inventory), "application/json; charset=utf-8"


def compress_if_asked(data, mime, zstd_compression: bool = False):
    if zstd_compression:
        if type(data) is str:
            data = data.encode()
        mime = "application/x-zstd-compressed"
        data = pyzstd.compress(data)
    return data, mime


@router.get('/get_inventory', response_class=Response, description='Get the inventory of a provider or all providers',
            responses={304: {"description": "Client inventory is up to date"}, 200: {"description": "Inventory data"}})
async def get_inventory(request: Request, provider: str = QueryProvider,
                        format: str = QueryFormat, pickle_proto: int = QueryPickleProto,
                        zstd_compression: bool = QueryZstd):
    request_start_time = time.time_ns()
    ensure_update_inventory()
    request_id = uuid.uuid4()

    log.debug(f'New inventory request {request_id}: {provider}')

    inventory = _get_inventory(provider)
    if "If-Modified-Since" in request.headers:
        if parser.parse(request.headers["If-Modified-Since"]).astimezone(UTC) >= parser.parse(
                inventory.build_date).astimezone(UTC):
            log.debug(f'{request_id}, client inventory is up to date')
            return Response(status_code=status.HTTP_304_NOT_MODIFIED)

    result, mime = compress_if_asked(*encode_output(inventory, format, pickle_proto), zstd_compression)
    request_duration = (time.time_ns() - request_start_time) / 1000.

    log.debug(f'{request_id}, duration = {request_duration}us')

    return Response(media_type=mime, content=result,
                    headers={'Access-Control-Allow-Origin': '*', 'Content-Type': mime})
