import asyncio
from datetime import datetime, timedelta, UTC
from typing import Dict, Optional
import speasy as spz
from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from speasy.core.requests_scheduling.request_dispatch import PROVIDERS

import logging
from speasy_proxy.api import pickle_data
import pickle
from dateutil import parser

from ..config import core as config

log = logging.getLogger(__name__)

_INVENTORY_KEY = "inventory/{provider}/{fmt}"


class InventoryManager:
    def __init__(self, update_interval_seconds: int = 7200):
        self._inventories: Dict[str, bytes | str] = {}
        self._last_update: datetime = datetime.now(UTC) - timedelta(days=1)
        self._update_interval: int = update_interval_seconds

    @property
    def last_update(self) -> datetime:
        return self._last_update

    @property
    def update_interval(self) -> int:
        return self._update_interval

    def _inventory_key(self, provider: str, fmt: str, version: int = 1, pickle_proto: int = None) -> str:
        if fmt == "python_dict":
            if pickle_proto is None:
                raise ValueError("pickle_proto must be specified when format is 'python_dict'.")
            return _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        else:
            return _INVENTORY_KEY.format(provider=provider, fmt=fmt)

    def _save_inventory_as_json(self, inventory: SpeasyIndex, provider: str, target: dict):
        """Save the inventory as JSON into the target dict."""
        key = _INVENTORY_KEY.format(provider=provider, fmt="json")
        target[key] = to_json(inventory)
        log.debug(f"Inventory for {provider} saved as JSON.")

    def _save_inventory_as_pickled_dict(self, inventory: SpeasyIndex, provider: str, version: int = 1,
                                        pickle_proto: int = 1, target: dict = None):
        """Save the inventory as a pickled dictionary into the target dict."""
        key = _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        target[key] = pickle_data(to_dict(inventory, version=version), pickle_proto)
        log.debug(f"Inventory for {provider} saved as pickled dict with protocol {pickle_proto}.")

    def _build_all_inventories(self) -> dict:
        """Build ALL format combinations into a fresh dict and return it."""
        result: Dict[str, bytes | str] = {}
        log.debug("Building inventories for all providers in different formats.")
        for provider in set(PROVIDERS).intersection(tree.__dict__.keys()):
            self._save_inventory_as_json(tree.__dict__[provider], provider, target=result)
            for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
                for version in range(1, 3):
                    self._save_inventory_as_pickled_dict(tree.__dict__[provider], provider, version, pickle_proto,
                                                         target=result)
        _all = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
        self._save_inventory_as_json(_all, "all", target=result)
        for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
            for version in range(1, 3):
                self._save_inventory_as_pickled_dict(_all, "all", version, pickle_proto, target=result)
        return result

    def ensure_update(self):
        result = self._do_update()
        if result is not None:
            self._inventories = result

    def get_inventory(self, provider: str, fmt: str, version: int = 1, pickle_proto: int = None,
                      if_newer_than: str = None) -> Optional[bytes | str]:
        """Return a cached inventory entry, or None if not newer than the given date."""
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

        key = self._inventory_key(provider, fmt, version, pickle_proto)
        if key not in self._inventories:
            log.warning(
                f"Inventory for '{provider}' is not available in requested format (key={key}). Updating inventory.")
            self.ensure_update()
        return self._inventories.get(key)

    async def update_async(self):
        log.info("Updating inventory (async)...")
        new_inventories = await asyncio.to_thread(self._do_update)
        if new_inventories is not None:
            self._inventories = new_inventories
        log.info("Inventory updated.")

    def _do_update(self) -> dict[str, bytes | str] | None:
        """Sync method that checks if update is needed and builds inventories."""
        if datetime.now(UTC) >= (self._last_update + timedelta(seconds=self._update_interval)):
            log.debug("Updating runtime inventory")
            if 'build_date' not in tree.__dict__:
                build_dates = [parser.parse(tree.__dict__[p].build_date) for p in tree.__dict__.keys()]
                tree.__dict__["build_date"] = max(build_dates).isoformat()
            spz.update_inventories()
            result = self._build_all_inventories()
            self._last_update = datetime.now(UTC)
            return result
        return None

    async def periodic_update_loop(self):
        """Background task that periodically updates inventories."""
        while True:
            await asyncio.sleep(self._update_interval)
            try:
                await self.update_async()
            except Exception:
                log.exception("Failed to update inventory")

    def update_sync(self):
        """Synchronous update entry point for startup."""
        log.info("Updating inventory...")
        self.ensure_update()
        log.info("Inventory updated.")
