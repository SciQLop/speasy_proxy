from datetime import timezone
from dateutil import parser as _date_parser

from speasy.config import ConfigSection, inventories


def _parse_utc_date(value: str):
    dt = _date_parser.parse(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


index = ConfigSection("PROXY_INDEX", path={"default": "/tmp"})
collab_endpoint = ConfigSection("PROXY_COLLAB_ENDPOINT",
                                enable={"default": False,
                                        "type_ctor": lambda x: {'true': True,
                                                                'false': False}.get(x.lower(), False)})
core = ConfigSection("PROXY_CORE",
                     inventory_update_interval={"default": 60 * 60 * 2, "type_ctor": int, "description": "Interval in seconds to update the inventory."},
                     inventory_sync_poll_interval={"default": 60, "type_ctor": int, "description": "Seconds between shared-store inventory syncs in each worker."},
                     inventory_retry_backoff={"default": 300, "type_ctor": int, "description": "Seconds to wait before retrying a failed inventory refresh."},
                     inventory_lease_ttl={"default": 600, "type_ctor": int, "description": "TTL (seconds) of the cross-worker inventory refresh lease."},
                     inventory_shared_path={"default": "", "description": "Directory for the cross-worker shared inventory store (default: <index path>/inventory_shared)."},
                     max_query_span_days={"default": 366 * 50, "type_ctor": int, "description": "Maximum start_time/stop_time span (days) accepted by /get_data, to bound worst-case fetch/resample time in the threadpool."},
                     cache_scrub_interval={"default": 7 * 24 * 60 * 60, "type_ctor": int, "description": "Seconds between full background cache scrubs (every cache entry is checked, fossils dropped)."},
                     cache_scrub_batch_size={"default": 500, "type_ctor": int, "description": "Cache entries checked per progress-log batch during a scrub."},
                     amda_cache_stale_before={"default": "2023-10-20", "type_ctor": _parse_utc_date,
                                              "description": "AMDA cache entries created before this date are dropped by the scrubber. speasy defaulted AMDA requests to ASCII (not CDF_ISTP) before 2023-10-20, so older entries may hold a different, incompatible shape than today's decoder produces."},
                     )