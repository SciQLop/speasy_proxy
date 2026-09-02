"""One-shot cleanup of empty provider-data cache entries poisoned by
over-wide / near-real-time requests.

Background (2026-09 incident): speasy caches every 12h fragment of a request,
empty slices included, as permanent version-stamped entries. A single request
whose range ran past a product's real coverage (e.g. imf queried 1928..2048
when data only exists 1997..now) permanently cached tens of thousands of empty
future fragments; and any fragment queried during upstream data-processing
latency got cached empty and never refreshed after backfill. Both serve empty
data forever from the shared cache.

This tool drops exactly those: an entry is removed when it is EMPTY and its
fragment starts at or after ``now - window``. That single rule covers both
failure modes -- every future-dated fragment (which can never hold data) and
the recent backfill-latency window -- while leaving all older real data and
genuine historical data gaps untouched. No product-coverage lookup or
per-provider key parsing is needed: emptiness plus the fragment date is
sufficient and robust across every provider.

Run ONCE after deploying the upstream speasy coverage-clamp + empty-TTL fix
(which stops the poison recurring). It is deliberately NOT wired into the
background scrubber. Dry-run by default:

    python -m speasy_proxy.backend.oneshot_scrub_empty                 # report only
    python -m speasy_proxy.backend.oneshot_scrub_empty --apply         # actually drop
    python -m speasy_proxy.backend.oneshot_scrub_empty --window-days 90 --apply
    python -m speasy_proxy.backend.oneshot_scrub_empty --provider amda --apply
"""
import argparse
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from .cache_scrubber import PROVIDER_DATA_KEY_PREFIXES

log = logging.getLogger(__name__)

DEFAULT_WINDOW = timedelta(days=60)


def fragment_datetime(key: str) -> Optional[datetime]:
    """Parse the fragment start time (the last path segment) of a cache key as
    a UTC datetime, or None if it does not look like an ISO timestamp."""
    tail = key.rsplit("/", 1)[-1]
    try:
        dt = datetime.fromisoformat(tail)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def should_drop(fragment_dt: Optional[datetime], now: datetime,
                is_empty: bool, window: timedelta) -> bool:
    """An entry is junk when it holds no data and its fragment is recent or in
    the future -- the only fragments that get poisoned by latency or an
    out-of-coverage request. Older empties are genuine historical gaps: keep
    them so we do not re-fetch known-empty ranges forever."""
    if fragment_dt is None or not is_empty:
        return False
    return fragment_dt >= now - window


def _is_empty(item) -> bool:
    from speasy.products.variable import from_dictionary
    try:
        var = from_dictionary(item.data)
    except Exception:
        return False  # cannot judge -> never drop
    return var is None or len(var) == 0


def scrub_empty(window: timedelta = DEFAULT_WINDOW, apply: bool = False,
                providers: Optional[tuple] = None) -> Counter:
    """Walk the cache once; drop (or, in dry-run, count) empty recent/future
    provider-data entries. Returns a Counter keyed by provider prefix plus
    ``_scanned`` and ``_recent_candidates``."""
    from speasy.core import cache

    prefixes = providers or PROVIDER_DATA_KEY_PREFIXES
    now = datetime.now(timezone.utc)
    cutoff = now - window
    stats: Counter = Counter()

    keys = [k for k in cache.entries() if k.startswith(prefixes)]
    stats["_scanned"] = len(keys)
    for key in keys:
        fdt = fragment_datetime(key)
        if fdt is None or fdt < cutoff:
            continue  # cheap prefilter: skip old/unparseable without a read
        stats["_recent_candidates"] += 1
        item = cache.get_item(key)
        if item is None or not should_drop(fdt, now, _is_empty(item), window):
            continue
        provider = key.split("/", 1)[0]
        stats[provider] += 1
        if apply:
            cache.drop_item(key)
    return stats


def _report(stats: Counter, apply: bool):
    verb = "Dropped" if apply else "Would drop"
    per = {k: v for k, v in stats.items() if not k.startswith("_")}
    total = sum(per.values())
    log.info("Scanned %d provider-data keys, %d recent/future candidates.",
             stats["_scanned"], stats["_recent_candidates"])
    for provider, n in sorted(per.items()):
        log.info("  %s %d empty entries under %s/", verb.lower(), n, provider)
    log.info("%s %d empty entries total%s.", verb, total,
             "" if apply else " (dry-run; pass --apply to remove)")


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apply", action="store_true",
                   help="actually drop entries (default: dry-run report only)")
    p.add_argument("--window-days", type=int, default=DEFAULT_WINDOW.days,
                   help=f"recent window in days (default {DEFAULT_WINDOW.days})")
    p.add_argument("--provider", action="append", default=None,
                   help="limit to this key prefix (repeatable), e.g. amda/")
    args = p.parse_args(argv)

    providers = tuple(pv if pv.endswith("/") else pv + "/"
                      for pv in args.provider) if args.provider else None
    stats = scrub_empty(window=timedelta(days=args.window_days),
                        apply=args.apply, providers=providers)
    _report(stats, args.apply)


if __name__ == "__main__":
    main()
