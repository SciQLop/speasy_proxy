"""Background cache hygiene: once a week, walks every cache entry and drops
the ones that no longer deserialize into a SpeasyVariable, or carry a bare
``datetime`` version -- the marker left by speasy versions before 1.7.0 (see
upstream PR #356). Proactively surfaces the same self-heal that already
happens reactively on a live request, without needing to reconstruct an
entry's original product/time-range to actively refetch it.

At millions of entries this is a genuinely long-running sweep -- it runs as
one background threadpool call so it never blocks the event loop, and logs
progress per batch since a single run can take a while.

Known gap: this only catches entries that fail to deserialize or carry a
fossil version marker. An entry that deserializes fine but holds stale
content under a version string that still matches today's (e.g. an old
fewer-column payload) is not detected -- that needs speasy's own
is_up_to_date() to validate content, not just version identity.
"""
import asyncio
import logging

from datetime import datetime

from starlette.concurrency import run_in_threadpool

from speasy.core import cache
from speasy.products.variable import from_dictionary

log = logging.getLogger(__name__)


def is_fossil_entry(item) -> bool:
    if isinstance(item.version, datetime):
        return True
    try:
        from_dictionary(item.data)
    except Exception:
        return True
    return False


def scrub_all(batch_size: int) -> int:
    """Walk every cache entry once, dropping fossils. Returns how many were dropped."""
    keys = cache.entries()
    dropped = 0
    for i in range(0, len(keys), batch_size):
        for key in keys[i:i + batch_size]:
            item = cache.get_item(key)
            if item is not None and is_fossil_entry(item):
                cache.drop_item(key)
                dropped += 1
        log.debug(f"Cache scrub: {min(i + batch_size, len(keys))}/{len(keys)} keys checked, "
                  f"{dropped} dropped so far.")
    return dropped


async def periodic_scrub_loop(interval_seconds: int, batch_size: int):
    """Background task: once per interval (default weekly), sweep the whole
    cache. Never lets an error break the loop."""
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            dropped = await run_in_threadpool(scrub_all, batch_size)
            log.info(f"Cache scrub: swept the cache, dropped {dropped} fossil entries.")
        except Exception:
            log.exception("Cache scrub failed.")
