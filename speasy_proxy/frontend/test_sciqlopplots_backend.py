import pytest
from fastapi.testclient import TestClient

ISOLATION = {"cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless"}


@pytest.fixture
def wasm_build(tmp_path, monkeypatch):
    (tmp_path / "sciqlopplots.js").write_text("// fake build")
    monkeypatch.setenv("SPEASY_PROXY_SCIQLOPPLOTS_PATH", str(tmp_path))
    return tmp_path


def _client():
    from speasy_proxy import get_application
    return TestClient(get_application())


def _isolation_headers(response):
    return {k: response.headers.get(k) for k in ISOLATION}


def test_default_plot_page_is_not_cross_origin_isolated(wasm_build):
    response = _client().get("/plot")
    assert _isolation_headers(response) == {k: None for k in ISOLATION}
    assert "SPEASY_PLOT_BACKEND = ''" in response.text


def test_sciqlopplots_backend_page_is_cross_origin_isolated(wasm_build):
    response = _client().get("/plot?backend=sciqlopplots")
    assert _isolation_headers(response) == ISOLATION
    assert "SPEASY_PLOT_BACKEND = 'sciqlopplots'" in response.text


def test_sciqlopplots_backend_falls_back_to_uplot_without_a_build(monkeypatch):
    monkeypatch.delenv("SPEASY_PROXY_SCIQLOPPLOTS_PATH", raising=False)
    response = _client().get("/plot?backend=sciqlopplots")
    assert _isolation_headers(response) == {k: None for k in ISOLATION}
    assert "SPEASY_PLOT_BACKEND = ''" in response.text


def test_wasm_build_is_served_cross_origin_isolated(wasm_build):
    # Wasm threads are Web Workers started from sciqlopplots.js: an isolated page only
    # starts workers whose script carries a compatible embedder policy.
    response = _client().get("/sciqlopplots/sciqlopplots.js")
    assert response.status_code == 200
    assert _isolation_headers(response) == ISOLATION


def test_wasm_build_is_not_mounted_without_a_build(monkeypatch):
    monkeypatch.delenv("SPEASY_PROXY_SCIQLOPPLOTS_PATH", raising=False)
    assert _client().get("/sciqlopplots/sciqlopplots.js").status_code == 404
