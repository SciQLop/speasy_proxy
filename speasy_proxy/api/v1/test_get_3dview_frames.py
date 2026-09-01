import asyncio
import importlib

m = importlib.import_module("speasy_proxy.api.v1.get_3dview_frames")


def _run(coro):
    return asyncio.run(coro)


def test_returns_empty_list_when_provider_unavailable(monkeypatch):
    """Disabled via SPEASY_CORE_DISABLED_PROVIDERS, or a speasy version without
    3DView support -- not an error, just nothing to offer the frontend."""
    monkeypatch.delattr(m.spz, "cdpp3dview", raising=False)
    resp = _run(m.get_3dview_frames())
    assert resp.status_code == 200
    assert resp.body == b'{"frames":[]}'


def test_returns_provider_frames(monkeypatch):
    class FakeProvider:
        @staticmethod
        def get_frames():
            return ["J2000", "GSE"]

    monkeypatch.setattr(m.spz, "cdpp3dview", FakeProvider, raising=False)
    resp = _run(m.get_3dview_frames())
    assert resp.status_code == 200
    assert resp.body == b'{"frames":["J2000","GSE"]}'


def test_provider_failure_degrades_to_empty_list(monkeypatch):
    class FailingProvider:
        @staticmethod
        def get_frames():
            raise RuntimeError("3dview unreachable")

    monkeypatch.setattr(m.spz, "cdpp3dview", FailingProvider, raising=False)
    resp = _run(m.get_3dview_frames())
    assert resp.status_code == 200
    assert resp.body == b'{"frames":[]}'
