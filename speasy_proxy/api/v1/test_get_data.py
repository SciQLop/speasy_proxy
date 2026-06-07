import importlib
import json

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
