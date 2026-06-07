from speasy.config import ConfigSection, inventories

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
                     )