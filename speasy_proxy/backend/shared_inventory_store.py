"""Cross-worker coordination + publication of serialized inventories.

Gunicorn runs many worker processes, each with its own in-memory speasy ``tree``
and its own pre-serialized inventory cache. To avoid every worker fetching the
upstream inventory on every interval (BL-5a), one worker performs the fetch and
publishes the serialized result here; the others load it.

**Availability first**: every method degrades to a safe no-op / fallback if the
shared cache is unavailable (``enabled is False``). Nothing here is ever called on
the request hot path, so a failure of this store can only fall back to each worker
serving its own last-good in-memory inventory — never an outage.
"""
import logging
import os
import pickle  # trusted: payload is written and read only by our own workers on local disk
from datetime import UTC, datetime
from typing import Optional, Tuple

log = logging.getLogger(__name__)

_GEN = "inventory/generation"
_PAYLOAD = "inventory/payload"
_BUILD_DATES = "inventory/build_dates"
_LAST_REFRESH = "inventory/last_refresh"
_LAST_ATTEMPT = "inventory/last_attempt"
_LEASE = "inventory/lease"


class SharedInventoryStore:
    def __init__(self, path: Optional[str]):
        self.enabled = False
        self._cache = None
        if not path:
            log.info("Shared inventory store disabled; running per-worker.")
            return
        try:
            from diskcache import Cache
            self._cache = Cache(path)
            self.enabled = True
            log.info(f"Shared inventory store at {path}")
        except Exception:
            log.exception(f"Shared inventory store unavailable at {path}; running per-worker.")

    # --- reads -------------------------------------------------------------
    def generation(self) -> int:
        if not self.enabled:
            return 0
        try:
            return int(self._cache.get(_GEN, 0))
        except Exception:
            log.exception("Failed to read shared inventory generation.")
            return 0

    def last_refresh(self) -> Optional[datetime]:
        return self._get_dt(_LAST_REFRESH)

    def last_attempt(self) -> Optional[datetime]:
        return self._get_dt(_LAST_ATTEMPT)

    def _get_dt(self, key: str) -> Optional[datetime]:
        if not self.enabled:
            return None
        try:
            value = self._cache.get(key, None)
            return datetime.fromisoformat(value) if value else None
        except Exception:
            log.exception(f"Failed to read shared inventory {key}.")
            return None

    def read_if_newer(self, local_generation: int) -> Optional[Tuple[int, dict, dict]]:
        """Return (generation, payload, build_dates) if the shared copy is newer
        than local_generation, else None. Never raises — a failed/corrupt read
        returns None so the caller keeps its current good data."""
        if not self.enabled:
            return None
        try:
            with self._cache.transact():
                gen = int(self._cache.get(_GEN, 0))
                if gen <= local_generation:
                    return None
                payload_blob = self._cache.get(_PAYLOAD, None)
                build_dates_blob = self._cache.get(_BUILD_DATES, None)
            if payload_blob is None:
                return None
            payload = pickle.loads(payload_blob)
            build_dates = pickle.loads(build_dates_blob) if build_dates_blob else {}
            return gen, payload, build_dates
        except Exception:
            log.exception("Failed to load shared inventory; keeping current copy.")
            return None

    # --- writes ------------------------------------------------------------
    def set_last_attempt(self, when: datetime) -> None:
        if not self.enabled:
            return
        try:
            self._cache.set(_LAST_ATTEMPT, when.isoformat())
        except Exception:
            log.exception("Failed to record shared inventory attempt.")

    def publish(self, payload: dict, build_dates: dict) -> Optional[int]:
        """Atomically publish a new generation. `generation` is written last as the
        commit marker, so a reader that sees generation N always sees payload N."""
        if not self.enabled:
            return None
        try:
            with self._cache.transact():
                gen = int(self._cache.get(_GEN, 0)) + 1
                now = datetime.now(UTC).isoformat()
                self._cache.set(_PAYLOAD, pickle.dumps(payload))
                self._cache.set(_BUILD_DATES, pickle.dumps(build_dates))
                self._cache.set(_LAST_REFRESH, now)
                self._cache.set(_LAST_ATTEMPT, now)
                self._cache.set(_GEN, gen)
            return gen
        except Exception:
            log.exception("Failed to publish shared inventory.")
            return None

    def seed_if_empty(self, payload: dict, build_dates: dict) -> Optional[int]:
        """Populate the store once at startup if empty (no network). Only the first
        worker wins the atomic claim; returns the new generation or None."""
        if not self.enabled:
            return None
        try:
            if self._cache.add(_GEN, 0):  # atomic: first worker only
                return self.publish(payload, build_dates)
            return None
        except Exception:
            log.exception("Failed to seed shared inventory.")
            return None

    # --- lease -------------------------------------------------------------
    def try_acquire_lease(self, ttl: int) -> bool:
        """Atomically claim the refresh lease. Returns True if acquired. When the
        store is disabled, returns True so the worker acts as sole leader."""
        if not self.enabled:
            return True
        try:
            return bool(self._cache.add(_LEASE, os.getpid(), expire=ttl))
        except Exception:
            log.exception("Failed to acquire inventory refresh lease.")
            return False

    def release_lease(self) -> None:
        if not self.enabled:
            return
        try:
            self._cache.delete(_LEASE)
        except Exception:
            log.exception("Failed to release inventory refresh lease.")
