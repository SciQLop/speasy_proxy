"""One-shot cleanup of empty provider-data cache entries poisoned by the
2026-09 cache incident.

Background: speasy (pre-1.8.1) cached empty fragments -- both zero-row and
AMDA's all-NaN "pad" rows -- as permanent entries. An over-wide or
open-ended request enumerated fragments past a product's real coverage and
cached the empty tail; fragments queried during upstream backfill latency
were cached empty and never refreshed. Both then serve empty from the shared
cache forever. The poison writing began around 2025-12 (verified from entry
`created` timestamps), so any *empty* fragment dated on or after that is
suspect: either a future-dated fossil, or a recent date that upstream has
since filled. Empty fragments dated well before the poison era are genuine
historical data gaps and are left alone (dropping them only forces endless
refetch of a known-empty range).

Rule: drop an entry when it is empty (zero rows, or all values non-finite)
AND its fragment starts on or after the poison-era floor (default
2025-11-01). Value-based emptiness so AMDA's NaN pads are caught, not just
zero-row entries.

Run ONCE. It is deliberately NOT wired into the background scrubber; the
durable fix is speasy's read-side self-heal (per-entry cache epoch). Dry-run
by default:

    python -m speasy_proxy.backend.oneshot_scrub_empty                 # report only
    python -m speasy_proxy.backend.oneshot_scrub_empty --apply         # actually drop
    python -m speasy_proxy.backend.oneshot_scrub_empty --since 2025-01-01 --apply
    python -m speasy_proxy.backend.oneshot_scrub_empty --provider amda --apply
"""
import argparse
import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from .cache_scrubber import PROVIDER_DATA_KEY_PREFIXES

log = logging.getLogger(__name__)

POISON_ERA_FLOOR = datetime(2025, 11, 1, tzinfo=timezone.utc)
_EMPTY_SCAN_ROW_LIMIT = 64  # AMDA pads gaps with ~2 NaN rows; real data has many finite rows


def fragment_datetime(key: str) -> Optional[datetime]:
    """Parse the fragment start time (last path segment) as a UTC datetime, or
    None if it does not look like an ISO timestamp."""
    tail = key.rsplit("/", 1)[-1]
    try:
        dt = datetime.fromisoformat(tail)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def is_empty(data) -> bool:
    """True when the payload holds no usable data: zero rows, or all values
    non-finite (NaN/inf). Value-based so AMDA's all-NaN pads count as empty,
    while finite future ephemeris (a real prediction) does not."""
    try:
        n_rows = len(data["axes"][0]["values"])
        values = data["values"]["values"]
    except (KeyError, IndexError, TypeError):
        return False  # not a SpeasyVariable dict (e.g. CacheCall) -> never drop
    if n_rows == 0:
        return True
    if n_rows > _EMPTY_SCAN_ROW_LIMIT:
        return False  # large -> real data, skip the scan
    try:
        if not np.issubdtype(values.dtype, np.floating):
            return False
        return not np.isfinite(values).any()
    except (TypeError, AttributeError):
        return False


def should_drop(fragment_dt: Optional[datetime], item, floor: datetime) -> bool:
    if fragment_dt is None or fragment_dt < floor:
        return False
    return item is not None and is_empty(getattr(item, "data", None))


def scrub_empty(floor: datetime = POISON_ERA_FLOOR, apply: bool = False,
                providers: Optional[tuple] = None) -> Counter:
    """Walk the cache once; drop (or, dry-run, count) empty provider-data
    entries dated on/after `floor`. Returns a Counter keyed by provider prefix
    plus ``_scanned`` and ``_candidates``."""
    from speasy.core import cache

    prefixes = providers or PROVIDER_DATA_KEY_PREFIXES
    stats: Counter = Counter()
    keys = [k for k in cache.entries() if k.startswith(prefixes)]
    stats["_scanned"] = len(keys)
    for key in keys:
        fdt = fragment_datetime(key)
        if fdt is None or fdt < floor:
            continue  # cheap prefilter: skip pre-era / unparseable without a read
        stats["_candidates"] += 1
        item = cache.get_item(key)
        if not should_drop(fdt, item, floor):
            continue
        stats[key.split("/", 1)[0]] += 1
        if apply:
            cache.drop_item(key)
    return stats


def _report(stats: Counter, apply: bool):
    verb = "Dropped" if apply else "Would drop"
    per = {k: v for k, v in stats.items() if not k.startswith("_")}
    total = sum(per.values())
    log.info("Scanned %d provider-data keys, %d dated on/after the floor.",
             stats["_scanned"], stats["_candidates"])
    for provider, n in sorted(per.items()):
        log.info("  %s %d empty entries under %s/", verb.lower(), n, provider)
    log.info("%s %d empty entries total%s.", verb, total,
             "" if apply else " (dry-run; pass --apply to remove)")


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apply", action="store_true",
                   help="actually drop entries (default: dry-run report only)")
    p.add_argument("--since", default=POISON_ERA_FLOOR.date().isoformat(),
                   help=f"floor date (YYYY-MM-DD); drop empties dated on/after it "
                        f"(default {POISON_ERA_FLOOR.date().isoformat()})")
    p.add_argument("--provider", action="append", default=None,
                   help="limit to this key prefix (repeatable), e.g. amda/")
    args = p.parse_args(argv)

    floor = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
    providers = tuple(pv if pv.endswith("/") else pv + "/"
                      for pv in args.provider) if args.provider else None
    stats = scrub_empty(floor=floor, apply=args.apply, providers=providers)
    _report(stats, args.apply)


if __name__ == "__main__":
    main()
