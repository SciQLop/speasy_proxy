from functools import wraps
from datetime import datetime, timedelta, UTC
from typing import Callable, Dict, Optional
import speasy as spz
from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from speasy.core.requests_scheduling.request_dispatch import PROVIDERS
from speasy.core.cache import CacheCall
import logging
import threading
from ..index import IndexEntry
from speasy_proxy.api import pickle_data
import pickle
from dateutil import parser

from ..config import core as config
from fastapi_utilities import repeat_every
from contextlib import asynccontextmanager

log = logging.getLogger(__name__)
lock = threading.Lock()

last_update = IndexEntry("last_update", datetime.now(UTC) - timedelta(days=1))
inventories: Dict[str, IndexEntry] = {}

__INVENTORY_KEY__ = "inventory/{provider}/{fmt}"


def get_inventory(provider: str, fmt: str, version: int = 1, pickle_proto: int = None, if_newer_than: str = None) -> \
        Optional[SpeasyIndex]:
    global inventories
    if if_newer_than is not None:
        if provider == "all":
            if parser.parse(tree.build_date).astimezone(UTC) < parser.parse(if_newer_than).astimezone(UTC):
                log.debug(f"Inventory for 'all' is not newer than {if_newer_than}. Returning None.")
                return None
        else:
            if parser.parse(tree.__dict__[provider].build_date).astimezone(UTC) < parser.parse(
                    if_newer_than).astimezone(UTC):
                log.debug(f"Inventory for '{provider}' is not newer than {if_newer_than}. Returning None.")
                return None
    if fmt == "python_dict":
        if pickle_proto is None:
            raise ValueError("pickle_proto must be specified when format is 'python_dict'.")
        key = __INVENTORY_KEY__.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        return inventories[key].value()
    else:
        key = __INVENTORY_KEY__.format(provider=provider, fmt=fmt)
        return inventories[key].value()


def _save_inventory_as_json(inventory: SpeasyIndex, provider: str):
    """
    Save the inventory as a JSON file.
    This is used to ensure that the inventory is available globally.
    """
    global inventories
    key = __INVENTORY_KEY__.format(provider=provider, fmt="json")
    inventories[key] = IndexEntry(key, to_json(inventory))
    log.debug(f"Inventory for {provider} saved as JSON.")


def _save_inventory_as_pickled_dict(inventory: SpeasyIndex, provider: str, version: int = 1, pickle_proto: int = 1):
    """
    Save the inventory as a pickled dictionary.
    This is used to ensure that the inventory is available globally.
    """
    global inventories
    key = __INVENTORY_KEY__.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
    inventories[key] = IndexEntry(
        key, pickle_data(to_dict(inventory, version=version), pickle_proto))
    log.debug(f"Inventory for {provider} saved as pickled dict with protocol {pickle_proto}.")


def _save_all_inventories_combination():
    """
    Save all inventories to the global inventories dictionary.
    This is used to ensure that the inventories are available globally.
    """
    global inventories
    log.debug(f"Inventories for all providers saved to global inventories dictionary in different formats.")
    for provider in set(PROVIDERS).intersection(tree.__dict__.keys()):
        _save_inventory_as_json(tree.__dict__[provider], provider)
        for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
            for version in range(1, 3):  # Assuming version 1 and 2 are the only versions needed
                _save_inventory_as_pickled_dict(tree.__dict__[provider], provider, version, pickle_proto)
    _all = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
    _save_inventory_as_json(_all, "all")
    for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
        for version in range(1, 3):
            _save_inventory_as_pickled_dict(_all, "all", version, pickle_proto)


def ensure_update_inventory():
    global last_update
    global inventories
    if datetime.now(UTC) >= (last_update.value() + timedelta(seconds=config.inventory_update_interval.get())):
        with lock:
            log.debug("Updating runtime inventory")
            if 'build_date' not in tree.__dict__:
                build_dates = [parser.parse(tree.__dict__[provider].build_date) for provider in tree.__dict__.keys()]
                tree.__dict__["build_date"] = max(build_dates).isoformat()
            spz.update_inventories()
            _save_all_inventories_combination()
            last_update.set(datetime.now(UTC))


@repeat_every(seconds=config.inventory_update_interval.get())
async def update_inventory():
    """
    Update the inventory every 2 hours.
    This is used to ensure that the inventory is up to date.
    """
    log.info("Updating inventory...")
    ensure_update_inventory()
    log.info("Inventory updated.")
