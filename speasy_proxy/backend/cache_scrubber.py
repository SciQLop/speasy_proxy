"""Background cache hygiene: once a week, walks every cache entry and drops
the ones that no longer deserialize into a SpeasyVariable, carry a bare
``datetime`` version -- the marker left by speasy versions before 1.7.0 (see
upstream PR #356) -- or (AMDA only) predate speasy's switch to CDF_ISTP.
Proactively surfaces the same self-heal that already happens reactively on a
live request, without needing to reconstruct an entry's original
product/time-range to actively refetch it.

At millions of entries this is a genuinely long-running sweep -- it runs as
one background threadpool call so it never blocks the event loop, and logs
progress per batch since a single run can take a while.

AMDA-specific gap this closes: AMDA's cache version is the *dataset's*
lastModificationDate (speasy's product_version()), not speasy's own decoder
version. A dataset AMDA hasn't touched in years (e.g. an old planetary
mission's archived data) keeps the same version key forever, even though
speasy switched AMDA's default request format from ASCII to CDF_ISTP on
2023-10-20 (commit 73d3bbd) -- a fragment cached under the old format can sit
there, version-valid but wrong-shaped, indefinitely. Confirmed live:
amda/mex_els_spec_0 cached with a handful of columns instead of the real
128-energy-bin spectrogram, crashing on merge with a freshly-fetched fragment.
The cutoff date is configurable (config.core.amda_cache_stale_before /
SPEASY_PROXY_CORE_AMDA_CACHE_STALE_BEFORE) in case a future format switch
needs the same treatment, or 2023-10-20 turns out wrong for some products.

Known gap for every other provider: an entry that deserializes fine and holds
a version string that still matches today's, but wraps stale/wrong-shaped
content for a reason other than the AMDA format switch above, is not
detected -- that needs speasy's own is_up_to_date() to validate content, not
just version identity.
"""
import asyncio
import logging

from datetime import datetime

from starlette.concurrency import run_in_threadpool

from speasy.core import cache
from speasy.products.variable import from_dictionary

from ..config import core as config

log = logging.getLogger(__name__)


def is_fossil_entry(item) -> bool:
    # cache.entries() walks every key ever written, including some pre-CacheItem
    # legacy format that can still be sitting in a years-old production cache (seen
    # live: a bare str with no .version/.data at all) -- treat anything that
    # doesn't even look like a CacheItem as a fossil too, not just a bad payload.
    try:
        if isinstance(item.version, datetime):
            return True
        from_dictionary(item.data)
    except Exception:
        return True
    return False


def is_stale_amda_entry(key: str, item, cutoff: datetime) -> bool:
    if not key.startswith("amda/"):
        return False
    try:
        return item.created < cutoff
    except Exception:
        return False


def scrub_all(batch_size: int) -> int:
    """Walk every cache entry once, dropping fossils and stale AMDA entries.
    Returns how many were dropped."""
    amda_cutoff = config.amda_cache_stale_before.get()
    keys = cache.entries()
    dropped = 0
    for i in range(0, len(keys), batch_size):
        for key in keys[i:i + batch_size]:
            item = cache.get_item(key)
            if item is not None and (is_fossil_entry(item) or is_stale_amda_entry(key, item, amda_cutoff)):
                cache.drop_item(key)
                dropped += 1
        log.debug(f"Cache scrub: {min(i + batch_size, len(keys))}/{len(keys)} keys checked, "
                  f"{dropped} dropped so far.")
    return dropped


async def _scrub_tick(batch_size: int):
    try:
        dropped = await run_in_threadpool(scrub_all, batch_size)
        log.info(f"Cache scrub: swept the cache, dropped {dropped} fossil entries.")
    except Exception:
        log.exception("Cache scrub failed.")


async def periodic_scrub_loop(interval_seconds: int, batch_size: int):
    """Background task: sweeps the whole cache once immediately on startup, then
    once per interval after (default weekly). Immediate-on-startup matters: a
    scrubber-only fix (e.g. is_stale_amda_entry) must take effect on deploy, not
    sit inert for up to a week waiting for the first interval to elapse. Never
    lets an error break the loop."""
    await _scrub_tick(batch_size)
    while True:
        await asyncio.sleep(interval_seconds)
        await _scrub_tick(batch_size)
