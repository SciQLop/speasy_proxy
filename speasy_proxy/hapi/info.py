"""Builds a dataset's /info from a sample of its data.

The inventory alone can't describe a parameter for HAPI: shapes, types and bins are spelled
differently by every provider, or are missing. And clients reject /data that doesn't match /info,
so /info is taken from real data: a short window of every parameter, fetched once and then cached.
"""
import copy
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from speasy.products.variable import SpeasyVariable

from .catalog import HapiDataset, split_fetch_key
from .status import HapiError
from .times import time_length, time_unit, to_hapi_time

log = logging.getLogger(__name__)

# fetch(path, start, stop, **get_data_options)
Fetch = Callable[..., Optional[SpeasyVariable]]

# Tried in turn near the end of the dataset, then near its start, until every parameter has data.
SAMPLE_WINDOWS = (timedelta(hours=1), timedelta(days=1), timedelta(days=7), timedelta(days=31))

# HAPI integers are 32-bit; anything wider (or unsigned 32-bit) is declared double, decided on the
# dtype alone so that /info doesn't depend on which values the sample happened to hold.
_HAPI_INTEGER_DTYPES = tuple(np.dtype(t) for t in ("int8", "int16", "int32", "uint8", "uint16"))
_INT32 = np.iinfo(np.int32)


@dataclass
class DatasetInfo:
    """What /info and /data need: the public parameter list and where each value comes from."""
    parameters: List[Dict[str, Any]]  # Time first
    # HAPI parameter name -> (fetch key, None for the values or the index of the axis holding them)
    sources: Dict[str, Tuple[str, Optional[int]]]
    sample_start: str
    sample_stop: str
    cadence: Optional[str] = None  # nominal time step, ISO 8601 duration


    def to_dict(self) -> dict:
        return {"parameters": self.parameters, "sources": {k: list(v) for k, v in self.sources.items()},
                "sample_start": self.sample_start, "sample_stop": self.sample_stop, "cadence": self.cadence}

    @staticmethod
    def from_dict(d: dict) -> "DatasetInfo":
        return DatasetInfo(parameters=d["parameters"], sources={k: tuple(v) for k, v in d["sources"].items()},
                           sample_start=d["sample_start"], sample_stop=d["sample_stop"], cadence=d.get("cadence"))


def hapi_type(dtype: np.dtype) -> Optional[str]:
    if dtype in _HAPI_INTEGER_DTYPES:
        return "integer"
    if np.issubdtype(dtype, np.integer) or np.issubdtype(dtype, np.floating):
        return "double"
    return None


def encode_fill(fill: Any, type_: str, dtype: np.dtype = np.dtype(np.float64)) -> Optional[str]:
    """HAPI spells fill as one value in a string; ISTP FILLVALs often come as a one-element array.

    A float32 fill is spelled as float32 prints ("-1e+30", not its float64 widening
    "-1.0000000150474662e+30"), the way CSV prints the float32 values it must match."""
    if isinstance(fill, (list, tuple, np.ndarray)):
        fill = np.ravel(fill)
        if len(fill) != 1:
            return None
        fill = fill[0]
    if fill is None:
        return None
    try:
        fill = float(fill)
    except (TypeError, ValueError):
        return None
    if math.isnan(fill):
        return "NaN" if type_ == "double" else None
    if type_ == "integer":
        return str(int(fill)) if fill.is_integer() and _INT32.min <= fill <= _INT32.max else None
    if dtype == np.float32:
        return repr(float(str(np.float32(fill))))
    return repr(fill)


def _units(units) -> Optional[str]:
    """HAPI's units are a non-empty string or null (dimensionless); CDAWeb often stores a blank."""
    units = str(units).strip() if units is not None else ""
    return units or None


def _finite_list(values: np.ndarray) -> list:
    return [float(v) if math.isfinite(v) else None for v in np.asarray(values, dtype=np.float64).ravel()]


def _labels(var: SpeasyVariable, size: List[int]):
    columns = var.columns
    if len(size) == 1 and columns and len(columns) == size[0]:
        return [c.decode() if isinstance(c, bytes) else str(c) for c in columns]
    return None


class _Describer:
    """Turns sample variables into HAPI parameters, adding one for each time-varying bins axis."""

    def __init__(self, value_names):
        self.parameters: List[Dict[str, Any]] = []
        self.sources: Dict[str, Tuple[str, Optional[int]]] = {}
        # Centers parameters must not take the name of a value parameter, even one described later.
        self._value_names = set(value_names)

    def add(self, meta: Dict[str, Any], path: str, axis: Optional[int]):
        self.parameters.append(meta)
        self.sources[meta["name"]] = (path, axis)

    def _bins(self, name: str, path: str, var: SpeasyVariable, size: List[int]) -> Optional[list]:
        axes = var.axes[1:]
        if len(axes) != len(size):
            return None
        bins = []
        for dim, axis in enumerate(axes):
            values = np.asarray(axis.values)
            if hapi_type(values.dtype) is None:  # e.g. a component label axis
                return None
            entry = {"name": axis.name or f"{name}_bins{dim}", "units": _units(axis.unit)}
            if not axis.is_time_dependent and values.shape == (size[dim],):
                entry["centers"] = _finite_list(values)
            elif axis.is_time_dependent and values.shape[1:] == (size[dim],):
                entry["centers"] = self._centers_parameter(name, path, axis, dim + 1)
            else:
                return None
            bins.append(entry)
        return bins

    def _centers_parameter(self, name: str, path: str, axis, axis_index: int) -> str:
        # Parameters sharing an axis (e.g. CDA's DEPEND_1 energy table) share its centers parameter.
        centers_name = axis.name or f"{name}__bins{axis_index}"
        if centers_name in self._value_names:
            centers_name = f"{name}__{centers_name}"
        if centers_name not in self.sources:
            type_ = hapi_type(np.asarray(axis.values).dtype)
            self.add({"name": centers_name, "type": type_, "units": _units(axis.unit), "fill": None,
                       "size": [int(axis.values.shape[1])], "description": f"Bin centers of {name}"},
                      path, axis_index)
        return centers_name

    def describe(self, name: str, path: str, var: SpeasyVariable, description: Optional[str]):
        values = np.asarray(var.values)
        type_ = hapi_type(values.dtype)
        if type_ is None:
            log.info(f"HAPI: leaving out {path}, its {values.dtype} values have no HAPI type")
            return
        size = [int(s) for s in values.shape[1:]]
        if size == [1]:
            size = []
        meta: Dict[str, Any] = {"name": name, "type": type_, "units": _units(var.unit),
                                "fill": encode_fill(var.fill_value, type_, values.dtype),
                                # AMDA's CATDESC is the parameter name: the inventory's description first
                                "description": description or var.meta.get("CATDESC") or ""}
        if size:
            meta["size"] = size
            if (labels := _labels(var, size)) is not None:
                meta["label"] = labels
        # Added before its bins so that its centers parameters (if any) follow it.
        self.add(meta, path, None)
        if size and (bins := self._bins(name, path, var, size)) is not None:
            meta["bins"] = bins


def _utc(hapi_time: str) -> datetime:
    """Catalog dates are HAPI times ending in Z, which fromisoformat only reads from Python 3.11."""
    return datetime.fromisoformat(hapi_time.replace("Z", "+00:00"))


def _sample_windows(dataset: HapiDataset, now: datetime):
    start = _utc(dataset.start_date)
    stop = min(_utc(dataset.stop_date), now)
    for anchor_at_stop in (True, False):
        for w in SAMPLE_WINDOWS:
            w = min(w, stop - start)
            if w <= timedelta(0):
                return
            yield (stop - w, stop) if anchor_at_stop else (start, start + w)


def _fetch_all(fetch: Fetch, keys: List[str], start: datetime, stop: datetime):
    def one(key):
        path, options = split_fetch_key(key)
        try:
            return key, fetch(path, start, stop, **options), None
        except Exception as e:  # upstream failure: that parameter just has no sample in this window
            return key, None, e

    with ThreadPoolExecutor(max_workers=min(4, len(keys))) as pool:
        return list(pool.map(one, keys))


def _sample(dataset: HapiDataset, fetch: Fetch, now: datetime, deadline: float):
    """{fetch key: sample variable} and the window the first sample came from.

    Empty windows cost as much as full ones (CSA: ~20 s each), so a single parameter probes for a
    window holding data first; the others are then fetched there, and further out only if missing."""
    windows = list(_sample_windows(dataset, now))
    paths = [s.key for s in dataset.parameters if s.like is None]
    samples: Dict[str, SpeasyVariable] = {}
    errors = []

    def collect(results):
        for path, var, error in results:
            if error is not None:
                errors.append(error)
            elif var is not None and len(var) > 0:
                samples[path] = var

    found = None
    for i, (start, stop) in enumerate(windows):
        if time.monotonic() > deadline:
            break
        collect(_fetch_all(fetch, paths[:1], start, stop))
        if samples:
            found = i
            break
    if found is not None:
        for start, stop in windows[found:]:
            missing = [p for p in paths if p not in samples]
            if not missing or time.monotonic() > deadline:
                break
            collect(_fetch_all(fetch, missing, start, stop))

    if not samples:
        if errors:
            raise HapiError(1501, f"no sample of {dataset.id} could be fetched: {errors[-1]}")
        raise HapiError(1500, f"found no data to describe {dataset.id}")
    missing = [p for p in paths if p not in samples]
    if missing:
        log.warning(f"HAPI: leaving out {missing} from {dataset.id}, no data found to describe them")
    return samples, windows[found]


def nominal_cadence(time: np.ndarray) -> Optional[str]:
    """Median time step as an ISO 8601 duration ('PT4S', 'PT0.25S'), None under two samples."""
    if len(time) < 2:
        return None
    step = np.median(np.diff(time.astype("datetime64[ns]").view(np.int64))) / 1e9
    return f"PT{step:.9g}S" if step > 0 else None


# Clients (and the verifier) want a sample range spanning more than 10 time steps.
_MIN_SAMPLE_STEPS = 20


def _widen_sample_window(dataset: HapiDataset, window, cadence: Optional[str]):
    """Stretches the sampled window to _MIN_SAMPLE_STEPS steps, within the dataset's dates. The window
    is known to hold data, and so does any range containing it."""
    start, stop = window
    if cadence is None:
        return window
    needed = timedelta(seconds=float(cadence[2:-1]) * _MIN_SAMPLE_STEPS)
    first = _utc(dataset.start_date)
    last = _utc(dataset.stop_date)
    if stop - start >= needed:
        return window
    start = max(first, stop - needed)
    stop = min(last, start + needed)
    return start, stop


def _add_copies(describer: _Describer, dataset: HapiDataset):
    """Parameters described as another one (trajectory frames), plus each one's coordinate frame."""
    described = {p["name"]: p for p in describer.parameters}
    for source in dataset.parameters:
        if source.like is not None and source.like in described:
            meta = copy.deepcopy(described[source.like])
            meta["name"] = source.name
            meta["description"] = source.description or meta["description"]
            describer.add(meta, source.key, None)
            described[source.name] = meta
        meta = described.get(source.name)
        if meta is not None and source.coordinate_system:
            meta["coordinateSystemName"] = source.coordinate_system
            if meta.get("size") == [3]:
                meta["vectorComponents"] = ["x", "y", "z"]


def build_info(dataset: HapiDataset, fetch: Fetch, now: Optional[datetime] = None,
               time_budget: timedelta = timedelta(minutes=2)) -> DatasetInfo:
    """Blocking: fetches samples through `fetch`. Raises HapiError when no parameter has data.
    No new window is started once `time_budget` is spent (a fetch in flight still completes)."""
    samples, sample_window = _sample(dataset, fetch, now or datetime.now(UTC),
                                     time.monotonic() + time_budget.total_seconds())

    describer = _Describer(s.name for s in dataset.parameters)
    for source in dataset.parameters:
        if source.like is None and source.key in samples:
            describer.describe(source.name, source.key, samples[source.key], source.description)
    _add_copies(describer, dataset)
    if not describer.parameters:
        raise HapiError(1500, f"no parameter of {dataset.id} has a HAPI type")

    unit = max((time_unit(v.time) for v in samples.values()), key=["ms", "us", "ns"].index)
    time_param = {"name": "Time", "type": "isotime", "units": "UTC", "length": time_length(unit), "fill": None}
    cadence = nominal_cadence(max((v.time for v in samples.values()), key=len))
    sample_window = _widen_sample_window(dataset, sample_window, cadence)
    return DatasetInfo(parameters=[time_param] + describer.parameters, sources=describer.sources,
                       sample_start=to_hapi_time(sample_window[0]), sample_stop=to_hapi_time(sample_window[1]),
                       cadence=cadence)
