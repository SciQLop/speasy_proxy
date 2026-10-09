"""The HAPI sub-app over a fixed, synthetic inventory: no network, same answers every run.

Each dataset exercises one way speasy data can look (float32 with fill, wide integers, spectrograms
with fixed or time-varying bins, multi-dimensional values, nanosecond timestamps, NaNs, trajectory
frames, gaps), so the HAPI verifier checks what we emit for all of them.

    uv run uvicorn --app-dir tests/hapi_conformance server:app --port 8765
"""
import os
import tempfile
from datetime import datetime, timedelta, UTC
from types import SimpleNamespace

# Importing speasy_proxy fetches every provider's inventory at import time; nothing here needs them.
os.environ.setdefault("SPEASY_CORE_DISABLED_PROVIDERS", "amda,cda,csa,ssc,cdpp3dview,archive,uiowaephtool")
os.environ.setdefault("SPEASY_PROXY_ENABLED", "false")

import numpy as np  # noqa: E402
from speasy.core.inventory.indexes import DatasetIndex, ParameterIndex  # noqa: E402
from speasy.products.variable import DataContainer, SpeasyVariable, VariableAxis, VariableTimeAxis  # noqa: E402

from speasy_proxy.hapi import create_hapi_app  # noqa: E402

START = datetime(2020, 1, 1, tzinfo=UTC)
STOP = datetime(2020, 3, 1, tzinfo=UTC)
_EPOCH = np.datetime64("2000-01-01", "ns")


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _times(start, stop, cadence: np.timedelta64, offset=np.timedelta64(0, "ns"), coverage=((START, STOP),)):
    """Timestamps on a fixed grid (so every parameter of a dataset shares them), inside coverage only."""
    chunks = []
    for c0, c1 in coverage:
        a, b = max(start, c0), min(stop, c1)
        if a >= b:
            continue
        t0, t1 = np.datetime64(a.replace(tzinfo=None), "ns"), np.datetime64(b.replace(tzinfo=None), "ns")
        first = t0 + (-(t0 - _EPOCH - offset) % cadence)
        chunks.append(np.arange(first, t1, cadence))
    return np.concatenate(chunks) if chunks else np.array([], dtype="datetime64[ns]")


def _phase(t: np.ndarray) -> np.ndarray:
    return ((t - _EPOCH) / np.timedelta64(1, "s")) / 3600.


def _var(t, values, meta=None, axes=(), columns=None, name="v"):
    return SpeasyVariable(axes=[VariableTimeAxis(values=t), *axes],
                          values=DataContainer(values, meta=meta or {}, name=name), columns=columns)


# --- products: (start, stop, **options) -> SpeasyVariable -------------------------------------------

_S4 = np.timedelta64(4, "s")
_GAPS = ((datetime(2020, 1, 1, tzinfo=UTC), datetime(2020, 1, 3, tzinfo=UTC)),
         (datetime(2020, 2, 27, tzinfo=UTC), STOP))


def b_gse(start, stop, **_):  # float32 vector with an ISTP-style one-element FILLVAL, every 10th sample filled
    t = _times(start, stop, _S4)
    p = _phase(t)
    v = np.stack([np.sin(p), np.cos(p), 0.5 * np.sin(2 * p)], axis=1).astype(np.float32) * 5
    v[(np.arange(len(t)) % 10) == 0] = np.float32(-1e31)
    return _var(t, v, {"UNITS": "nT", "FILLVAL": np.array([-1e31], dtype=np.float32), "CATDESC": "B in GSE"},
                columns=["bx", "by", "bz"], name="b_gse")


def quality(start, stop, **_):  # int16 flags with an integer fill
    t = _times(start, stop, _S4)
    v = (np.arange(len(t)) % 5).astype(np.int16).reshape(-1, 1)
    return _var(t, v, {"FILLVAL": np.array([-32768], dtype=np.int16), "CATDESC": "Quality flag"}, name="quality")


_ENERGY_TABLE = np.array([10., 20., 40., 80., 160.])
_NS = np.timedelta64(250_000_000, "ns")
_NS_OFFSET = np.timedelta64(123_456_789, "ns")


def omni_flux(start, stop, **_):  # spectrogram whose energy table changes with time (shared by two parameters)
    t = _times(start, stop, _NS, _NS_OFFSET)
    energy = np.outer(1 + 0.1 * (np.arange(len(t)) % 2), _ENERGY_TABLE)
    v = np.exp(-energy / 50.) * (1 + 0.1 * np.sin(_phase(t)))[:, None]
    return _var(t, v, {"UNITS": "counts", "FILLVAL": np.array([-1e31])},
                axes=[VariableAxis(values=energy, name="energy", meta={"UNITS": "eV"}, is_time_dependent=True)],
                name="omni_flux")


def para_flux(start, stop, **kw):
    v = omni_flux(start, stop, **kw)
    v.values[:] *= 0.5
    return v


def tick(start, stop, **_):  # int64 beyond 32 bits: declared double; same epoch as omni_flux
    t = _times(start, stop, _NS, _NS_OFFSET)
    return _var(t, (np.arange(len(t), dtype=np.int64) + 2 ** 40).reshape(-1, 1), name="tick")


_S60 = np.timedelta64(60, "s")


def density(start, stop, **_):  # float64 with NaNs, on its own epoch
    t = _times(start, stop, _S60)
    v = (5 + np.sin(_phase(t))).reshape(-1, 1)
    v[(np.arange(len(t)) % 7) == 3] = np.nan
    return _var(t, v, {"UNITS": " ", "FILLVAL": np.array([np.nan])}, name="density")  # blank units, as CDAWeb


_ANODES, _ENERGIES = np.arange(4.), np.array([1., 10., 100.])


def psd(start, stop, **_):  # 2-D values with fixed bins on both dimensions
    t = _times(start, stop, _S60)
    v = np.ones((len(t), 4, 3)) * np.arange(12.).reshape(4, 3) + _phase(t)[:, None, None]
    return _var(t, v, {"UNITS": "s^3 km^-6"},
                axes=[VariableAxis(values=_ANODES, name="anode", meta={"UNITS": "deg"}),
                      VariableAxis(values=_ENERGIES, name="energy", meta={"UNITS": "keV"})],
                name="psd")


def sparse_counts(start, stop, **_):  # data on a few days only: most of the range is empty
    t = _times(start, stop, _S60, coverage=_GAPS)
    return _var(t, np.arange(len(t), dtype=np.int32).reshape(-1, 1), name="sparse_counts")


_FRAME_SHIFT = {"gse": 0., "gsm": 1., "sm": 2., "geo": 3., "gm": 4., "geitod": 5., "geij2000": 6.,
                "J2000": 0., "ECLIPJ2000": 1., "HEE": 2., "HEEQ": 3., "HCI": 4., "GSE": 5., "GSM": 6., "SM": 7.}


def orbit(start, stop, coordinate_system=None, coordinate_frame=None, **_):
    t = _times(start, stop, np.timedelta64(720, "s"))
    p = _phase(t) / 24
    shift = _FRAME_SHIFT[coordinate_system or coordinate_frame or "gse"]
    v = 1.5e6 * np.stack([np.cos(p + shift), np.sin(p + shift), 0.01 * np.ones_like(p)], axis=1)
    return _var(t, v, {"UNITS": "km"}, columns=["X", "Y", "Z"], name="Position")


PRODUCTS = {
    "amda/test_b_gse": b_gse,
    "amda/test_quality": quality,
    "amda/test_sparse_counts": sparse_counts,
    "cda/TEST_MULTI_EPOCH/omni_flux": omni_flux,
    "cda/TEST_MULTI_EPOCH/para_flux": para_flux,
    "cda/TEST_MULTI_EPOCH/tick": tick,
    "cda/TEST_MULTI_EPOCH/density": density,
    "csa/TEST_PSD/psd__TEST_PSD": psd,
    "ssc/testsat": orbit,
    "cdpp3dview/TESTSAT": orbit,
}


def fetch(path, start, stop, **options):
    return PRODUCTS[path](start, stop, **options)


# --- inventory ---------------------------------------------------------------------------------------

def _param(provider, uid, **meta):
    return ParameterIndex(name=uid.rsplit("/", 1)[-1], provider=provider, uid=uid,
                          meta={"start_date": _iso(START), "stop_date": _iso(STOP), **meta})


def _dataset(provider, uid, params, **meta):
    ds = DatasetIndex(name=uid, provider=provider, uid=uid,
                      meta={"start_date": _iso(START), "stop_date": _iso(STOP), **meta})
    ds.__dict__.update({p.spz_name(): p for p in params})
    return ds


def inventories():
    amda = _dataset("amda", "test-mag", [_param("amda", "test_b_gse", description="Magnetic field in GSE"),
                                         _param("amda", "test_quality", description="Quality flag")],
                    desc="Test magnetometer<br/> Sampling: 4S<br/> Provider: synthetic")
    sparse = _dataset("amda", "test-sparse", [_param("amda", "test_sparse_counts", description="Counts")],
                      desc="Test sparse counts")
    cda = _dataset("cda", "TEST_MULTI_EPOCH", [
        _param("cda", "TEST_MULTI_EPOCH/omni_flux", DEPEND_0="Epoch_fast", CATDESC="Omni flux"),
        _param("cda", "TEST_MULTI_EPOCH/para_flux", DEPEND_0="Epoch_fast", CATDESC="Parallel flux"),
        _param("cda", "TEST_MULTI_EPOCH/tick", DEPEND_0="Epoch_fast", CATDESC="Tick counter"),
        _param("cda", "TEST_MULTI_EPOCH/density", DEPEND_0="Epoch_slow", CATDESC="Density"),
    ], description="Test dataset with two time variables")
    csa = _dataset("csa", "TEST_PSD", [_param("csa", "TEST_PSD/psd__TEST_PSD", cat_description="Phase space density")],
                   title="Test phase space density")
    return SimpleNamespace(
        amda=SimpleNamespace(datasets={"test-mag": amda, "test-sparse": sparse}, parameters={}),
        cda=SimpleNamespace(datasets={"TEST_MULTI_EPOCH": cda}, parameters={}),
        csa=SimpleNamespace(datasets={"TEST_PSD": csa}, parameters={}),
        ssc=SimpleNamespace(datasets={}, parameters={"testsat": _param("ssc", "testsat")}),
        cdpp3dview=SimpleNamespace(datasets={}, parameters={"TESTSAT": _param("cdpp3dview", "TESTSAT")}),
    )


app = create_hapi_app(fetch=fetch, info_cache_path=tempfile.mkdtemp(prefix="hapi_conformance_"),
                      max_request_duration=timedelta(days=31), server_id="speasy-proxy-conformance",
                      title="speasy-proxy conformance", contact="https://github.com/SciQLop/speasy_proxy/issues",
                      inventories=inventories())
