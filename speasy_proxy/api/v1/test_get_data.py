import importlib
import json

import numpy as np
from speasy.products.variable import SpeasyVariable, VariableAxis, VariableTimeAxis, DataContainer

m = importlib.import_module("speasy_proxy.api.v1.get_data")


class _FakeRequest:
    base_url = "http://test/"


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
