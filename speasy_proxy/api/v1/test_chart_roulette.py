import importlib
from datetime import datetime, UTC
from types import SimpleNamespace

import numpy as np
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer

import speasy as spz

# import the submodule, not the star-imported endpoint function (see BL-10)
m = importlib.import_module("speasy_proxy.api.v1.chart_roulette")


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


class _FakeProduct:
    def spz_provider(self):
        return "amda"

    def spz_uid(self):
        return "fake_product"

    def __str__(self):
        return "amda/fake_product"


def _valid_range():
    return SimpleNamespace(
        start_time=datetime(2020, 1, 1, tzinfo=UTC),
        stop_time=datetime(2020, 2, 1, tzinfo=UTC),
    )


def _patch_provider_range(monkeypatch, max_range):
    monkeypatch.setattr(spz.core.dataprovider, "PROVIDERS",
                        {"amda": SimpleNamespace(_parameter_range=lambda product: max_range)})


def _float_var():
    times = np.arange(10).astype("datetime64[s]").astype("datetime64[ns]")
    values = np.array([[1.0], [-1e31], [3.0]] * 3 + [[4.0]])
    axis = VariableTimeAxis(values=times, meta={})
    data = DataContainer(values=values, meta={"FILLVAL": -1e31}, name="x")
    return SpeasyVariable(axes=[axis], values=data)


def test_empty_inventory_returns_friendly_page(monkeypatch):
    """Regression for BL-32: a provider with an empty inventory made
    random_pick_product raise IndexError -> HTTP 500. The endpoint must answer
    with the friendly fallback page instead."""
    monkeypatch.setattr(m, "choice", lambda seq: seq[0])
    monkeypatch.setattr(spz.inventories, "flat_inventories",
                        SimpleNamespace(amda=SimpleNamespace(parameters={})))
    resp = m.chart_roulette(request=_FakeRequest())
    assert resp.status_code == 200
    assert b"Oops" in resp.body


def test_missing_parameter_range_returns_friendly_page(monkeypatch):
    """Regression for BL-32: _parameter_range is Optional; a None range used to
    raise AttributeError inside the handler -> HTTP 500."""
    monkeypatch.setattr(m, "random_pick_product", lambda: _FakeProduct())
    _patch_provider_range(monkeypatch, None)
    resp = m.chart_roulette(request=_FakeRequest())
    assert resp.status_code == 200
    assert b"Oops" in resp.body


def test_too_short_range_returns_friendly_page(monkeypatch):
    """Regression for BL-32: when the product's whole range is shorter than the
    24h window, uniform() raises ValueError -> was HTTP 500."""
    monkeypatch.setattr(m, "random_pick_product", lambda: _FakeProduct())
    _patch_provider_range(monkeypatch, SimpleNamespace(
        start_time=datetime(2020, 1, 1, tzinfo=UTC),
        stop_time=datetime(2020, 1, 1, 12, tzinfo=UTC),
    ))
    resp = m.chart_roulette(request=_FakeRequest())
    assert resp.status_code == 200
    assert b"Oops" in resp.body


def test_all_retries_empty_returns_no_range(monkeypatch):
    """Regression for BL-22: when every retry yields None, no arbitrary range
    from the last iteration may leak out."""
    monkeypatch.setattr(spz, "get_data", lambda *args, **kwargs: None)
    _patch_provider_range(monkeypatch, _valid_range())
    product, data, start, stop = m.get_product_random_range(_FakeProduct(), _FakeRequest())
    assert product is not None
    assert data is None
    assert start is None
    assert stop is None


def test_success_returns_sanitized_data(monkeypatch):
    monkeypatch.setattr(spz, "get_data", lambda *args, **kwargs: _float_var())
    _patch_provider_range(monkeypatch, _valid_range())
    product, data, start, stop = m.get_product_random_range(_FakeProduct(), _FakeRequest())
    assert data is not None
    assert start is not None and stop is not None
    assert np.isnan(data.values).any()
    assert not (data.values == -1e31).any()
