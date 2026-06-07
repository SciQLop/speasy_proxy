def test_app_boots_and_serves(tmp_path, monkeypatch):
    """End-to-end: the app must boot (lifespan builds inventories + starts the
    refresh loop) and serve, even with no live providers — availability first."""
    monkeypatch.setenv("SPEASY_PROXY_CORE_INVENTORY_SHARED_PATH", str(tmp_path / "inv_shared"))

    from fastapi.testclient import TestClient
    from speasy_proxy import app

    with TestClient(app) as client:  # enters lifespan (build_inventories + periodic loop)
        assert client.get("/get_version").status_code == 200
        assert client.get("/get_server_status").status_code == 200
        # inventory must respond, never 5xx, regardless of provider availability
        assert client.get("/get_inventory?provider=all&format=json").status_code in (200, 304)
