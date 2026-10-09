"""State shared by the HAPI endpoints: the catalog (rebuilt when the inventory changes) and the
cached /info of every dataset described so far."""
import contextlib
import hashlib
import logging
import threading
from datetime import datetime, timedelta, UTC
from typing import Dict, Optional

import diskcache
from speasy.inventories import flat_inventories, tree

from .catalog import HapiDataset, build_catalog, _PROVIDERS
from .info import DatasetInfo, Fetch, build_info
from .status import HapiError

log = logging.getLogger(__name__)

INFO_RETENTION = timedelta(days=7)
# Bump when the way /info is built changes: cached descriptions from older code are then ignored.
INFO_FORMAT_VERSION = 5
# A dataset that couldn't be described is not sampled again before this.
FAILURE_RETENTION = timedelta(hours=1)


class HapiService:
    def __init__(self, fetch: Fetch, info_cache_path: str, tree_lock=None, max_concurrent_info_builds: int = 2,
                 inventories=None):
        """`inventories` stands in for speasy's flat_inventories (one attribute per provider, each with
        .datasets and .parameters), e.g. a fixed one for tests; it is then read once."""
        self.fetch = fetch
        self._inventories = inventories
        # Shared by every worker and kept across restarts: each /info costs upstream fetches.
        self._info_cache = diskcache.Cache(info_cache_path)
        self._tree_lock = tree_lock or contextlib.nullcontext
        self._catalog: Dict[str, HapiDataset] = {}
        self._catalog_key = None
        self.catalog_built_at = datetime.now(UTC)
        self._catalog_lock = threading.Lock()
        # Bounds the upstream load a client walking every /info can cause.
        self._info_builds = threading.BoundedSemaphore(max_concurrent_info_builds)
        self._building: Dict[str, threading.Lock] = {}

    def _inventory_key(self):
        if self._inventories is not None:
            return id(self._inventories)
        # speasy replaces a provider's tree node when its inventory changes.
        return tuple((p, id(tree.__dict__.get(p)), getattr(tree.__dict__.get(p), "build_date", None))
                     for p in _PROVIDERS)

    def catalog(self) -> Dict[str, HapiDataset]:
        key = self._inventory_key()
        if key != self._catalog_key:
            with self._catalog_lock:
                if key != self._catalog_key:
                    with self._tree_lock():
                        self._catalog = build_catalog(self._inventories or flat_inventories)
                    self._catalog_key = key
                    self.catalog_built_at = datetime.now(UTC)
                    log.info(f"HAPI catalog built: {len(self._catalog)} datasets")
        return self._catalog

    def dataset(self, dataset_id: Optional[str]) -> HapiDataset:
        if not dataset_id:
            raise HapiError(1400, "missing dataset")
        dataset = self.catalog().get(dataset_id)
        if dataset is None:
            raise HapiError(1406, dataset_id)
        return dataset

    @staticmethod
    def _info_key(dataset: HapiDataset) -> str:
        # Keyed on the parameter list too: a dataset whose parameters changed is described again.
        digest = hashlib.sha256("\n".join(f"{s.name}={s.key}" for s in dataset.parameters).encode()).hexdigest()
        return f"hapi/info/v{INFO_FORMAT_VERSION}/{dataset.id}/{digest}"

    def info(self, dataset: HapiDataset) -> DatasetInfo:
        """Blocking on first use of a dataset (samples it upstream), then served from the cache."""
        key = self._info_key(dataset)
        cached = self._info_cache.get(key)
        if cached is not None:
            return self._from_cache(cached)
        with self._catalog_lock:
            lock = self._building.setdefault(key, threading.Lock())
        with lock:  # one build per dataset at a time, the others wait for its result
            cached = self._info_cache.get(key)
            if cached is not None:
                return self._from_cache(cached)
            try:
                with self._info_builds:
                    info = build_info(dataset, self.fetch)
            except HapiError as e:
                self._info_cache.set(key, {"error": [e.code, e.detail]}, expire=FAILURE_RETENTION.total_seconds())
                raise
            self._info_cache.set(key, info.to_dict(), expire=INFO_RETENTION.total_seconds())
            return info

    @staticmethod
    def _from_cache(cached: dict) -> DatasetInfo:
        if "error" in cached:
            raise HapiError(*cached["error"])
        return DatasetInfo.from_dict(cached)
