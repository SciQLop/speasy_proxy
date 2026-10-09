"""HAPI's restricted ISO 8601: YYYY-MM-DD or YYYY-DDD, optionally followed by Thh[:mm[:ss[.f…]]], or
YYYY-MM alone; then an optional Z."""
import re
from datetime import datetime, timedelta, UTC

import numpy as np
from dateutil import parser as _date_parser

_HAPI_TIME = re.compile(
    r"^(?P<year>\d{4})-(?:(?P<month>\d{2})-(?P<day>\d{2})|(?P<doy>\d{3}))"
    r"(?:T(?P<hour>\d{2})(?::?(?P<minute>\d{2})(?::?(?P<second>\d{2})(?:\.(?P<frac>\d{1,9}))?)?)?)?Z?$")
_HAPI_MONTH = re.compile(r"^(?P<year>\d{4})-(?P<month>\d{2})Z?$")

# "1970-01-01T00:00:00" + "." + fractional digits + "Z"
_UNIT_LENGTHS = {"ms": 24, "us": 27, "ns": 30}


def parse_hapi_time(value: str) -> datetime:
    """Raises ValueError when `value` is not a HAPI time."""
    if month := _HAPI_MONTH.match(value.strip()):
        return datetime(int(month["year"]), int(month["month"]), 1, tzinfo=UTC)
    m = _HAPI_TIME.match(value.strip())
    if m is None:
        raise ValueError(f"{value!r} is not a HAPI ISO 8601 time")
    year = int(m["year"])
    if m["doy"] is not None:
        doy = int(m["doy"])
        if not 1 <= doy <= (366 if _is_leap(year) else 365):
            raise ValueError(f"{value!r}: day of year out of range")
        date = datetime(year, 1, 1, tzinfo=UTC) + timedelta(days=doy - 1)
    else:
        date = datetime(year, int(m["month"]), int(m["day"]), tzinfo=UTC)
    frac = m["frac"] or ""
    # datetime holds microseconds: digits beyond that are dropped.
    micro = int(frac[:6].ljust(6, "0")) if frac else 0
    hour, minute, second = (int(m[k] or 0) for k in ("hour", "minute", "second"))
    if hour == 24 and minute == second == micro == 0:
        return date + timedelta(days=1)
    if second == 60:  # a leap second: datetime has none, the last instant of the minute stands for it
        second, micro = 59, 999_999
    return date.replace(hour=hour, minute=minute, second=second, microsecond=micro)


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def to_hapi_time(value) -> str:
    """Inventory dates come in assorted spellings ('1997-08-25 17:48:00', '...Z', '...+00:00')."""
    dt = value if isinstance(value, datetime) else _date_parser.parse(str(value))
    dt = dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def time_unit(values: np.ndarray) -> str:
    """Coarsest of ms/us/ns that still represents every timestamp exactly (ms when empty)."""
    ns = values.astype("datetime64[ns]").view(np.int64)
    for unit, step in (("ms", 1_000_000), ("us", 1_000)):
        if not np.any(ns % step):
            return unit
    return "ns"


def time_length(unit: str) -> int:
    return _UNIT_LENGTHS[unit]


def format_times(values: np.ndarray, length: int) -> np.ndarray:
    """ISO 8601 strings of exactly `length` characters, the length /info declares for Time."""
    unit = next(u for u, n in _UNIT_LENGTHS.items() if n == length)
    return np.char.add(np.datetime_as_string(values.astype(f"datetime64[{unit}]"), unit=unit), "Z")
