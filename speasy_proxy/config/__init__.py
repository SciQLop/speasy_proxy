from datetime import timezone
from dateutil import parser as _date_parser

from speasy.config import ConfigSection, inventories


def _parse_utc_date(value: str):
    dt = _date_parser.parse(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _parse_bool(value: str) -> bool:
    return value.lower() == "true"


index = ConfigSection("PROXY_INDEX", path={"default": "/tmp"})
collab_endpoint = ConfigSection("PROXY_COLLAB_ENDPOINT", enable={"default": False, "type_ctor": _parse_bool})
hapi = ConfigSection("PROXY_HAPI",
                     only={"default": False, "type_ctor": _parse_bool,
                           "description": "Serve the HAPI server (/hapi) alone: no web pages, no speasy /get_data API."},
                     server_id={"default": "speasy-proxy", "description": "HAPI /about id."},
                     title={"default": "speasy-proxy", "description": "HAPI /about title, also the landing page title."},
                     contact={"default": "https://github.com/SciQLop/speasy_proxy/issues",
                              "description": "HAPI /about contact."},
                     )
sciqlopplots = ConfigSection("PROXY_SCIQLOPPLOTS",
                             path={"default": "",
                                   "description": "Directory of the SciQLopPlots browser library (sciqlopplots.mjs, sciqlopplots.js, sciqlopplots.wasm, qtloader.js). When set, /plot?backend=sciqlopplots draws with it instead of uPlot."},
                             )
core = ConfigSection("PROXY_CORE",
                     inventory_update_interval={"default": 60 * 60 * 2, "type_ctor": int, "description": "Interval in seconds to update the inventory."},
                     inventory_sync_poll_interval={"default": 60, "type_ctor": int, "description": "Seconds between shared-store inventory syncs in each worker."},
                     inventory_retry_backoff={"default": 300, "type_ctor": int, "description": "Seconds to wait before retrying a failed inventory refresh."},
                     inventory_lease_ttl={"default": 600, "type_ctor": int, "description": "TTL (seconds) of the cross-worker inventory refresh lease."},
                     inventory_shared_path={"default": "", "description": "Directory for the cross-worker shared inventory store (default: <index path>/inventory_shared)."},
                     max_query_span_days={"default": 366 * 50, "type_ctor": int, "description": "Maximum start_time/stop_time span (days) accepted by /get_data, to bound worst-case fetch/resample time in the threadpool."},
                     cache_scrub_interval={"default": 7 * 24 * 60 * 60, "type_ctor": int, "description": "Seconds between full background cache scrubs (every cache entry is checked, fossils dropped)."},
                     cache_scrub_state_path={"default": "", "description": "Directory of the cross-worker scrub schedule/lease store (default: <speasy index path>/speasy_proxy_scrub). Must survive container recreation, unlike the proxy's own /tmp index."},
                     cache_scrub_batch_size={"default": 500, "type_ctor": int, "description": "Cache entries checked per progress-log batch during a scrub."},
                     amda_cache_stale_before={"default": "2023-10-20", "type_ctor": _parse_utc_date,
                                              "description": "AMDA cache entries created before this date are dropped by the scrubber. speasy defaulted AMDA requests to ASCII (not CDF_ISTP) before 2023-10-20, so older entries may hold a different, incompatible shape than today's decoder produces."},
                     )