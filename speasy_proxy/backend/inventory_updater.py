import asyncio
import os
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
from speasy_proxy.api.compression import compress_if_asked
from .shared_inventory_store import SharedInventoryStore
from ..config import core as config, index as index_cfg

log = logging.getLogger(__name__)

_INVENTORY_KEY = "inventory/{provider}/{fmt}"

# Pickle protocols built eagerly (the ones the proxy's clients actually use).
# Protocol 5 is excluded: the proxy never uses out-of-band buffers. Other valid
# protocols (1, 2, 5) are built lazily on first request and memoized.
_EAGER_PICKLE_PROTOS = (3, 4)


def _default_shared_path() -> str:
    configured = config.inventory_shared_path.get()
    if configured:
        return configured
    return os.path.join(index_cfg.path(), "inventory_shared")


def _available_providers() -> set:
    """Providers that are both enabled in speasy and present in the loaded tree."""
    return set(PROVIDERS).intersection(tree.__dict__.keys())


class InventoryManager:
    """Serves pre-serialized inventories from memory and keeps them fresh.

    Only the common variants are built eagerly (JSON and pickle protocols 3/4,
    versions 1..2, each also pre-compressed with zstd); rarer valid combinations
    (pickle protocols 1, 2, 5) are built lazily on first request and memoized.

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
        # Guards the shared speasy `tree` global against a lazy build (_build_lazy)
        # reading it while a refresh's spz.update_inventories() is mid-flight: speasy's
        # DataProvider.update_inventory() clears each provider's SpeasyIndex in place
        # before reassigning it, so an unguarded concurrent read can pickle (and
        # permanently cache) a torn/empty snapshot.
        self._tree_lock = threading.Lock()
        # Guards _inventories/_build_dates/_generation as a single unit so a reader
        # never observes them from two different generations.
        self._state_lock = threading.Lock()
        self._inventory_size: str = "0"
        self._shared = shared_store if shared_store is not None else SharedInventoryStore(_default_shared_path())

    @property
    def last_update(self) -> datetime:
        return self._last_update

    @property
    def update_interval(self) -> int:
        return self._update_interval

    @property
    def inventory_size(self) -> str:
        return self._inventory_size

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
                                 for p in _available_providers()) if d]
            if dates:
                tree.__dict__["build_date"] = max(dates, key=parser.parse)

    def _build_eager_inventories(self, inventory: SpeasyIndex, provider: str, target: dict):
        self._save_inventory_as_json(inventory, provider, target=target)
        for pickle_proto in _EAGER_PICKLE_PROTOS:
            for version in range(1, 3):
                self._save_inventory_as_pickled_dict(inventory, provider, version, pickle_proto, target)

    def _add_zstd_variants(self, target: dict):
        """Pre-compress a zstd variant of every eagerly built blob, so requests
        asking for zstd are served directly instead of compressing on the hot
        path. Best effort: a failure only skips that variant — the request path
        then falls back to compressing in the threadpool."""
        for key, data in list(target.items()):
            try:
                compressed, _ = compress_if_asked(data, "", True)
                target[f"{key}/zstd"] = compressed
            except Exception:
                log.exception(f"Failed to pre-compress {key}; will compress on demand.")

    def _build_all_inventories(self) -> dict:
        """Eagerly build the common variants (JSON, pickle protocols 3 and 4,
        versions 1..2) plus their zstd-compressed copies into a fresh dict and
        return it. Other valid combinations (pickle protocols 1, 2, 5) are NOT
        built here: they are built lazily on first request (see get_inventory)."""
        self._ensure_tree_build_date()
        result: Dict[str, bytes | str] = {}
        for provider in _available_providers():
            self._build_eager_inventories(tree.__dict__[provider], provider, result)
        _all = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
        self._build_eager_inventories(_all, "all", result)
        self._add_zstd_variants(result)
        return result

    def _collect_build_dates(self) -> Dict[str, str]:
        dates: Dict[str, str] = {}
        for provider in _available_providers():
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
        # Computed once here (walking flat_inventories is too expensive per request).
        try:
            self._inventory_size = str(
                sum(map(lambda p: len(p.parameters),
                        set(spz.inventories.flat_inventories.__dict__.values()))))
        except Exception:
            log.exception("Failed to compute inventory size; keeping previous value.")
        self._last_update = datetime.now(UTC)
        seeded = self._shared.seed_if_empty(self._inventories, self._build_dates)
        if seeded is not None:
            self._generation = seeded
        else:
            self._sync_from_shared()
        log.info("Inventories built from in-memory tree.")

    # --- lookup (hot path: memory only) -----------------------------------
    def build_date(self, provider: str) -> Optional[str]:
        """Build date of the given provider's inventory, or None if unknown.
        Same source is_current() uses for its 304 decisions."""
        return self._build_dates.get(provider)

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
                      pickle_proto: int = None, zstd: bool = False) -> Optional[bytes | str]:
        """Return a cached inventory entry, or None if unavailable. With
        ``zstd=True``, return the pre-compressed variant if one was built.
        Reads only in-memory state — never the network or shared store. Valid
        but uncommon variants (pickle protocols 1, 2, 5) are built lazily here
        on first request and memoized."""
        key = self._inventory_key(provider, fmt, version, pickle_proto)
        if zstd:
            return self._inventories.get(f"{key}/zstd")
        data = self._inventories.get(key)
        if data is None:
            data = self._build_lazy(provider, fmt, version, pickle_proto, key)
        return data

    def get_inventory_with_build_date(self, provider: str, fmt: str, version: int = 1,
                                      pickle_proto: int = None, zstd: bool = False):
        """Same as get_inventory() but also returns the build date, read together
        under the state lock so a concurrent refresh can't pair a stale body with a
        fresher Last-Modified header (or vice versa)."""
        with self._state_lock:
            data = self.get_inventory(provider, fmt, version, pickle_proto, zstd)
            build_date = self._build_dates.get(provider)
        return data, build_date

    def _build_lazy(self, provider: str, fmt: str, version: int, pickle_proto: int,
                    key: str) -> Optional[bytes | str]:
        """Build a valid but non-eager pickle variant on first request and memoize
        it. Not thread-safe against other lazy builds by design: the worst case
        there is two workers computing the same bytes once. Reading the shared tree
        itself is protected by _tree_lock (see __init__) against a concurrent
        refresh, which clears each provider's SpeasyIndex in place before
        reassigning it. Any failure returns None (the endpoint serves a 404)."""
        if fmt != "python_dict" or pickle_proto is None or pickle_proto in _EAGER_PICKLE_PROTOS:
            return None
        try:
            with self._tree_lock:
                if provider == "all":
                    source = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
                else:
                    source = tree.__dict__[provider]
                data = pickle_data(to_dict(source, version=version), pickle_proto)
        except Exception:
            log.exception(f"Failed to lazily build {key}.")
            return None
        self._inventories[key] = data
        return data

    # --- refresh coordination ---------------------------------------------
    def ensure_update(self):
        """Lazy per-request trigger (runs in a background task/thread)."""
        self._tick()

    def _tick(self):
        self._sync_from_shared()
        self._refresh_if_due()

    def _apply_state(self, inventories: dict, build_dates: dict, generation: int):
        with self._state_lock:
            self._inventories = inventories
            self._build_dates = build_dates
            self._generation = generation

    def _sync_from_shared(self):
        snapshot = self._shared.read_if_newer(self._generation)
        if snapshot is None:
            return
        generation, payload, build_dates = snapshot
        self._apply_state(payload, build_dates, generation)
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
                with self._tree_lock:  # excludes a concurrent lazy build from a torn tree read
                    spz.update_inventories()
                payload = self._build_all_inventories()
                build_dates = self._collect_build_dates()
                generation = self._shared.publish(payload, build_dates)
                generation = generation if generation is not None else self._generation + 1
                self._apply_state(payload, build_dates, generation)
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
