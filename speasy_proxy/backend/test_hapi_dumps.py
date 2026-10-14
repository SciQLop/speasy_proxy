"""The HAPI servers' products are read from the HAPI project's nightly dumps (offline: fake fetch)."""
import pytest

pytest.importorskip("speasy.core.hapi.inventory", reason="speasy without the HAPI provider")

from speasy.core.inventory.indexes import SpeasyIndex, to_dict  # noqa: E402

from speasy_proxy.backend.hapi_dumps import hapi_inventory, dump_url  # noqa: E402

INFO = {"HAPI": "3.1", "status": {"code": 1200, "message": "OK"}, "startDate": "2020-01-01Z", "stopDate": "2021-01-01Z",
        "parameters": [{"name": "Time", "type": "isotime", "units": "UTC", "length": 24},
                       {"name": "Bx", "type": "double", "units": "nT"}]}


def servers():
    root = SpeasyIndex(name="hapi", provider="hapi", uid="hapi", meta={"build_date": "2026-10-14T20:00:00+00:00"})
    for key, server_id in (("lisird", "LISIRD"), ("down", "DOWN")):
        root.__dict__[key] = SpeasyIndex(name=key, provider="hapi", uid=key,
                                         meta={"id": server_id, "title": server_id, "hapi_loaded": False})
    return root


def fake_fetch(url):
    if url == dump_url("LISIRD"):
        return {"catalog": [{"id": "sorce/mag", "title": "SORCE magnetometer", "info": INFO},
                            {"id": "no_info", "title": "Not described"}]}
    raise OSError("unreachable")


def test_fills_each_server_with_its_datasets_and_parameters():
    inventory = to_dict(hapi_inventory(servers(), fake_fetch), version=2)
    bx = inventory["lisird"]["sorce"]["mag"]["Bx"]
    assert bx["__spz_type__"] == "ParameterIndex"
    assert bx["__spz_uid__"] == "lisird/sorce/mag/Bx"
    assert inventory["build_date"] == "2026-10-14T20:00:00+00:00"


def test_keeps_a_server_whose_dump_is_unavailable_as_listed():
    inventory = to_dict(hapi_inventory(servers(), fake_fetch), version=2)
    assert inventory["down"]["title"] == "DOWN"


def test_leaves_speasy_tree_untouched():
    tree = servers()
    hapi_inventory(tree, fake_fetch)
    assert "sorce" not in tree.lisird.__dict__


def test_dump_url_escapes_the_server_id():
    assert dump_url("UCalgary/SRS") == "https://hapi-server.org/meta/catalog/UCalgary%2FSRS-all.json"
