from pydantic import BaseModel


class ServerStatus(BaseModel):
    entries: int
    cache_disk_size: int
    up_since: str
    up_duration: float
    last_inventory_update: str
    inventory_size: str
    docs: str
    speasy_version: str
    version: str
    inventory_update_interval: str


class ProviderStatus(BaseModel):
    provider: str
    is_up: bool
    error: str | None = None
