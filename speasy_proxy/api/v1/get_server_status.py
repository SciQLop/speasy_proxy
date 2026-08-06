from fastapi import Depends
from .routes import router
import logging
from starlette.concurrency import run_in_threadpool
from speasy_proxy.backend import status
from speasy_proxy.backend.inventory_updater import InventoryManager
from speasy_proxy.dependencies import get_inventory_manager
from .models import ServerStatus

log = logging.getLogger(__name__)


@router.get('/get_server_status', description='Get server status', response_model=ServerStatus)
async def get_server_status(inventory_mgr: InventoryManager = Depends(get_inventory_manager)):
    log.debug('Client asking for server status')
    # status() does blocking cache I/O; keep it off the event loop.
    return await run_in_threadpool(
        status,
        last_inventory_update=inventory_mgr.last_update,
        update_interval_seconds=inventory_mgr.update_interval,
        inventory_size=inventory_mgr.inventory_size,
    )
