from starlette.requests import Request

from speasy_proxy.frontend.home import _build_base_url


def _request(root_path="", scheme="http"):
    scope = {
        "type": "http",
        "scheme": scheme,
        "server": ("testserver", 80),
        "headers": [],
        "path": "/",
        "root_path": root_path,
    }
    return Request(scope)


def test_base_url_without_prefix():
    assert _build_base_url(_request()) == "http://testserver"


def test_base_url_includes_root_path():
    assert _build_base_url(_request(root_path="/cache")) == "http://testserver/cache"


def test_base_url_root_path_is_normalized():
    assert _build_base_url(_request(root_path="/cache/")) == "http://testserver/cache"


def test_x_scheme_header_overrides_scheme():
    assert _build_base_url(_request(), x_scheme="https") == "https://testserver"


def test_home_plot_and_demo3d_pages_serve():
    from fastapi.testclient import TestClient
    from speasy_proxy import app

    client = TestClient(app)
    for path in ("/", "/plot", "/demo_3d"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert "SPEASY_BASE_URL" in response.text
