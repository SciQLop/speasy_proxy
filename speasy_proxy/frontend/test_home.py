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


def test_static_js_modules_are_not_heuristically_cached():
    # ES modules are served unbundled with stable filenames (no content hash).
    # A shared module (e.g. common.js) can gain a new export while an importer
    # (e.g. plot.js) starts relying on it in the same deploy. Without an
    # explicit revalidation directive, a browser that already cached the old
    # common.js under heuristic freshness keeps serving it alongside the new
    # plot.js, producing "does not provide an export named ..." after deploy.
    from fastapi.testclient import TestClient
    from speasy_proxy import app

    client = TestClient(app)
    response = client.get("/static/js/common.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
