from fastapi.testclient import TestClient

from speasy_proxy import get_application


def test_hapi_only_serves_hapi_and_nothing_else(monkeypatch):
    monkeypatch.setenv("SPEASY_PROXY_HAPI_ONLY", "true")
    monkeypatch.setenv("SPEASY_PROXY_HAPI_TITLE", "My HAPI server")
    client = TestClient(get_application())
    about = client.get("/hapi/about").json()
    assert about["title"] == "My HAPI server"
    assert client.get("/hapi/capabilities").status_code == 200
    for path in ("/", "/plot", "/get_data", "/get_inventory", "/static/js/common.js"):
        assert client.get(path).status_code == 404, path


def test_full_proxy_by_default():
    client = TestClient(get_application())
    assert client.get("/hapi/about").json()["id"] == "speasy-proxy"
    assert client.get("/is_up").status_code == 200
