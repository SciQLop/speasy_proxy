"""Writes /data responses that match /info exactly: same parameters, shapes, types and time length.

Values are taken as fetched and only reshaped/cast to what /info declared; anything that doesn't
fit (other shape, other time axis) is an error rather than a response a client would choke on.
"""
import io
import json
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from speasy.products.variable import SpeasyVariable

from .status import HapiError
from .times import format_times


def _trim(var: Optional[SpeasyVariable], start: datetime, stop: datetime) -> Optional[SpeasyVariable]:
    """HAPI ranges are [start, stop)."""
    if var is None:
        return None
    time = var.time
    lo, hi = np.searchsorted(time, [np.datetime64(start.replace(tzinfo=None), "ns"),
                                    np.datetime64(stop.replace(tzinfo=None), "ns")], side="left")
    return var[int(lo):int(hi)]


def _check_aligned(present: Dict[str, SpeasyVariable]):
    """Parameters of one dataset may cover different parts of a range (one instrument stops, a flag
    is only recorded sometimes), but where they overlap they must share timestamps: overlapping spans
    with no timestamp in common mean they were never on the same time axis. Checked against the
    longest parameter only, so the cost grows linearly with the number of parameters."""
    ref_path, ref = max(present.items(), key=lambda item: len(item[1]))
    for path, var in present.items():
        if path == ref_path:
            continue
        overlap = max(ref.time[0], var.time[0]) <= min(ref.time[-1], var.time[-1])
        if overlap and not np.isin(var.time, ref.time, assume_unique=True).any():
            raise HapiError(1500, f"the parameters don't share their time axis ({ref_path}, {path})")


def merge_time_axes(variables: Dict[str, Optional[SpeasyVariable]], start: datetime,
                    stop: datetime) -> Tuple[np.ndarray, Dict[str, Optional[SpeasyVariable]]]:
    """Trims every variable to [start, stop) and returns the dataset's time axis over it: the union of
    the parameters' timestamps. A parameter is written as fill where it has no record (see _column)."""
    trimmed = {path: _trim(var, start, stop) for path, var in variables.items()}
    present = {path: var for path, var in trimmed.items() if var is not None and len(var)}
    if not present:
        return np.array([], dtype="datetime64[ns]"), trimmed
    times = [var.time for var in present.values()]
    if all(np.array_equal(times[0], t) for t in times[1:]):  # the usual case: one shared time axis
        return times[0], trimmed
    _check_aligned(present)
    return np.unique(np.concatenate(times)), trimmed


def _fill_column(meta: Dict[str, Any], n: int, size: List[int], dtype) -> np.ndarray:
    """Cells of a parameter with no record at a timestamp of its dataset: its fill, or NaN."""
    fill = meta.get("fill")
    if meta["type"] == "integer":
        if fill is None:
            raise HapiError(1500, f"{meta['name']} misses records in this range and has no fill value for them")
        return np.full((n, *size), int(fill), dtype="<i4")
    # In the values' own float type: a float32 fill then prints, and widens in binary, like the data.
    return np.full((n, *size), np.nan if fill in (None, "NaN") else float(fill), dtype=dtype)


def _values(meta: Dict[str, Any], var: SpeasyVariable, axis: Optional[int], size: List[int]) -> np.ndarray:
    values = np.asarray(var.values if axis is None else var.axes[axis].values)
    if values.size != len(var) * int(np.prod(size, dtype=np.int64)):
        raise HapiError(1500, f"{meta['name']} has shape {values.shape[1:]} where /info declares {size or 'a scalar'}")
    values = values.reshape((len(var), *size))
    if meta["type"] == "integer":
        return values.astype("<i4")
    # float32 stays float32 so that CSV prints its shortest float32 repr, not float64 noise.
    return values if values.dtype in (np.float32, np.float64) else values.astype("<f8")


def _column(meta: Dict[str, Any], source: Tuple[str, Optional[int]], variables, time: np.ndarray) -> np.ndarray:
    path, axis = source
    var = variables[path]
    size = meta.get("size", [])
    if len(time) == 0:
        return np.empty((0, *size), dtype="<i4" if meta["type"] == "integer" else np.float64)
    if var is None or len(var) == 0:
        return _fill_column(meta, len(time), size, np.float64)
    values = _values(meta, var, axis, size)
    if len(var) == len(time):
        return values
    column = _fill_column(meta, len(time), size, values.dtype)
    column[np.searchsorted(time, var.time)] = values
    return column


def build_columns(parameters: List[Dict[str, Any]], sources: Dict[str, Tuple[str, Optional[int]]],
                  time: np.ndarray, variables) -> List[np.ndarray]:
    """One array per parameter (Time first, as strings of the declared length)."""
    columns = [format_times(time, parameters[0]["length"])]
    columns += [_column(meta, sources[meta["name"]], variables, time) for meta in parameters[1:]]
    return columns


def header_line(header: dict) -> bytes:
    return ("#" + json.dumps(header) + "\n").encode("utf-8")


def to_csv(columns: List[np.ndarray]) -> bytes:
    flat = {}
    for i, col in enumerate(columns):
        if col.ndim == 1:
            flat[f"{i}"] = col
        else:
            for j, sub in enumerate(col.reshape(len(col), int(np.prod(col.shape[1:]))).T):
                flat[f"{i}_{j}"] = sub
    buffer = io.StringIO()
    # pandas writes NaN as an empty field by default, which HAPI clients can't read as a double.
    pd.DataFrame(flat).to_csv(buffer, index=False, header=False, na_rep="NaN", lineterminator="\n")
    return buffer.getvalue().encode("utf-8")


def _widen(col: np.ndarray, fill: Optional[str]) -> np.ndarray:
    """float32 -> float64 for binary, keeping fill cells equal to the fill /info declares: a float32
    fill widens to -1.0000000150474662e+30, while /info spells it as float32 prints, -1e+30."""
    if col.dtype != np.float32:
        return col
    wide = col.astype(np.float64)
    if fill is not None and fill != "NaN":
        wide[col == np.float32(fill)] = float(fill)
    return wide


def to_binary(parameters: List[Dict[str, Any]], columns: List[np.ndarray]) -> bytes:
    fields = [("Time", f"S{parameters[0]['length']}")]
    for meta in parameters[1:]:
        base = "<i4" if meta["type"] == "integer" else "<f8"
        fields.append((meta["name"], (base, tuple(meta["size"])) if meta.get("size") else base))
    out = np.empty(len(columns[0]), dtype=np.dtype(fields))
    out["Time"] = columns[0]
    for meta, col in zip(parameters[1:], columns[1:]):
        out[meta["name"]] = _widen(col, meta.get("fill"))
    return out.tobytes()
