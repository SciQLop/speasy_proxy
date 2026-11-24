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


CATALOG = [{"id": "sorce/mag", "title": "SORCE magnetometer", "info": INFO},
           {"id": "no_info", "title": "Not described"}]


def fake_fetch(url):
    if url == dump_url("LISIRD"):
        return {"catalog": CATALOG}
    raise OSError("unreachable")


def wrapped_fetch(url):
    """The shape the dumps took on 2026-11-24 (DAS2, LISIRD, CDAWeb...): the catalog response itself under 'catalog'."""
    if url == dump_url("LISIRD"):
        return {"about": {"id": "LISIRD", "title": "LISIRD", "x_url": "https://lasp.colorado.edu/lisird/hapi"},
                "catalog": {"catalog": CATALOG, "x_LastUpdate": "2026-11-24T16:06:23Z"},
                "capabilities": {"outputFormats": ["csv"], "x_LastUpdate": "2026-11-24T16:06:33Z"}}
    raise OSError("unreachable")


@pytest.mark.parametrize("fetch", [fake_fetch, wrapped_fetch], ids=["catalog_list", "catalog_object"])
def test_fills_each_server_with_its_datasets_and_parameters(fetch):
    inventory = to_dict(hapi_inventory(servers(), fetch), version=2)
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


def lisird_down(url):
    raise OSError("unreachable")


def test_a_failed_dump_keeps_the_previously_served_server(caplog):
    previous = hapi_inventory(servers(), fake_fetch)
    inventory = to_dict(hapi_inventory(servers(), lisird_down, previous=previous), version=2)
    assert inventory["lisird"]["sorce"]["mag"]["Bx"]["__spz_uid__"] == "lisird/sorce/mag/Bx"
    assert "kept the previous lisird" in caplog.text


def test_a_failed_dump_without_previous_copy_is_served_empty():
    inventory = to_dict(hapi_inventory(servers(), lisird_down, previous=None), version=2)
    assert "sorce" not in inventory["lisird"]
    assert inventory["lisird"]["title"] == "LISIRD"


def test_a_successful_dump_replaces_the_previous_copy():
    def other_catalog(url):
        return {"catalog": [{"id": "tsis/ssi", "title": "TSIS SSI", "info": INFO}]}

    previous = hapi_inventory(servers(), fake_fetch)
    inventory = to_dict(hapi_inventory(servers(), other_catalog, previous=previous), version=2)
    assert "tsis" in inventory["lisird"]
    assert "sorce" not in inventory["lisird"]
