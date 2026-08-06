import json

import pytest

from speasy_proxy.backend import presets as presets_mod
from speasy_proxy.backend.presets import load_presets


@pytest.fixture(autouse=True)
def _reset_presets_cache(monkeypatch):
    monkeypatch.setattr(presets_mod, "_cached_presets", None)


def _write_preset(dir_path, name, content):
    dir_path.mkdir(parents=True, exist_ok=True)
    path = dir_path / name
    path.write_text(json.dumps(content))
    return path


def test_missing_directory_returns_empty_list(tmp_path):
    assert load_presets(tmp_path / "does_not_exist") == []


def test_loads_top_level_presets(tmp_path):
    _write_preset(tmp_path, "a.json", {"name": "A", "description": "first", "products": ["amda/x"]})
    _write_preset(tmp_path, "b.json", {"description": "no explicit name"})
    loaded = load_presets(tmp_path)
    assert [p["name"] for p in loaded] == ["A", "b"]
    assert loaded[0]["description"] == "first"
    assert loaded[0]["featured"] is False
    assert loaded[0]["config"] == {"products": ["amda/x"]}
    assert loaded[1]["name"] == "b"


def test_loads_featured_presets_from_subdirectory(tmp_path):
    _write_preset(tmp_path, "plain.json", {"name": "plain"})
    _write_preset(tmp_path / "featured", "star.json", {"name": "star"})
    loaded = load_presets(tmp_path)
    by_name = {p["name"]: p for p in loaded}
    assert by_name["plain"]["featured"] is False
    assert by_name["star"]["featured"] is True


def test_invalid_json_file_is_skipped(tmp_path):
    _write_preset(tmp_path, "good.json", {"name": "good"})
    (tmp_path / "broken.json").write_text("{not json")
    loaded = load_presets(tmp_path)
    assert [p["name"] for p in loaded] == ["good"]


def test_result_is_cached(tmp_path):
    _write_preset(tmp_path, "a.json", {"name": "A"})
    first = load_presets(tmp_path)
    _write_preset(tmp_path, "b.json", {"name": "B"})
    assert load_presets(tmp_path) is first
