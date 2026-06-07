import threading
from datetime import UTC, datetime, timedelta

from speasy.inventories import tree
from speasy_proxy.backend import inventory_updater
from speasy_proxy.backend.inventory_updater import InventoryManager
from speasy_proxy.backend.shared_inventory_store import SharedInventoryStore


def _quiet_tree():
    # Skip the build_date computation branch (offline tree has no providers).
    tree.__dict__.setdefault("build_date", datetime.now(UTC).isoformat())


def _manager(path, interval, monkeypatch, payload):
    mgr = InventoryManager(update_interval_seconds=interval, shared_store=SharedInventoryStore(path))
    monkeypatch.setattr(mgr, "_build_all_inventories", lambda: dict(payload))
    monkeypatch.setattr(mgr, "_collect_build_dates", lambda: {"all": "2020-01-01T00:00:00+00:00"})
    return mgr


def test_startup_seeds_shared_without_fetching(tmp_path, monkeypatch):
    """build_inventories must seed the shared store from the forked tree and NOT
    hit the network (preserves the --preload no-fetch-at-boot behavior)."""
    _quiet_tree()
    fetches = []
    monkeypatch.setattr(inventory_updater.spz, "update_inventories", lambda *a, **k: fetches.append(1))
    path = str(tmp_path / "shared")

    a = _manager(path, 3600, monkeypatch, {"inv": "A"})
    b = _manager(path, 3600, monkeypatch, {"inv": "B"})
    a.build_inventories()
    b.build_inventories()

    assert fetches == []                      # no network at startup
    assert b._inventories == {"inv": "A"}     # b lost the seed race, synced a's payload


def test_single_fetch_then_propagates(tmp_path, monkeypatch):
    """Across a refresh, exactly one worker fetches; the other loads the published
    result instead of fetching (BL-5a)."""
    _quiet_tree()
    fetches = []
    monkeypatch.setattr(inventory_updater.spz, "update_inventories", lambda *a, **k: fetches.append(1))
    path = str(tmp_path / "shared")

    a = _manager(path, 3600, monkeypatch, {"inv": "fresh"})
    b = _manager(path, 3600, monkeypatch, {"inv": "stale-b"})

    a._tick()  # shared empty -> a is due -> fetch + publish
    b._tick()  # shared now fresh -> b not due -> syncs a's payload, no fetch

    assert len(fetches) == 1
    assert b._inventories == {"inv": "fresh"}
    assert a._generation == b._generation == 1


def test_concurrent_refresh_single_fetch(tmp_path, monkeypatch):
    """Two workers ticking simultaneously must produce exactly one upstream fetch
    (the lease serializes them); both converge afterwards."""
    _quiet_tree()
    fetches = []
    lock = threading.Lock()

    def fake_fetch(*a, **k):
        with lock:
            fetches.append(1)

    monkeypatch.setattr(inventory_updater.spz, "update_inventories", fake_fetch)
    path = str(tmp_path / "shared")
    a = _manager(path, 3600, monkeypatch, {"inv": "A"})
    b = _manager(path, 3600, monkeypatch, {"inv": "B"})

    barrier = threading.Barrier(2)

    def worker(mgr):
        barrier.wait()
        mgr._tick()

    threads = [threading.Thread(target=worker, args=(m,)) for m in (a, b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(fetches) == 1
    # one more tick lets the loser sync the winner's published generation
    a._tick()
    b._tick()
    assert a._inventories == b._inventories
    assert a._generation == b._generation == 1


def test_failure_keeps_last_good_and_backs_off(tmp_path, monkeypatch):
    """If the upstream fetch raises, the last-good inventory is preserved, the
    generation is NOT bumped, and a retry backoff prevents immediate hammering."""
    _quiet_tree()
    path = str(tmp_path / "shared")
    mgr = _manager(path, 3600, monkeypatch, {"inv": "good"})
    mgr.build_inventories()  # seeds shared gen 1 with the good payload
    assert mgr._generation == 1

    # Force a refresh to be due by backdating the shared timestamps (past both the
    # update interval and the retry backoff).
    old = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    mgr._shared._cache.set("inventory/last_refresh", old)
    mgr._shared._cache.set("inventory/last_attempt", old)

    fetches = []

    def boom(*a, **k):
        fetches.append(1)
        raise RuntimeError("provider down")

    monkeypatch.setattr(inventory_updater.spz, "update_inventories", boom)

    mgr._tick()  # attempt -> raises -> caught
    assert len(fetches) == 1
    assert mgr._inventories == {"inv": "good"}      # last-good preserved
    assert mgr._generation == 1                     # not bumped
    assert mgr._shared.generation() == 1

    mgr._tick()  # immediately again: backoff must prevent another attempt
    assert len(fetches) == 1


def test_degraded_mode_in_process_guard(monkeypatch):
    """With the shared store disabled, the in-process lock must still prevent a
    concurrent double fetch (BL-5b), and the proxy keeps working per-worker."""
    _quiet_tree()
    fetches = []
    lock = threading.Lock()

    def slow_fetch(*a, **k):
        with lock:
            fetches.append(1)

    monkeypatch.setattr(inventory_updater.spz, "update_inventories", slow_fetch)

    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    monkeypatch.setattr(mgr, "_build_all_inventories", lambda: {"inv": "x"})
    monkeypatch.setattr(mgr, "_collect_build_dates", lambda: {})
    assert mgr._shared.enabled is False

    barrier = threading.Barrier(2)

    def worker():
        barrier.wait()
        mgr.ensure_update()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(fetches) == 1
    assert mgr._inventories == {"inv": "x"}


def test_get_inventory_reads_memory_only(monkeypatch):
    """get_inventory must serve from memory and never trigger a refresh."""
    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    mgr._inventories = {"inventory/all/json": "DATA"}
    mgr._build_dates = {"all": "2020-01-01T00:00:00+00:00"}

    def fail(*a, **k):
        raise AssertionError("get_inventory must not refresh")

    monkeypatch.setattr(mgr, "_tick", fail)
    assert mgr.get_inventory("all", "json") == "DATA"
    # 304 decision is now a separate, defensive check.
    assert mgr.is_current("all", "2030-01-01T00:00:00+00:00") is True
    assert mgr.is_current("all", "2000-01-01T00:00:00+00:00") is False
    assert mgr.is_current("all", "not-a-date") is False
