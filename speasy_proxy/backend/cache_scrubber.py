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
import os

from datetime import UTC, datetime, timedelta

from starlette.concurrency import run_in_threadpool

from speasy.config import index as speasy_index
from speasy.core import cache
from speasy.products.variable import from_dictionary

from ..config import core as config
from .shared_inventory_store import SharedInventoryStore

log = logging.getLogger(__name__)

SCRUB_LEASE = "cache_scrub/lease"
SCRUB_LEASE_TTL = 24 * 3600  # longer than any full sweep; frees the lease if its holder died mid-sweep

# Allowlist of provider data-cache key prefixes -- the @Cacheable /
# @UnversionedProviderCache prefixes in speasy.data_providers.* -- the only
# namespaces whose payloads are SpeasyVariable dictionaries this scrubber
# knows how to judge. Everything else sharing the cache is out of scope by
# construction rather than excluded case by case: CacheCall memoization
# entries (never SpeasyVariables, so they always look like fossils), speasy's
# own 'cache/version' marker (a bare str; dropping it makes the next startup
# wipe the whole cache), and any namespace a future speasy adds.
PROVIDER_DATA_KEY_PREFIXES = (
    "amda/",
    "cda/",
    "csa/",
    "ssc_orbits/",
    "cdpp3dview/",
    "UiowaEphTool_orbits/",
)


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
    keys = [k for k in cache.entries() if k.startswith(PROVIDER_DATA_KEY_PREFIXES)]
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


def scrub_state_path() -> str:
    """Where the sweep schedule lives: under speasy's own index path, a persistent volume in prod
    (/index/data), so the weekly clock survives redeploys. The proxy's own index defaults to /tmp,
    which is wiped with the container."""
    return config.cache_scrub_state_path.get() or os.path.join(speasy_index.path(), "speasy_proxy_scrub")


def _sweep(batch_size: int):
    try:
        dropped = scrub_all(batch_size)
        log.info(f"Cache scrub: swept the cache, dropped {dropped} fossil entries.")
    except Exception:
        log.exception("Cache scrub failed.")


def _scrub_due(store: SharedInventoryStore, interval: timedelta, now: datetime) -> bool:
    last = store.last_scrub()
    if last is None:
        # First check ever: start the clock instead of sweeping. A full sweep right away
        # floods the logs (2026-09-01 incident), see periodic_scrub_loop.
        store.set_last_scrub(now)
        return False
    return now - last >= interval


def scrub_if_due(store: SharedInventoryStore, interval: timedelta, batch_size: int, now: datetime) -> bool:
    """Sweep the cache if a full interval passed since the last sweep by ANY worker.
    Returns True when this call swept. Without a shared store there is no sweep at all:
    better no hygiene than every gunicorn worker walking the whole cache at once."""
    if not store.enabled or not _scrub_due(store, interval, now):
        return False
    if not store.try_acquire_lease(SCRUB_LEASE_TTL, key=SCRUB_LEASE):
        return False
    try:
        if not _scrub_due(store, interval, now):  # another worker swept between our check and the lease
            return False
        store.set_last_scrub(now)  # before sweeping: a sweep that crashes must not be retried every poll
        _sweep(batch_size)
        return True
    finally:
        store.release_lease(SCRUB_LEASE)


async def periodic_scrub_loop(interval_seconds: int, batch_size: int, store: SharedInventoryStore,
                              poll_seconds: int = 3600):
    """Background task, one per gunicorn worker: every poll_seconds, asks whether a sweep is due.
    The schedule and a lease live in the shared store, so across all workers -- and across
    worker recycling and restarts -- the whole cache is swept once per interval (default weekly).
    Never lets an error break the loop.

    Deliberately never sweeps on startup (reverted 2026-09-01, see incident memory):
    cache.entries() + cache.get_item() per key means a full sweep touches every one of
    the (multi-million) entries in a production cache in one burst. A meaningful fraction
    of a years-old cache is unreadable off disk for reasons unrelated to this scrubber
    (memory-mapped file open failures, ~300/day before this code ever ran); touching all of
    them at once floods the logs and looks like mass cache deletion."""
    interval = timedelta(seconds=interval_seconds)
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            await run_in_threadpool(scrub_if_due, store, interval, batch_size, datetime.now(UTC))
        except Exception:
            log.exception("Cache scrub check failed.")
