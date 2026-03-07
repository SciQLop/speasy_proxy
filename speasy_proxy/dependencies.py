from fastapi import Request, BackgroundTasks, Depends

from speasy_proxy.backend.inventory_updater import InventoryManager


def get_inventory_manager(request: Request) -> InventoryManager:
    return request.app.state.inventory_manager


def trigger_inventory_check(
    background_tasks: BackgroundTasks,
    inventory_mgr: InventoryManager = Depends(get_inventory_manager),
):
    background_tasks.add_task(inventory_mgr.ensure_update)
