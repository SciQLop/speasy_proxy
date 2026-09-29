"""HTTP-level contract of /get_data: validation, status codes and headers seen by any client."""
import importlib
import json

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer

from speasy_proxy.dependencies import trigger_inventory_check

m = importlib.import_module("speasy_proxy.api.v1.get_data")

RANGE = "start_time=2020-01-01T00:00:00&stop_time=2020-01-01T00:00:03"


def _var_with_nan() -> SpeasyVariable:
    time = VariableTimeAxis(values=np.array(['2020-01-01T00:00:00', '2020-01-01T00:00:01'], dtype='datetime64[ns]'))
    values = DataContainer(values=np.array([[1.0], [np.nan]]), meta={'UNITS': 'nT'}, name='b')
    return SpeasyVariable(axes=[time], values=values, columns=['b'])


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(m, "_get_data", lambda **kw: _var_with_nan())
    app = FastAPI()
    app.include_router(m.router)
    app.dependency_overrides[trigger_inventory_check] = lambda: None
    return TestClient(app)


@pytest.mark.parametrize("query", ["format=csv", "resample_strategy=foo&max_points=10"])
def test_unknown_enum_values_are_rejected(client, query):
    resp = client.get(f"/get_data?path=amda/imf&{RANGE}&{query}")
    assert resp.status_code == 422


def test_json_is_strict_json(client):
    resp = client.get(f"/get_data?path=amda/imf&{RANGE}&format=json")
    assert resp.status_code == 200
    body = json.loads(resp.text, parse_constant=lambda c: pytest.fail(f"non-standard JSON token {c}"))
    assert body["values"]["values"] == [[1.0], [None]]


@pytest.mark.parametrize("error", ["Can't find a provider for nope/x", "Given string does not look like a path x"])
def test_unknown_provider_is_404(client, monkeypatch, error):
    def _unknown(**kw):
        raise ValueError(error)

    monkeypatch.setattr(m, "_get_data", _unknown)
    resp = client.get(f"/get_data?path=nope/x&{RANGE}&format=json")
    assert resp.status_code == 404
    assert resp.json()["error"]


def test_unknown_product_is_404(client, monkeypatch):
    def _unknown(**kw):
        raise ValueError("Unknown product: x")

    monkeypatch.setattr(m, "_get_data", _unknown)
    resp = client.get(f"/get_data?path=amda/x&{RANGE}&format=json")
    assert resp.status_code == 404


def test_upstream_failure_stays_502(client, monkeypatch):
    def _down(**kw):
        raise IOError("upstream down")

    monkeypatch.setattr(m, "_get_data", _down)
    assert client.get(f"/get_data?path=amda/x&{RANGE}&format=json").status_code == 502


def test_server_timing_is_readable_by_browsers(client):
    resp = client.get(f"/get_data?path=amda/imf&{RANGE}&format=json")
    assert "server-timing" in resp.headers["access-control-expose-headers"].lower()


def test_cdf_download_has_a_filename(client):
    resp = client.get(f"/get_data?path=amda/imf&{RANGE}&format=cdf")
    assert 'filename="amda_imf_' in resp.headers["content-disposition"]
    assert resp.headers["content-disposition"].endswith('.cdf"')
