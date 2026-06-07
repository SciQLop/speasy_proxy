import time
from dateutil import parser
from datetime import UTC
from fastapi import Response, Request, Depends
from .routes import router
from fastapi import status
from starlette.concurrency import run_in_threadpool

from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from speasy_proxy.dependencies import get_inventory_manager
from speasy_proxy.backend.inventory_updater import InventoryManager
from speasy import list_providers
import logging
import uuid
from .query_parameters import Provider, ZstdCompression, InventoryFormat, PickleProtocol
from speasy_proxy.api.compression import compress_if_asked

from speasy_proxy.api import pickle_data

log = logging.getLogger(__name__)


def _mime_type(fmt):
    if fmt == "python_dict":
        return f"application/python-pickle"
    elif fmt == 'json':
        return "application/json; charset=utf-8"
    raise ValueError(f"Unknown mime type: {fmt}")


def encode_output(inventory_mgr: InventoryManager, provider: str, fmt, pickle_proto, version):
    return inventory_mgr.get_inventory(provider, fmt=fmt, pickle_proto=pickle_proto, version=version), _mime_type(fmt)


@router.get('/get_inventory', response_class=Response, description='Get the inventory of a provider or all providers',
            responses={304: {"description": "Client inventory is up to date"}, 200: {"description": "Inventory data"}})
async def get_inventory(request: Request, provider: Provider = "ssc",
                        format: InventoryFormat = "json", pickle_proto: PickleProtocol = 3,
                        zstd_compression: ZstdCompression = False,
                        version: int = 1,
                        inventory_mgr: InventoryManager = Depends(get_inventory_manager)):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    log.debug(f'New inventory request {request_id}: {provider}')
    if provider not in list_providers() and provider != "all":
        log.debug(f'{request_id}, unknown provider: {provider}')
        return Response(status_code=status.HTTP_400_BAD_REQUEST, content=f"Unknown or disabled provider: {provider}")
    if version not in (1, 2):
        log.debug(f'{request_id}, unsupported version: {version}')
        return Response(status_code=status.HTTP_400_BAD_REQUEST, content=f"Unsupported inventory version: {version}")

    if_modified_since = request.headers.get("If-Modified-Since")
    if if_modified_since and inventory_mgr.is_current(provider, if_modified_since):
        log.debug(f'{request_id}, client inventory is up to date')
        return Response(status_code=status.HTTP_304_NOT_MODIFIED)

    # Offload to a threadpool: the manager lookup may do blocking work (BL-4).
    data, mime = await run_in_threadpool(encode_output, inventory_mgr, provider, format, pickle_proto, version)
    if data is None:
        log.debug(f'{request_id}, inventory not available for requested format/version')
        return Response(status_code=status.HTTP_404_NOT_FOUND,
                        content="Inventory not available for the requested format/version")

    result, mime = compress_if_asked(data, mime, zstd_compression)
    request_duration = (time.time_ns() - request_start_time) / 1000.
    log.debug(f'{request_id}, duration = {request_duration}us')

    return Response(media_type=mime, content=result,
                    headers={'Content-Type': mime})
