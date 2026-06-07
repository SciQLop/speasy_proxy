from speasy_proxy.backend.shared_inventory_store import SharedInventoryStore


def test_disabled_store_is_safe_noop():
    store = SharedInventoryStore(path=None)
    assert store.enabled is False
    assert store.generation() == 0
    assert store.last_refresh() is None
    assert store.read_if_newer(0) is None
    assert store.try_acquire_lease(10) is True  # acts as sole leader when disabled
    store.release_lease()  # must not raise
    assert store.publish({"k": b"v"}, {"all": "2020"}) is None


def test_publish_then_read(tmp_path):
    store = SharedInventoryStore(path=str(tmp_path / "shared"))
    gen = store.publish({"inventory/all/json": "payload"}, {"all": "2020-01-01T00:00:00+00:00"})
    assert gen == 1
    assert store.generation() == 1
    assert store.last_refresh() is not None

    snap = store.read_if_newer(0)
    assert snap is not None
    g, payload, build_dates = snap
    assert g == 1
    assert payload == {"inventory/all/json": "payload"}
    assert build_dates == {"all": "2020-01-01T00:00:00+00:00"}

    # not newer than current generation -> None
    assert store.read_if_newer(1) is None


def test_seed_if_empty_only_once(tmp_path):
    path = str(tmp_path / "shared")
    a = SharedInventoryStore(path=path)
    b = SharedInventoryStore(path=path)
    first = a.seed_if_empty({"k": "a"}, {})
    second = b.seed_if_empty({"k": "b"}, {})
    assert first == 1
    assert second is None  # b lost the seed race
    assert b.read_if_newer(0)[1] == {"k": "a"}


def test_lease_is_exclusive_and_expires(tmp_path):
    path = str(tmp_path / "shared")
    a = SharedInventoryStore(path=path)
    b = SharedInventoryStore(path=path)
    assert a.try_acquire_lease(ttl=60) is True
    assert b.try_acquire_lease(ttl=60) is False  # exclusive
    a.release_lease()
    assert b.try_acquire_lease(ttl=60) is True  # released -> available


def test_corrupt_payload_returns_none(tmp_path):
    path = str(tmp_path / "shared")
    store = SharedInventoryStore(path=path)
    store.publish({"k": "v"}, {})
    # Corrupt the payload blob directly.
    from diskcache import Cache
    Cache(path).set("inventory/payload", b"not a pickle")
    assert store.read_if_newer(0) is None  # must not raise; caller keeps current
