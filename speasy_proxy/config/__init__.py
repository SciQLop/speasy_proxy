from speasy.config import ConfigSection, inventories

index = ConfigSection("PROXY_INDEX", path={"default": "/tmp"})
collab_endpoint = ConfigSection("PROXY_COLLAB_ENDPOINT",
                                enable={"default": False,
                                        "type_ctor": lambda x: {'true': True,
                                                                'false': False}.get(x.lower(), False)})
core = ConfigSection("PROXY_CORE",
                     inventory_update_interval={"default": 60 * 60 * 2, "type_ctor": int, "description": "Interval in seconds to update the inventory."},
                     )