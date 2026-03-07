# FastAPI Modernization Design

Refactor speasy-proxy to follow idiomatic FastAPI patterns, use Pydantic where it adds value, and improve performance — without breaking the Speasy client interface.

## Constraint

All URL paths, query parameter names, and response formats (pickle, zstd, JSON, CDF, HTML) must remain wire-compatible with existing Speasy clients. No changes to Speasy should be required.

## Approach: Bottom-Up Modernization (3 Phases)

Each phase is an independent, mergeable PR.

---

## Phase 1: Core Patterns & Cleanup

### 1a. Query parameters — `Annotated` types

Replace module-level `Query()` objects in `query_parameters.py` with `Annotated` type aliases:

```python
# Before
QueryZstd = Query(default=False, example=False)

# After
ZstdCompression = Annotated[bool, Query(default=False, example=False)]
```

Endpoints change from `zstd_compression: bool = QueryZstd` to `zstd_compression: ZstdCompression`.

Apply to all query parameters: `QueryProvider`, `QueryZstd`, `QueryFormat`, `QueryPickleProto`, `QueryDataFormat`.

### 1b. Pydantic response models for JSON endpoints

Add Pydantic `BaseModel` subclasses for `get_server_status` and `is_up` — the two endpoints returning structured JSON:

```python
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
```

Binary/pickle/HTML endpoints (`get_data`, `get_inventory`, `get_cache_entries`) keep manual `Response()` construction since Pydantic doesn't apply to those formats.

### 1c. Deduplicate `compress_if_asked`

Move the duplicated function from `get_data.py` and `get_inventory.py` into `api/compression.py`:

```python
# api/compression.py
import pyzstd

def compress_if_asked(data: bytes | str, mime: str, zstd_compression: bool = False):
    if zstd_compression:
        if isinstance(data, str):
            data = data.encode()
        return pyzstd.compress(data), "application/x-zstd-compressed"
    return data, mime
```

### 1d. Fix deprecations

- `get_data.py`: Replace `datetime.utcfromtimestamp(ts)` with `datetime.fromtimestamp(ts, tz=UTC)`
- Clean up unused `Request` import in `api/pickle.py`

### Files touched

`query_parameters.py`, `get_data.py`, `get_inventory.py`, `get_server_status.py`, `is_up.py`, `api/pickle.py`, new `api/compression.py`

---

## Phase 2: Dependency Injection

### 2a. InventoryManager class

Replace module-level globals (`inventories` dict, `last_update`, `lock`) in `inventory_updater.py` with a class:

```python
class InventoryManager:
    def __init__(self):
        self.inventories: dict[str, IndexEntry] = {}
        self.last_update: datetime = datetime.now(UTC) - timedelta(days=1)
        self.lock = threading.Lock()

    def ensure_update(self): ...
    def get_inventory(self, provider, fmt, version, pickle_proto, if_newer_than): ...
```

Register on `app.state` during lifespan. Expose via a FastAPI dependency:

```python
def get_inventory_manager(request: Request) -> InventoryManager:
    return request.app.state.inventory_manager
```

### 2b. Config as a dependency

Wrap config access in a dependency for testability:

```python
def get_config(request: Request) -> ConfigSection:
    return request.app.state.config
```

### 2c. Background task trigger dependency

Extract the background inventory check pattern into a reusable dependency:

```python
async def trigger_inventory_check(
    background_tasks: BackgroundTasks,
    inventory_mgr: InventoryManager = Depends(get_inventory_manager)
):
    background_tasks.add_task(inventory_mgr.ensure_update)
```

### Files touched

`inventory_updater.py` (refactor to class), `get_data.py`, `get_inventory.py`, `__init__.py`, new `dependencies.py`

---

## Phase 3: Async Inventory & Drop `fastapi-utilities`

### 3a. Non-blocking inventory updates

Replace the blocking `threading.Lock` with a swap-on-complete pattern:

```python
class InventoryManager:
    def __init__(self):
        self._inventories: dict[str, IndexEntry] = {}
        self._updating = asyncio.Lock()

    async def update(self):
        async with self._updating:
            new_inventories = await asyncio.to_thread(self._build_inventories)
            self._inventories = new_inventories  # atomic swap

    def _build_inventories(self) -> dict:
        spz.update_inventories()
        # ... serialize all format/protocol combinations
        return result
```

Properties:
- Readers never block (they read the current dict until the swap completes)
- Only one update runs at a time (async lock)
- The event loop is never blocked (sync work runs in a thread)

### 3b. Lifespan background task

Replace `@repeat_every` with a simple asyncio task in the lifespan:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    mgr = InventoryManager()
    app.state.inventory_manager = mgr
    await mgr.update()
    task = asyncio.create_task(mgr.periodic_update_loop())
    yield
    task.cancel()
```

### 3c. Remove `fastapi-utilities`

Remove from `pyproject.toml` dependencies. It is only used for `@repeat_every`, which is replaced by the lifespan task.

### Files touched

`inventory_updater.py`, `__init__.py`, `pyproject.toml`
