import io
import json
from datetime import datetime, timedelta, UTC
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from speasy.core.inventory.indexes import DatasetIndex, ParameterIndex, TemplatedParameterIndex
from speasy.products.variable import DataContainer, SpeasyVariable, VariableAxis, VariableTimeAxis

from speasy_proxy.hapi import create_hapi_app
from speasy_proxy.hapi.catalog import CDPP3DVIEW_FRAMES, SSC_FRAMES, build_catalog
from speasy_proxy.hapi.info import build_info, encode_fill
from speasy_proxy.hapi.status import HapiError
from speasy_proxy.hapi.times import format_times, parse_hapi_time, time_length, time_unit


# --- times -------------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("2020-01-02", datetime(2020, 1, 2, tzinfo=UTC)),
    ("2020-01-02Z", datetime(2020, 1, 2, tzinfo=UTC)),
    ("2020-01-02T03Z", datetime(2020, 1, 2, 3, tzinfo=UTC)),
    ("2020-01-02T03:04Z", datetime(2020, 1, 2, 3, 4, tzinfo=UTC)),
    ("2020-01-02T03:04:05.123456789Z", datetime(2020, 1, 2, 3, 4, 5, 123456, tzinfo=UTC)),
    ("2020-032T00:00:00Z", datetime(2020, 2, 1, tzinfo=UTC)),
    ("2020-366", datetime(2020, 12, 31, tzinfo=UTC)),
    ("2020-01-01T24:00:00Z", datetime(2020, 1, 2, tzinfo=UTC)),
])
def test_parses_hapi_times(text, expected):
    assert parse_hapi_time(text) == expected


@pytest.mark.parametrize("text", ["2020", "2020-13-01", "2021-366", "yesterday", "2020-01-01T00:00:00+02:00"])
def test_rejects_non_hapi_times(text):
    with pytest.raises(ValueError):
        parse_hapi_time(text)


@pytest.mark.parametrize("stamp, unit", [("2020-01-01T00:00:00.123", "ms"),
                                         ("2020-01-01T00:00:00.123456", "us"),
                                         ("2020-01-01T00:00:00.123456789", "ns")])
def test_times_keep_their_precision(stamp, unit):
    t = np.array([stamp], dtype="datetime64[ns]")
    assert time_unit(t) == unit
    formatted = format_times(t, time_length(unit))
    assert formatted[0] == stamp + "Z" and len(formatted[0]) == time_length(unit)


# --- fixtures ----------------------------------------------------------------

def _param(provider, uid, cls=ParameterIndex, **meta):
    return cls(name=uid.rsplit("/", 1)[-1], provider=provider, uid=uid, meta=meta)


def _dataset(provider, uid, params, **meta):
    ds = DatasetIndex(name=uid, provider=provider, uid=uid,
                      meta={"start_date": "2020-01-01T00:00:00Z", "stop_date": "2020-02-01T00:00:00Z", **meta})
    ds.__dict__.update({p.spz_name(): p for p in params})
    return ds


def _flat(**providers):
    return SimpleNamespace(**{name: SimpleNamespace(datasets=d.get("datasets", {}), parameters=d.get("parameters", {}))
                              for name, d in providers.items()})


def _inventories():
    amda = _dataset("amda", "clust1-fgm", [
        _param("amda", "c1_b_gsm", description="B GSM"),
        _param("amda", "c1_btot", description="|B|"),
        _param("amda", "c1_private", is_public=False),
        _param("amda", "c1_template", cls=TemplatedParameterIndex),
    ], desc="Cluster 1 FGM<br/> Sampling: 4S<br/> Provider: CSA")
    themis = _dataset("cda", "THB_L2_FGM", [
        _param("cda", "THB_L2_FGM/thb_fgs_gse", DEPEND_0="thb_fgs_time"),
        _param("cda", "THB_L2_FGM/thb_fgl_gse", DEPEND_0="thb_fgl_time"),
        _param("cda", "THB_L2_FGM/thb_fgs_btotal", DEPEND_0="thb_fgs_time"),
    ], description="THEMIS B FGM")
    omni = _dataset("cda", "OMNI_HRO_1MIN", [_param("cda", "OMNI_HRO_1MIN/BX_GSE", DEPEND_0="Epoch")])
    old = _dataset("cda", "NO_DEPEND", [_param("cda", "NO_DEPEND/x")])
    ace = _param("ssc", "ace", start_date="1997-08-25T17:48:00.000Z", stop_date="2026-11-09T23:49:00.000Z")
    return _flat(amda={"datasets": {"clust1-fgm": amda}},
                 cda={"datasets": {"THB_L2_FGM": themis, "OMNI_HRO_1MIN": omni, "NO_DEPEND": old}},
                 ssc={"parameters": {"ace": ace}})


# --- catalog -----------------------------------------------------------------

def test_catalog_groups_parameters_sharing_a_time_axis():
    catalog = build_catalog(_inventories())
    assert list(catalog) == ["amda/clust1-fgm", "cda/OMNI_HRO_1MIN", "cda/THB_L2_FGM@0", "cda/THB_L2_FGM@1",
                             "ssc/ace"]
    assert [s.name for s in catalog["cda/THB_L2_FGM@0"].parameters] == ["thb_fgs_gse", "thb_fgs_btotal"]
    assert [s.path for s in catalog["cda/THB_L2_FGM@1"].parameters] == ["cda/THB_L2_FGM/thb_fgl_gse"]


def test_catalog_leaves_out_private_and_templated_amda_parameters():
    amda = build_catalog(_inventories())["amda/clust1-fgm"]
    assert [s.name for s in amda.parameters] == ["c1_b_gsm", "c1_btot"]
    assert amda.title == "Cluster 1 FGM"
    assert amda.description == "Cluster 1 FGM; Sampling: 4S; Provider: CSA"


def test_catalog_spells_dates_as_hapi_times():
    ace = build_catalog(_inventories())["ssc/ace"]
    assert (ace.start_date, ace.stop_date) == ("1997-08-25T17:48:00Z", "2026-11-09T23:49:00Z")


def test_trajectories_have_one_parameter_per_frame():
    ace = build_catalog(_inventories())["ssc/ace"]
    assert [s.name for s in ace.parameters] == [f"position_{f}" for f in SSC_FRAMES]
    assert ace.parameters[1].key == "ssc/ace?coordinate_system=gsm"
    assert ace.parameters[0].like is None and {s.like for s in ace.parameters[1:]} == {"position_gse"}


# --- fake upstream -----------------------------------------------------------

_CADENCE = np.timedelta64(1, "s")


def _times(start, stop, cadence=_CADENCE):
    t0 = np.datetime64(start.replace(tzinfo=None), "ns")
    t1 = np.datetime64(stop.replace(tzinfo=None), "ns")
    first = t0 + (-(t0 - np.datetime64("2000-01-01", "ns")) % cadence)
    return np.arange(first, t1, cadence)


def _vector(start, stop, dtype=np.float32, fill=None):
    t = _times(start, stop)
    values = np.tile(np.arange(3, dtype=dtype), (len(t), 1))
    meta = {"UNITS": "nT"} if fill is None else {"UNITS": "nT", "FILLVAL": np.array([fill], dtype=dtype)}
    return SpeasyVariable(axes=[VariableTimeAxis(values=t)], values=DataContainer(values, meta=meta, name="v"),
                          columns=["bx", "by", "bz"])


def _scalar(start, stop, dtype=np.float64, cadence=_CADENCE):
    t = _times(start, stop, cadence)
    return SpeasyVariable(axes=[VariableTimeAxis(values=t)],
                          values=DataContainer(np.arange(len(t), dtype=dtype).reshape(-1, 1), meta={}, name="s"))


def _spectrogram(start, stop):
    t = _times(start, stop)
    energy = VariableAxis(values=np.tile(np.array([10., 20., 40.]), (len(t), 1)), name="energy",
                          meta={"UNITS": "eV"}, is_time_dependent=True)
    return SpeasyVariable(axes=[VariableTimeAxis(values=t), energy],
                          values=DataContainer(np.ones((len(t), 3)), meta={"UNITS": "counts"}, name="spec"))


class FakeUpstream:
    def __init__(self, products, data_from=None):
        self.products = products
        self.data_from = data_from  # no data before this date
        self.calls = []

    def __call__(self, path, start, stop, **options):
        self.calls.append((path, start, stop, options))
        if self.data_from is not None:
            start = max(start, self.data_from)
            if start >= stop:
                return None
        var = self.products[path](start, stop)
        if var is not None and "coordinate_system" in options:  # tell frames apart
            var.values[:] += SSC_FRAMES.index(options["coordinate_system"]) * 10
        return var


def _hapi_dataset(paths, start="2020-01-01T00:00:00Z", stop="2020-02-01T00:00:00Z"):
    from speasy_proxy.hapi.catalog import HapiDataset, HapiParameterSource
    return HapiDataset(id="test/ds", title="ds", start_date=start, stop_date=stop,
                       parameters=tuple(HapiParameterSource(name=p.rsplit("/", 1)[-1], path=p) for p in paths))


# --- info --------------------------------------------------------------------

def test_info_describes_vectors_from_a_sample():
    info = build_info(_hapi_dataset(["p/vec"]), FakeUpstream({"p/vec": _vector}))
    time, vec = info.parameters
    assert time == {"name": "Time", "type": "isotime", "units": "UTC", "length": 24, "fill": None}
    assert vec["type"] == "double" and vec["size"] == [3] and vec["label"] == ["bx", "by", "bz"]
    assert vec["units"] == "nT"
    assert (info.sample_start, info.sample_stop) == ("2020-01-31T23:00:00Z", "2020-02-01T00:00:00Z")


def test_time_varying_bins_get_their_own_centers_parameter_shared_between_parameters():
    info = build_info(_hapi_dataset(["p/spec_a", "p/spec_b"]),
                      FakeUpstream({"p/spec_a": _spectrogram, "p/spec_b": _spectrogram}))
    names = [p["name"] for p in info.parameters]
    assert names == ["Time", "spec_a", "energy", "spec_b"]
    assert info.parameters[1]["bins"] == [{"name": "energy", "units": "eV", "centers": "energy"}]
    assert info.parameters[3]["bins"][0]["centers"] == "energy"
    assert info.sources["energy"] == ("p/spec_a", 1)


def test_blank_units_are_null():
    def blank(a, b):
        v = _scalar(a, b)
        v.meta["UNITS"] = " "
        return v
    info = build_info(_hapi_dataset(["p/s"]), FakeUpstream({"p/s": blank}))
    assert info.parameters[1]["units"] is None


def test_wide_integers_are_declared_double():
    info = build_info(_hapi_dataset(["p/n32", "p/n64"]),
                      FakeUpstream({"p/n32": lambda a, b: _scalar(a, b, np.int32),
                                    "p/n64": lambda a, b: _scalar(a, b, np.int64)}))
    assert [p["type"] for p in info.parameters[1:]] == ["integer", "double"]


@pytest.mark.parametrize("fill, type_, dtype, expected", [
    (np.array([-1e31]), "double", np.float64, "-1e+31"),
    (np.array([-1e30], dtype=np.float32), "double", np.float32, "-1e+30"),
    (np.nan, "double", np.float64, "NaN"),
    (-2147483648, "integer", np.int32, "-2147483648"),
    (-1e31, "integer", np.int32, None),
    ("9999-12-31T23:59:59.999999999", "double", np.float64, None),
    (None, "double", np.float64, None),
])
def test_fill_is_spelled_as_one_number(fill, type_, dtype, expected):
    assert encode_fill(fill, type_, np.dtype(dtype)) == expected


def test_info_probes_with_one_parameter_until_a_window_has_data():
    upstream = FakeUpstream({"p/a": _scalar, "p/b": _scalar}, data_from=datetime(2020, 1, 1, 0, 30, tzinfo=UTC))
    # The end windows all have data here, so only the probe runs before the others are fetched.
    build_info(_hapi_dataset(["p/a", "p/b"]), upstream)
    assert [c[0] for c in upstream.calls] == ["p/a", "p/b"]


def test_sample_range_spans_enough_time_steps():
    every_12_min = np.timedelta64(720, "s")
    info = build_info(_hapi_dataset(["p/a"]), FakeUpstream({"p/a": lambda a, b: _scalar(a, b, cadence=every_12_min)}))
    assert info.cadence == "PT720S"
    assert (info.sample_start, info.sample_stop) == ("2020-01-31T20:00:00Z", "2020-02-01T00:00:00Z")


def test_info_falls_back_to_the_start_of_the_dataset():
    upstream = FakeUpstream({"p/a": lambda a, b: _scalar(a, b) if a < datetime(2020, 1, 2, tzinfo=UTC) else None})
    info = build_info(_hapi_dataset(["p/a"]), upstream)
    assert info.sample_start == "2020-01-01T00:00:00Z"


def test_info_without_any_data_is_an_error():
    with pytest.raises(HapiError) as e:
        build_info(_hapi_dataset(["p/a"]), FakeUpstream({"p/a": lambda a, b: None}))
    assert e.value.code == 1500


def test_info_with_only_upstream_failures_is_an_upstream_error():
    def boom(a, b):
        raise RuntimeError("upstream down")
    with pytest.raises(HapiError) as e:
        build_info(_hapi_dataset(["p/a"]), FakeUpstream({"p/a": boom}))
    assert e.value.code == 1501


# --- app ---------------------------------------------------------------------

_PRODUCTS = {
    "amda/c1_b_gsm": lambda a, b: _vector(a, b, fill=-1e30),
    "amda/c1_btot": _scalar,
    "cda/THB_L2_FGM/thb_fgs_gse": _vector,
    "cda/THB_L2_FGM/thb_fgs_btotal": _scalar,
    "cda/THB_L2_FGM/thb_fgl_gse": _vector,
    "cda/OMNI_HRO_1MIN/BX_GSE": _scalar,
    "ssc/ace": _vector,
}


@pytest.fixture
def client(tmp_path):
    upstream = FakeUpstream(dict(_PRODUCTS))
    app = create_hapi_app(fetch=upstream, info_cache_path=str(tmp_path / "info"),
                          max_request_duration=timedelta(days=10), server_id="test", title="Test",
                          contact="nobody", inventories=_inventories())
    c = TestClient(app)
    c.upstream = upstream
    return c


def _status(response):
    return response.json()["status"]["code"]


def test_about_capabilities_catalog(client):
    assert client.get("/about").json()["id"] == "test"
    assert client.get("/capabilities").json()["outputFormats"] == ["csv", "binary"]
    ids = [d["id"] for d in client.get("/catalog").json()["catalog"]]
    assert "cda/THB_L2_FGM@0" in ids


def test_info_overlays_inventory_dates(client):
    body = client.get("/info", params={"dataset": "amda/clust1-fgm"}).json()
    assert (body["startDate"], body["stopDate"]) == ("2020-01-01T00:00:00Z", "2020-02-01T00:00:00Z")
    assert [p["name"] for p in body["parameters"]] == ["Time", "c1_b_gsm", "c1_btot"]
    assert body["parameters"][1]["description"] == "B GSM"


def test_info_declares_cadence_and_metadata_last_modified(client):
    r = client.get("/info", params={"dataset": "amda/clust1-fgm"})
    assert r.json()["cadence"] == "PT1S"
    assert r.headers["last-modified"].endswith("GMT")
    assert client.get("/catalog").headers["last-modified"] == r.headers["last-modified"]


def test_sends_cors_headers_on_its_own(client):
    assert client.get("/about", headers={"Origin": "https://example.org"}).headers[
        "access-control-allow-origin"] == "*"


def test_info_is_cached(client):
    client.get("/info", params={"dataset": "amda/clust1-fgm"})
    calls = len(client.upstream.calls)
    client.get("/info", params={"id": "amda/clust1-fgm"})
    assert len(client.upstream.calls) == calls


def test_info_parameter_subset(client):
    body = client.get("/info", params={"dataset": "amda/clust1-fgm", "parameters": "c1_btot"}).json()
    assert [p["name"] for p in body["parameters"]] == ["Time", "c1_btot"]


_RANGE = {"start": "2020-01-10T00:00:00Z", "stop": "2020-01-10T00:00:03Z"}


def test_data_csv(client):
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", **_RANGE})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.text.splitlines() == ["2020-01-10T00:00:00.000Z,0.0,1.0,2.0,0.0",
                                   "2020-01-10T00:00:01.000Z,0.0,1.0,2.0,1.0",
                                   "2020-01-10T00:00:02.000Z,0.0,1.0,2.0,2.0"]


def test_data_with_only_time(client):
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", "parameters": "Time", **_RANGE})
    assert r.text.splitlines()[0] == "2020-01-10T00:00:00.000Z"


def test_errors_use_the_spec_messages(client):
    assert client.get("/info", params={"dataset": "nope"}).json()["status"]["message"].startswith(
        "HAPI error 1406: unknown dataset id")


def test_data_accepts_hapi2_parameter_names(client):
    r = client.get("/data", params={"id": "amda/clust1-fgm", "time.min": _RANGE["start"],
                                    "time.max": _RANGE["stop"], "parameters": "c1_btot"})
    assert r.text.splitlines()[0] == "2020-01-10T00:00:00.000Z,0.0"


def test_data_binary_matches_info(client):
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", "format": "binary", **_RANGE})
    dtype = np.dtype([("Time", "S24"), ("c1_b_gsm", "<f8", (3,)), ("c1_btot", "<f8")])
    records = np.frombuffer(r.content, dtype=dtype)
    assert records["Time"][0] == b"2020-01-10T00:00:00.000Z"
    assert records["c1_b_gsm"][1].tolist() == [0., 1., 2.]
    assert records["c1_btot"].tolist() == [0., 1., 2.]


def test_data_header(client):
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", "include": "header",
                                    "parameters": "c1_btot", **_RANGE})
    header_line, *rows = r.text.splitlines()
    header = json.loads(header_line[1:])
    assert header["format"] == "csv" and header["status"]["code"] == 1200
    assert [p["name"] for p in header["parameters"]] == ["Time", "c1_btot"]
    assert len(rows) == 3


def test_data_without_data_says_so_in_the_header(client):
    client.get("/info", params={"dataset": "amda/clust1-fgm"})
    client.upstream.products["amda/c1_btot"] = lambda a, b: None
    client.upstream.products["amda/c1_b_gsm"] = lambda a, b: None
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", "include": "header", **_RANGE})
    lines = r.text.splitlines()
    assert r.status_code == 200 and len(lines) == 1
    assert json.loads(lines[0][1:])["status"]["code"] == 1201


def test_data_is_trimmed_to_start_inclusive_stop_exclusive(client):
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", "parameters": "c1_btot",
                                    "start": "2020-01-10T00:00:00.5Z", "stop": "2020-01-10T00:00:02Z"})
    assert [row.split(",")[0] for row in r.text.splitlines()] == ["2020-01-10T00:00:01.000Z"]


def test_float32_fill_matches_in_csv_and_binary(client):
    client.upstream.products["amda/c1_b_gsm"] = lambda a, b: _vector(a, b, fill=-1e30)
    info = client.get("/info", params={"dataset": "amda/clust1-fgm"}).json()
    fill = info["parameters"][1]["fill"]
    assert fill == "-1e+30"

    def all_fill(a, b):
        v = _vector(a, b, fill=-1e30)
        v.values[:] = np.float32(-1e30)
        return v
    client.upstream.products["amda/c1_b_gsm"] = all_fill
    params = {"dataset": "amda/clust1-fgm", "parameters": "c1_b_gsm", **_RANGE}
    csv_value = client.get("/data", params=params).text.splitlines()[0].split(",")[1]
    assert float(csv_value) == float(fill)
    binary = np.frombuffer(client.get("/data", params={**params, "format": "binary"}).content,
                           dtype=np.dtype([("Time", "S24"), ("c1_b_gsm", "<f8", (3,))]))
    assert binary["c1_b_gsm"][0, 0] == float(fill)


@pytest.mark.parametrize("params, code, http", [
    ({"dataset": "amda/clust1-fgm", **_RANGE, "bogus": "1"}, 1401, 400),
    ({"dataset": "amda/nope", **_RANGE}, 1406, 404),
    ({"dataset": "amda/clust1-fgm", **_RANGE, "parameters": "nope"}, 1407, 404),
    ({"dataset": "amda/clust1-fgm", **_RANGE, "parameters": "c1_btot,c1_b_gsm"}, 1411, 400),
    ({"dataset": "amda/clust1-fgm", **_RANGE, "parameters": "c1_btot,c1_btot"}, 1411, 400),
    ({"dataset": "amda/clust1-fgm", "start": "garbage", "stop": _RANGE["stop"]}, 1402, 400),
    ({"dataset": "amda/clust1-fgm", "start": _RANGE["start"], "stop": "garbage"}, 1403, 400),
    ({"dataset": "amda/clust1-fgm", "start": _RANGE["stop"], "stop": _RANGE["start"]}, 1404, 400),
    ({"dataset": "amda/clust1-fgm", "start": "2000-01-01", "stop": "2020-01-01"}, 1408, 400),
    ({"dataset": "amda/clust1-fgm", **_RANGE, "format": "json"}, 1409, 400),
    ({"dataset": "amda/clust1-fgm", **_RANGE, "include": "everything"}, 1410, 400),
    ({"dataset": "amda/clust1-fgm"}, 1400, 400),
])
def test_data_errors(client, params, code, http):
    r = client.get("/data", params=params)
    assert (r.status_code, _status(r)) == (http, code)


def test_data_rejects_parameters_on_different_time_axes(client):
    client.get("/info", params={"dataset": "amda/clust1-fgm"})
    client.upstream.products["amda/c1_btot"] = lambda a, b: _scalar(a + timedelta(milliseconds=500), b)
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", **_RANGE})
    assert (r.status_code, _status(r)) == (500, 1500)


def test_data_upstream_failure(client):
    client.get("/info", params={"dataset": "amda/clust1-fgm"})

    def boom(a, b):
        raise RuntimeError("down")
    client.upstream.products["amda/c1_btot"] = boom
    r = client.get("/data", params={"dataset": "amda/clust1-fgm", **_RANGE})
    assert (r.status_code, _status(r)) == (502, 1501)


def test_trajectory_frames_are_sampled_once_and_fetched_on_demand(client):
    info = client.get("/info", params={"dataset": "ssc/ace"}).json()
    assert [p["name"] for p in info["parameters"]] == ["Time"] + [f"position_{f}" for f in SSC_FRAMES]
    gsm = info["parameters"][2]
    assert (gsm["coordinateSystemName"], gsm["vectorComponents"], gsm["size"]) == ("GSM", ["x", "y", "z"], [3])
    assert {c[3]["coordinate_system"] for c in client.upstream.calls} == {"gse"}

    client.upstream.calls.clear()
    rows = client.get("/data", params={"dataset": "ssc/ace", "parameters": "position_gsm", **_RANGE}).text
    assert rows.splitlines()[0] == "2020-01-10T00:00:00.000Z,10.0,11.0,12.0"
    assert [c[3] for c in client.upstream.calls] == [{"coordinate_system": "gsm"}]


def test_spectrogram_data_carries_its_bins_centers(client):
    client.upstream.products["cda/OMNI_HRO_1MIN/BX_GSE"] = _spectrogram
    info = client.get("/info", params={"dataset": "cda/OMNI_HRO_1MIN"}).json()
    assert [p["name"] for p in info["parameters"]] == ["Time", "BX_GSE", "energy"]
    rows = client.get("/data", params={"dataset": "cda/OMNI_HRO_1MIN", **_RANGE}).text.splitlines()
    assert rows[0] == "2020-01-10T00:00:00.000Z,1.0,1.0,1.0,10.0,20.0,40.0"
