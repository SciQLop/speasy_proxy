import importlib

# NB: `from speasy_proxy.api.v1 import is_up` returns the *endpoint function*, not
# this module, because api/v1/__init__ star-imports it into the package namespace.
m = importlib.import_module("speasy_proxy.api.v1.is_up")


def test_base_url_provider_uses_real_http_check(monkeypatch):
    """Regression for BL-3: a provider that exposes only BASE_URL (no
    is_server_up classmethod) must be checked via speasy's HTTP probe. The
    original code shadowed the imported `is_server_up` with the local decorated
    function, so the BASE_URL branch recursed into itself and always returned
    True, never consulting the real checker."""

    calls = []

    def fake_http_check(url):
        calls.append(url)
        return False

    monkeypatch.setattr(m, "_http_is_server_up", fake_http_check, raising=False)

    class FakeProvider:  # only BASE_URL, no is_server_up method
        BASE_URL = "http://example.test/api"

    m.is_server_up.drop_entries()  # is_pure=True keeps a persistent cache
    assert m.is_server_up(FakeProvider) is False
    assert calls == ["http://example.test/api"]


def test_provider_with_method_is_used(monkeypatch):
    """A provider that defines is_server_up() must be consulted directly."""

    class FakeProvider:
        @staticmethod
        def is_server_up():
            return True

    m.is_server_up.drop_entries()  # is_pure=True keeps a persistent cache
    assert m.is_server_up(FakeProvider) is True
