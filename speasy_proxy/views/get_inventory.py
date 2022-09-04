import time

from pyramid.view import view_config
from pyramid.response import Response
from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from ..inventory_updater import EnsureUpdatedInventory
import zstd
import logging
import uuid

from . import pickle_data

log = logging.getLogger(__name__)


def _get_inventory(provider):
    if provider == "all":
        return SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
    return tree.__dict__[provider]


def encode_output(inventory: SpeasyIndex, request):
    output_format = request.params.get("format", "json")
    if output_format == "python_dict":
        return pickle_data(to_dict(inventory), request), "application/python-pickle"
    elif output_format == 'json':
        return to_json(inventory), "application/json; charset=utf-8"


def compress_if_asked(data, mime, request):
    if request.params.get("zstd_compression", "false") == "true":
        if type(data) is str:
            data = data.encode()
        mime = "application/x-zstd-compressed"
        data = zstd.compress(data)
    return data, mime


@view_config(route_name='get_inventory', openapi=True, decorator=(EnsureUpdatedInventory(),))
def get_inventory(request):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    provider = request.params.get("provider", None)

    if provider is None:
        log.error(f'Missing parameter: provider')
        return Response(
            content_type="text/plain",
            body=f"Error: missing provider parameter",
            headerlist=[('Access-Control-Allow-Origin', '*'), ('Content-Type', "text/plain")]
        )

    log.debug(f'New inventory request {request_id}: {provider}')

    result, mime = compress_if_asked(*encode_output(_get_inventory(provider), request), request)

    request_duration = (time.time_ns() - request_start_time) / 1000.

    log.debug(f'{request_id}, duration = {request_duration}us')

    return Response(content_type=mime, body=result,
                    headerlist=[('Access-Control-Allow-Origin', '*'), ('Content-Type', mime)])
