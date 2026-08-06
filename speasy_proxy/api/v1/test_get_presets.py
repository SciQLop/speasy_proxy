import importlib
import json

import pytest

from speasy_proxy.backend import presets as presets_mod

m = importlib.import_module("speasy_proxy.api.v1.get_presets")


@pytest.fixture(autouse=True)
def _reset_presets_cache(monkeypatch):
    monkeypatch.setattr(presets_mod, "_cached_presets", None)


def test_get_presets_reads_directory_from_env(tmp_path, monkeypatch):
    (tmp_path / "p.json").write_text(json.dumps({"name": "from env", "products": ["amda/x"]}))
    monkeypatch.setenv("SPEASY_PROXY_PRESETS_PATH", str(tmp_path))
    presets = m.get_presets()
    assert [p["name"] for p in presets] == ["from env"]


def test_get_presets_missing_dir_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.setenv("SPEASY_PROXY_PRESETS_PATH", str(tmp_path / "does_not_exist"))
    assert m.get_presets() == []
