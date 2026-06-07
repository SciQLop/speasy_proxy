import asyncio
import os
import pickle
import threading
from datetime import datetime, timedelta, UTC
from typing import Dict, Optional

import speasy as spz
from dateutil import parser
from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.core.requests_scheduling.request_dispatch import PROVIDERS
from speasy.inventories import tree

import logging
from speasy_proxy.api import pickle_data
from .shared_inventory_store import SharedInventoryStore
from ..config import core as config, index as index_cfg

log = logging.getLogger(__name__)

_INVENTORY_KEY = "inventory/{provider}/{fmt}"


def _default_shared_path() -> str:
    configured = config.inventory_shared_path.get()
    if configured:
        return configured
    return os.path.join(index_cfg.path(), "inventory_shared")


class InventoryManager:
    """Serves pre-serialized inventories from memory and keeps them fresh.

    Availability first: ``get_inventory`` only ever reads in-memory state, never
    the network or the shared store. Refresh runs entirely in the background loop;
    any failure there (fetch, build, shared store) falls back to serving the
    last-good in-memory copy — see [[availability-first-and-decisiveness]]."""

    def __init__(self, update_interval_seconds: int = 7200, shared_store: Optional[SharedInventoryStore] = None):
        self._inventories: Dict[str, bytes | str] = {}
        self._build_dates: Dict[str, str] = {}
        self._generation: int = 0
        self._last_update: datetime = datetime.now(UTC) - timedelta(days=1)
        self._last_attempt: Optional[datetime] = None
        self._update_interval: int = update_interval_seconds
        self._sync_poll_interval: int = config.inventory_sync_poll_interval.get()
        self._retry_backoff: int = config.inventory_retry_backoff.get()
        self._lease_ttl: int = config.inventory_lease_ttl.get()
        self._update_lock = threading.Lock()
        self._shared = shared_store if shared_store is not None else SharedInventoryStore(_default_shared_path())

    @property
    def last_update(self) -> datetime:
        return self._last_update

    @property
    def update_interval(self) -> int:
        return self._update_interval

    # --- serialization -----------------------------------------------------
    def _inventory_key(self, provider: str, fmt: str, version: int = 1, pickle_proto: int = None) -> str:
        if fmt == "python_dict":
            if pickle_proto is None:
                raise ValueError("pickle_proto must be specified when format is 'python_dict'.")
            return _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        return _INVENTORY_KEY.format(provider=provider, fmt=fmt)

    def _save_inventory_as_json(self, inventory: SpeasyIndex, provider: str, target: dict):
        target[_INVENTORY_KEY.format(provider=provider, fmt="json")] = to_json(inventory)

    def _save_inventory_as_pickled_dict(self, inventory: SpeasyIndex, provider: str, version: int,
                                        pickle_proto: int, target: dict):
        key = _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        target[key] = pickle_data(to_dict(inventory, version=version), pickle_proto)

    def _ensure_tree_build_date(self):
        if 'build_date' not in tree.__dict__:
            dates = [d for d in (getattr(tree.__dict__[p], "build_date", None)
                                 for p in set(PROVIDERS).intersection(tree.__dict__.keys())) if d]
            if dates:
                tree.__dict__["build_date"] = max(dates, key=parser.parse)

    def _build_all_inventories(self) -> dict:
        """Build ALL format combinations into a fresh dict and return it."""
        self._ensure_tree_build_date()
        result: Dict[str, bytes | str] = {}
        for provider in set(PROVIDERS).intersection(tree.__dict__.keys()):
            self._save_inventory_as_json(tree.__dict__[provider], provider, target=result)
            for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
                for version in range(1, 3):
                    self._save_inventory_as_pickled_dict(tree.__dict__[provider], provider, version, pickle_proto, result)
        _all = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
        self._save_inventory_as_json(_all, "all", target=result)
        for pickle_proto in range(1, pickle.HIGHEST_PROTOCOL + 1):
            for version in range(1, 3):
                self._save_inventory_as_pickled_dict(_all, "all", version, pickle_proto, result)
        return result

    def _collect_build_dates(self) -> Dict[str, str]:
        dates: Dict[str, str] = {}
        for provider in set(PROVIDERS).intersection(tree.__dict__.keys()):
            build_date = getattr(tree.__dict__[provider], "build_date", None)
            if build_date:
                dates[provider] = build_date
        all_build_date = tree.__dict__.get("build_date") or (max(dates.values(), key=parser.parse) if dates else None)
        if all_build_date:
            dates["all"] = all_build_date
        return dates

    # --- startup -----------------------------------------------------------
    def build_inventories(self):
        """Build serialized inventories from the already-loaded speasy tree (no
        network) and seed/sync the shared store."""
        self._inventories = self._build_all_inventories()
        self._build_dates = self._collect_build_dates()
        self._last_update = datetime.now(UTC)
        seeded = self._shared.seed_if_empty(self._inventories, self._build_dates)
        if seeded is not None:
            self._generation = seeded
        else:
            self._sync_from_shared()
        log.info("Inventories built from in-memory tree.")

    # --- lookup (hot path: memory only) -----------------------------------
    def is_current(self, provider: str, if_newer_than: str) -> bool:
        """True if the client's copy (If-Modified-Since) is at least as new as ours,
        i.e. a 304 is warranted. Defensive: an unknown build date or an unparseable
        client date means 'not current' (serve the data) — never raises."""
        build_date = self._build_dates.get(provider)
        if build_date is None:
            return False
        try:
            return parser.parse(build_date).astimezone(UTC) < parser.parse(if_newer_than).astimezone(UTC)
        except Exception:
            return False

    def get_inventory(self, provider: str, fmt: str, version: int = 1,
                      pickle_proto: int = None) -> Optional[bytes | str]:
        """Return a cached inventory entry, or None if that format/version was never
        built. Reads only in-memory state — never the network or shared store."""
        return self._inventories.get(self._inventory_key(provider, fmt, version, pickle_proto))

    # --- refresh coordination ---------------------------------------------
    def ensure_update(self):
        """Lazy per-request trigger (runs in a background task/thread)."""
        self._tick()

    def _tick(self):
        self._sync_from_shared()
        self._refresh_if_due()

    def _sync_from_shared(self):
        snapshot = self._shared.read_if_newer(self._generation)
        if snapshot is None:
            return
        generation, payload, build_dates = snapshot
        self._inventories = payload
        self._build_dates = build_dates
        self._generation = generation
        self._last_update = datetime.now(UTC)
        log.info(f"Loaded shared inventory generation {generation}.")

    def _refresh_due(self) -> bool:
        now = datetime.now(UTC)
        if self._shared.enabled:
            last_refresh = self._shared.last_refresh()
            last_attempt = self._shared.last_attempt()
        else:
            last_refresh = self._last_update
            last_attempt = self._last_attempt
        base_due = last_refresh is None or now >= last_refresh + timedelta(seconds=self._update_interval)
        backoff_ok = last_attempt is None or now >= last_attempt + timedelta(seconds=self._retry_backoff)
        return base_due and backoff_ok

    def _refresh_if_due(self):
        if not self._refresh_due():
            return
        with self._update_lock:  # in-process guard (BL-5b)
            if not self._shared.try_acquire_lease(self._lease_ttl):
                return  # another worker is refreshing; we'll sync its result later
            try:
                # Authoritative re-check while holding the lease: another worker may
                # have refreshed (and released the lease) between our due-check and
                # acquiring it. last_refresh is published before the lease is freed.
                if not self._refresh_due():
                    return
                now = datetime.now(UTC)
                self._last_attempt = now
                self._shared.set_last_attempt(now)  # set before network so a crash still backs off
                spz.update_inventories()
                payload = self._build_all_inventories()
                build_dates = self._collect_build_dates()
                generation = self._shared.publish(payload, build_dates)
                self._inventories = payload
                self._build_dates = build_dates
                self._generation = generation if generation is not None else self._generation + 1
                self._last_update = datetime.now(UTC)
                log.info(f"Refreshed inventory (generation {self._generation}).")
            except Exception:
                log.exception("Inventory refresh failed; keeping last-good inventory.")
            finally:
                self._shared.release_lease()

    async def periodic_update_loop(self):
        """Background task: periodically sync from the shared store and, when due,
        perform the single cross-worker refresh. Never lets an error break the loop."""
        while True:
            await asyncio.sleep(self._sync_poll_interval)
            try:
                await asyncio.to_thread(self._tick)
            except Exception:
                log.exception("Inventory tick failed.")
