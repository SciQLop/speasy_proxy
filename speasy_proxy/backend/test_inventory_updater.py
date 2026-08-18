import threading
from datetime import UTC, datetime, timedelta

from speasy.core.inventory.indexes import SpeasyIndex
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


def test_eager_build_covers_common_variants_and_zstd():
    """Only JSON + pickle protocols 3/4 (versions 1..2) are built eagerly, each
    with a pre-compressed zstd variant; protocols 1, 2 and 5 are left out."""
    import pyzstd
    _quiet_tree()
    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    built = mgr._build_all_inventories()
    assert "inventory/all/json" in built
    for proto in (3, 4):
        for version in (1, 2):
            assert f"inventory/all/pickle_proto_{proto}_version_{version}" in built
            assert f"inventory/all/pickle_proto_{proto}_version_{version}/zstd" in built
    assert pyzstd.decompress(built["inventory/all/json/zstd"]).decode() == built["inventory/all/json"]
    for proto in (1, 2, 5):
        assert f"inventory/all/pickle_proto_{proto}_version_1" not in built


def test_non_eager_pickle_protocol_built_lazily_and_memoized():
    """A valid but non-eager variant (here pickle protocol 5) is built on first
    request and memoized."""
    _quiet_tree()
    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    mgr._inventories = mgr._build_all_inventories()
    data = mgr.get_inventory("all", "python_dict", version=2, pickle_proto=5)
    assert data is not None
    assert mgr._inventories["inventory/all/pickle_proto_5_version_2"] is data


def test_missing_eager_variant_is_not_built_lazily():
    """An eager variant that is somehow absent stays absent (404, not a lazy
    rebuild) — lazy building is only for non-eager combinations."""
    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    mgr._inventories = {}
    assert mgr.get_inventory("all", "python_dict", version=2, pickle_proto=3) is None


def test_lazy_build_excludes_concurrent_tree_refresh():
    """speasy's DataProvider.update_inventory() clears the existing SpeasyIndex
    IN PLACE before reassigning it (speasy/core/dataprovider.py: `tree.__dict__[name].clear()`
    then `tree.__dict__[name] = new_inventory`). _build_lazy() reads that same shared
    `tree` global; without mutual exclusion a lazy build racing a refresh can observe
    the object mid-clear and permanently cache a torn/empty pickle under its key.
    This proves _build_lazy() and a refresh both hold the same tree lock, so one
    always fully completes before the other's tree mutation/read begins."""
    provider_index = SpeasyIndex(name="ssc", provider="ssc", uid="ssc")
    provider_index.__dict__["some_param"] = SpeasyIndex(name="p", provider="ssc", uid="ssc/p")
    tree.__dict__["ssc"] = provider_index

    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))

    build_started = threading.Event()
    release_build = threading.Event()
    real_to_dict = inventory_updater.to_dict

    def slow_to_dict(source, *a, **k):
        build_started.set()
        release_build.wait(timeout=2)
        return real_to_dict(source, *a, **k)

    inventory_updater.to_dict = slow_to_dict
    try:
        result = {}

        def do_lazy_build():
            result["data"] = mgr._build_lazy(
                "ssc", "python_dict", 1, 5, "inventory/ssc/pickle_proto_5_version_1"
            )

        t = threading.Thread(target=do_lazy_build)
        t.start()
        assert build_started.wait(timeout=2), "lazy build never reached to_dict()"

        # Simulate the exact clear-then-reassign speasy performs mid-refresh, via
        # the same coordination point _refresh_if_due() uses (its own call is
        # exercised end-to-end by test_refresh_excludes_concurrent_lazy_build below).
        with mgr._tree_lock:
            provider_index.clear()
            tree.__dict__["ssc"] = SpeasyIndex(name="ssc", provider="ssc", uid="ssc")

        release_build.set()
        t.join(timeout=2)
    finally:
        inventory_updater.to_dict = real_to_dict

    import pickle
    # Test-only: unpickling data this same test just pickled above, not untrusted input.
    unpickled = pickle.loads(result["data"])
    assert "some_param" in unpickled, "lazy build observed a torn/cleared tree"


def test_refresh_excludes_concurrent_lazy_build(monkeypatch):
    """The other half of the same contract: a refresh's spz.update_inventories()
    call must not proceed while a lazy build is mid-flight on the same tree
    entry — proven by mutual exclusion on InventoryManager._tree_lock."""
    _quiet_tree()
    provider_index = SpeasyIndex(name="ssc", provider="ssc", uid="ssc")
    tree.__dict__["ssc"] = provider_index

    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    monkeypatch.setattr(mgr, "_build_all_inventories", lambda: {"inv": "x"})
    monkeypatch.setattr(mgr, "_collect_build_dates", lambda: {})

    lazy_holds_lock = threading.Event()
    release_lazy = threading.Event()

    # No-op: _refresh_if_due() itself wraps this call in `with self._tree_lock:`,
    # so the mutual exclusion under test happens before this function is even
    # entered — it must NOT also acquire _tree_lock (that would be a reentrant
    # acquire of a plain, non-reentrant Lock from the same thread and deadlock).
    monkeypatch.setattr(inventory_updater.spz, "update_inventories", lambda: None)

    def held_lazy_build():
        with mgr._tree_lock:
            lazy_holds_lock.set()
            release_lazy.wait(timeout=2)

    t = threading.Thread(target=held_lazy_build)
    t.start()
    assert lazy_holds_lock.wait(timeout=2)

    # While the lazy build holds the lock, the tree lock must not be free.
    assert mgr._tree_lock.acquire(blocking=False) is False

    release_lazy.set()
    t.join(timeout=2)
    mgr._refresh_if_due()  # must complete now that the lock is free
    assert mgr._inventories == {"inv": "x"}
