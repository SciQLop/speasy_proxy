from speasy.config import ConfigSection

index = ConfigSection("PROXY_INDEX", path={"default": "/tmp"})
collab_endpoint = ConfigSection("PROXY_COLLAB_ENDPOINT",
                                enable={"default": False,
                                        "type_ctor": lambda x: {'true': True,
                                                                'false': False}.get(x.lower(), False)})
