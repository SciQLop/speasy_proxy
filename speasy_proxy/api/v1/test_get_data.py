import importlib
import json
from datetime import datetime, UTC

import numpy as np
import pytest
from speasy.products.variable import SpeasyVariable, VariableAxis, VariableTimeAxis, DataContainer

m = importlib.import_module("speasy_proxy.api.v1.get_data")


class _FakeRequest:
    base_url = "http://test/"

    def __init__(self, headers=None):
        self.headers = headers or {}
        self.client = None


def test_json_none_returns_json_not_pickle():
    """Regression for BL-6: a None result requested as json must come back as
    json (mime + body), not a pickled None with an application/python-pickle mime."""
    out, mime = m.encode_output(None, "amda/x", "2020-01-01", "2020-01-02", "json", None)
    assert "json" in mime
    assert json.loads(out) is None


def test_html_bokeh_none_returns_html():
    out, mime = m.encode_output(None, "amda/x", "2020-01-01", "2020-01-02", "html_bokeh", _FakeRequest())
    assert "html" in mime
    assert isinstance(out, str)


def test_python_dict_none_still_pickle():
    """python_dict/speasy_variable keep their pickle-of-None behavior."""
    import pickle
    out, mime = m.encode_output(None, "amda/x", "2020-01-01", "2020-01-02", "python_dict", None)
    assert mime == "application/python-pickle"
    assert pickle.loads(out) is None


def _var_with_byte_string_label_axis() -> SpeasyVariable:
    """A vector variable whose component-label axis is a numpy byte-string (|S) array,
    like CDAWeb's ACE ``BGSEc`` ``cartesian`` axis."""
    time = VariableTimeAxis(
        values=np.array(['2016-06-01T00:00:00', '2016-06-01T00:00:01'], dtype='datetime64[ns]'))
    labels = VariableAxis(
        values=np.array([b'Bx GSE', b'By GSE', b'Bz GSE'], dtype='S11'),
        name='cartesian', is_time_dependent=False)
    values = DataContainer(
        values=np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype='float32'),
        meta={'UNITS': 'nT', 'DISPLAY_TYPE': 'time_series'})
    return SpeasyVariable(axes=[time, labels], values=values, columns=['Bx GSE', 'By GSE', 'Bz GSE'])


def test_to_json_serializes_byte_string_label_axis():
    """Regression: byte-string label axes used to raise
    'TypeError: Object of type bytes is not JSON serializable' -> /get_data?format=json 500."""
    parsed = json.loads(m.to_json(_var_with_byte_string_label_axis()))

    label_axis = next(ax for ax in parsed['axes'] if ax['name'] == 'cartesian')
    assert label_axis['values'] == ['Bx GSE', 'By GSE', 'Bz GSE']
    assert parsed['values']['meta']['UNITS'] == 'nT'


class _FakeClient:
    host = "127.0.0.1"


class _FakeGetDataRequest(_FakeRequest):
    def __init__(self):
        super().__init__()
        self.client = _FakeClient()


def test_inverted_time_range_is_rejected():
    """A stop_time before start_time must be rejected as invalid."""
    reason = m._invalid_time_range_reason(
        datetime(2018, 10, 24, 2, 0, 0, tzinfo=UTC),
        datetime(2018, 10, 24, 0, 0, 0, tzinfo=UTC),
    )
    assert reason is not None


def test_equal_time_range_is_rejected():
    same = datetime(2018, 10, 24, 0, 0, 0, tzinfo=UTC)
    assert m._invalid_time_range_reason(same, same) is not None


def test_valid_time_range_is_accepted():
    reason = m._invalid_time_range_reason(
        datetime(2018, 10, 24, 0, 0, 0, tzinfo=UTC),
        datetime(2018, 10, 24, 2, 0, 0, tzinfo=UTC),
    )
    assert reason is None


def test_oversized_time_range_is_rejected():
    reason = m._invalid_time_range_reason(
        datetime(1970, 1, 1, tzinfo=UTC),
        datetime(2100, 1, 1, tzinfo=UTC),
    )
    assert reason is not None


@pytest.mark.anyio
async def test_inverted_range_never_reaches_get_data(monkeypatch):
    """Regression for the finding: an inverted range must be rejected with a 400
    before ever dispatching to spz.get_data() in the threadpool."""
    called = False

    def _fail_if_called(*args, **kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(m, "_get_data", _fail_if_called)

    resp = await m.get_data(
        request=_FakeGetDataRequest(),
        path="amda/c1_b_gsm",
        start_time=datetime(2018, 10, 24, 2, 0, 0, tzinfo=UTC),
        stop_time=datetime(2018, 10, 24, 0, 0, 0, tzinfo=UTC),
        format="json",
        _=None,
    )

    assert resp.status_code == 400
    assert called is False


@pytest.mark.anyio
async def test_oversized_range_never_reaches_get_data(monkeypatch):
    called = False

    def _fail_if_called(*args, **kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(m, "_get_data", _fail_if_called)

    resp = await m.get_data(
        request=_FakeGetDataRequest(),
        path="amda/c1_b_gsm",
        start_time=datetime(1970, 1, 1, tzinfo=UTC),
        stop_time=datetime(2100, 1, 1, tzinfo=UTC),
        format="json",
        _=None,
    )

    assert resp.status_code == 400
    assert called is False


@pytest.mark.anyio
async def test_valid_range_still_reaches_get_data(monkeypatch):
    """A normal, correctly-ordered, small range must still be dispatched (no
    behavior change for valid requests)."""
    called = False

    def _stub_get_data(*args, **kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(m, "_get_data", _stub_get_data)

    resp = await m.get_data(
        request=_FakeGetDataRequest(),
        path="amda/c1_b_gsm",
        start_time=datetime(2018, 10, 24, 0, 0, 0, tzinfo=UTC),
        stop_time=datetime(2018, 10, 24, 2, 0, 0, tzinfo=UTC),
        format="json",
        _=None,
    )

    assert resp.status_code == 200
    assert called is True


@pytest.fixture
def anyio_backend():
    return "asyncio"
