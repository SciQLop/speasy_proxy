# FastAPI Modernization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor speasy-proxy to idiomatic FastAPI patterns (Annotated params, Pydantic models, dependency injection, async inventory) without breaking Speasy client wire compatibility.

**Architecture:** Three independent phases, each a separate PR. Phase 1 modernizes query params and response models. Phase 2 introduces dependency injection via `Depends()`. Phase 3 makes inventory updates non-blocking and removes `fastapi-utilities`.

**Tech Stack:** FastAPI, Pydantic v2, Python 3.10+ `Annotated` types, asyncio

---

## Phase 1: Core Patterns & Cleanup

### Task 1: Create shared compression utility

**Files:**
- Create: `speasy_proxy/api/compression.py`

**Step 1: Create the shared `compress_if_asked` function**

Create `speasy_proxy/api/compression.py`:

```python
import pyzstd


def compress_if_asked(data: bytes | str, mime: str, zstd_compression: bool = False) -> tuple[bytes | str, str]:
    if zstd_compression:
        if isinstance(data, str):
            data = data.encode()
        return pyzstd.compress(data), "application/x-zstd-compressed"
    return data, mime
```

**Step 2: Commit**

```bash
git add speasy_proxy/api/compression.py
git commit -m "Add shared compression utility"
```

---

### Task 2: Modernize query parameters to Annotated types

**Files:**
- Modify: `speasy_proxy/api/v1/query_parameters.py` (full rewrite)

**Step 1: Rewrite query_parameters.py with Annotated types**

Replace all contents of `speasy_proxy/api/v1/query_parameters.py` with:

```python
from typing import Annotated

from fastapi import Query
import speasy as spz

Provider = Annotated[str, Query(default="ssc", enum=spz.list_providers(), example="ssc")]
ZstdCompression = Annotated[bool, Query(default=False, example=False)]
InventoryFormat = Annotated[str, Query(default="json", example="json", enum=["json", "python_dict"])]
PickleProtocol = Annotated[int, Query(default=3, example=3, ge=0, le=5)]
DataFormat = Annotated[str, Query(
    default="python_dict", example="python_dict",
    enum=["python_dict", "speasy_variable", "html_bokeh", "json", "cdf"]
)]
```

**Step 2: Commit**

```bash
git add speasy_proxy/api/v1/query_parameters.py
git commit -m "Modernize query parameters to Annotated types"
```

---

### Task 3: Update get_data.py to use new query params, shared compression, and fix deprecations

**Files:**
- Modify: `speasy_proxy/api/v1/get_data.py`

**Step 1: Update imports and query parameter usage**

In `speasy_proxy/api/v1/get_data.py`:

1. Replace import line 9 (`import pyzstd`) — remove it entirely (compression is now in shared module)
2. Replace import line 22 (`from .query_parameters import QueryZstd, QueryPickleProto, QueryDataFormat`) with:
   ```python
   from .query_parameters import ZstdCompression, PickleProtocol, DataFormat
   ```
3. Add import for shared compression:
   ```python
   from speasy_proxy.api.compression import compress_if_asked
   ```
4. In line 5, add `UTC` to the datetime import:
   ```python
   from datetime import datetime, UTC
   ```

**Step 2: Fix the deprecated `utcfromtimestamp` call**

Replace line 36:
```python
def ts_to_str(ts: float):
    return dt_to_str(datetime.utcfromtimestamp(ts))
```
with:
```python
def ts_to_str(ts: float):
    return dt_to_str(datetime.fromtimestamp(ts, tz=UTC))
```

**Step 3: Update the `get_data` endpoint signature**

Replace lines 59, 60, 69 in the function signature:
```python
# Old:
format: str = QueryDataFormat,
zstd_compression: bool = QueryZstd,
...
pickle_proto: int = QueryPickleProto):
```
with:
```python
format: DataFormat,
zstd_compression: ZstdCompression,
...
pickle_proto: PickleProtocol):
```

**Step 4: Remove the local `compress_if_asked` function**

Delete lines 152-156 (the local `compress_if_asked` definition). The shared import from `speasy_proxy.api.compression` replaces it.

**Step 5: Commit**

```bash
git add speasy_proxy/api/v1/get_data.py
git commit -m "Update get_data to use Annotated params and shared compression"
```

---

### Task 4: Update get_inventory.py to use new query params and shared compression

**Files:**
- Modify: `speasy_proxy/api/v1/get_inventory.py`

**Step 1: Update imports**

In `speasy_proxy/api/v1/get_inventory.py`:

1. Remove line 12 (`import pyzstd`)
2. Replace line 15 (`from .query_parameters import QueryProvider, QueryZstd, QueryFormat, QueryPickleProto`) with:
   ```python
   from .query_parameters import Provider, ZstdCompression, InventoryFormat, PickleProtocol
   ```
3. Add:
   ```python
   from speasy_proxy.api.compression import compress_if_asked
   ```

**Step 2: Remove the local `compress_if_asked` function**

Delete lines 51-57 (the local `compress_if_asked` definition).

**Step 3: Update the `get_inventory` endpoint signature**

Replace lines 62-65:
```python
# Old:
async def get_inventory(request: Request, provider: str = QueryProvider,
                        format: str = QueryFormat, pickle_proto: int = QueryPickleProto,
                        version: int = 1,
                        zstd_compression: bool = QueryZstd):
```
with:
```python
async def get_inventory(request: Request, provider: Provider,
                        format: InventoryFormat, pickle_proto: PickleProtocol,
                        version: int = 1,
                        zstd_compression: ZstdCompression):
```

**Step 4: Remove commented-out code**

Delete lines 22-36 (the large block of commented-out code).

**Step 5: Commit**

```bash
git add speasy_proxy/api/v1/get_inventory.py
git commit -m "Update get_inventory to use Annotated params and shared compression"
```

---

### Task 5: Update get_cache_entries.py and is_up.py to use new query params

**Files:**
- Modify: `speasy_proxy/api/v1/get_cache_entries.py`
- Modify: `speasy_proxy/api/v1/is_up.py`

**Step 1: Update get_cache_entries.py**

Replace line 6 (`from .query_parameters import QueryPickleProto`) with:
```python
from .query_parameters import PickleProtocol
```

Replace line 12 (`async def get_cache_entries(pickle_proto: int = QueryPickleProto):`) with:
```python
async def get_cache_entries(pickle_proto: PickleProtocol):
```

**Step 2: Update is_up.py**

Replace line 4 (`from .query_parameters import QueryProvider`) with:
```python
from .query_parameters import Provider
```

Replace line 45 (`def is_up(request: Request, provider: str = QueryProvider):`) with:
```python
def is_up(request: Request, provider: Provider):
```

**Step 3: Commit**

```bash
git add speasy_proxy/api/v1/get_cache_entries.py speasy_proxy/api/v1/is_up.py
git commit -m "Update remaining endpoints to use Annotated query params"
```

---

### Task 6: Add Pydantic response models for JSON endpoints

**Files:**
- Create: `speasy_proxy/api/v1/models.py`
- Modify: `speasy_proxy/api/v1/get_server_status.py`
- Modify: `speasy_proxy/api/v1/is_up.py`

**Step 1: Create models.py**

Create `speasy_proxy/api/v1/models.py`:

```python
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
```

**Step 2: Update get_server_status.py to use the model**

Replace the full contents of `speasy_proxy/api/v1/get_server_status.py` with:

```python
from .routes import router
import logging
from speasy_proxy.backend import status
from .models import ServerStatus

log = logging.getLogger(__name__)


@router.get('/get_server_status', description='Get server status', response_model=ServerStatus)
async def get_server_status():
    log.debug('Client asking for server status')
    return status()
```

**Step 3: Update is_up.py to use the model**

In `speasy_proxy/api/v1/is_up.py`:

1. Replace line 1 (`from fastapi.responses import JSONResponse`) — remove it
2. Add import:
   ```python
   from fastapi.responses import JSONResponse
   from .models import ProviderStatus
   ```
3. Replace the endpoint function body (lines 44-57) with:
   ```python
   @router.get('/is_up', response_class=JSONResponse, description='Check if the server is up')
   def is_up(request: Request, provider: Provider):
       log.debug(f'Client asking if {provider} is up')
       ws_class = PROVIDERS.get(provider.lower())
       if ws_class:
           return ProviderStatus(provider=provider, is_up=is_server_up(ws_class))
       else:
           return JSONResponse(
               content=ProviderStatus(provider=provider, is_up=False, error=f'Provider {provider} not found').model_dump(),
               status_code=404
           )
   ```

**Step 4: Commit**

```bash
git add speasy_proxy/api/v1/models.py speasy_proxy/api/v1/get_server_status.py speasy_proxy/api/v1/is_up.py
git commit -m "Add Pydantic response models for JSON endpoints"
```

---

### Task 7: Clean up api/pickle.py

**Files:**
- Modify: `speasy_proxy/api/pickle.py`

**Step 1: Remove unused import**

In `speasy_proxy/api/pickle.py`, remove line 2 (`from fastapi import Request`).

**Step 2: Commit**

```bash
git add speasy_proxy/api/pickle.py
git commit -m "Remove unused import from pickle utility"
```

---

### Task 8: Verify Phase 1

**Step 1: Run the application to verify no import errors**

```bash
cd /var/home/jeandet/Documents/prog/speasy_proxy
uv run python -c "from speasy_proxy import app; print('App created successfully')"
```

Expected: `App created successfully`

**Step 2: Run tests if any exist**

```bash
uv run pytest -v
```

**Step 3: Verify OpenAPI schema renders**

```bash
uv run python -c "
from speasy_proxy import app
from fastapi.testclient import TestClient
client = TestClient(app)
resp = client.get('/openapi.json')
print('OpenAPI schema OK' if resp.status_code == 200 else f'FAIL: {resp.status_code}')
"
```

---

## Phase 2: Dependency Injection

### Task 9: Refactor InventoryManager into a class

**Files:**
- Modify: `speasy_proxy/backend/inventory_updater.py` (major refactor)

**Step 1: Rewrite inventory_updater.py as a class**

Replace the full contents of `speasy_proxy/backend/inventory_updater.py` with:

```python
from datetime import datetime, timedelta, UTC
from typing import Optional
import speasy as spz
from speasy.core.inventory.indexes import to_json, to_dict, SpeasyIndex
from speasy.inventories import tree
from speasy.core.requests_scheduling.request_dispatch import PROVIDERS

import logging
import threading
import pickle
from dateutil import parser

from speasy_proxy.api import pickle_data

log = logging.getLogger(__name__)

_INVENTORY_KEY = "inventory/{provider}/{fmt}"


class InventoryManager:
    def __init__(self, update_interval_seconds: int = 7200):
        self._inventories: dict[str, bytes | str] = {}
        self._last_update: datetime = datetime.now(UTC) - timedelta(days=1)
        self._lock = threading.Lock()
        self._update_interval = update_interval_seconds

    @property
    def last_update(self) -> datetime:
        return self._last_update

    @property
    def update_interval(self) -> int:
        return self._update_interval

    def _inventory_key(self, provider: str, fmt: str, version: int = 1, pickle_proto: int | None = None) -> str:
        if fmt == "python_dict":
            if pickle_proto is None:
                raise ValueError("pickle_proto must be specified when format is 'python_dict'.")
            return _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        return _INVENTORY_KEY.format(provider=provider, fmt=fmt)

    def _save_inventory_as_json(self, inventory: SpeasyIndex, provider: str, target: dict):
        key = _INVENTORY_KEY.format(provider=provider, fmt="json")
        target[key] = to_json(inventory)
        log.debug(f"Inventory for {provider} saved as JSON.")

    def _save_inventory_as_pickled_dict(self, inventory: SpeasyIndex, provider: str,
                                        version: int, pickle_proto: int, target: dict):
        key = _INVENTORY_KEY.format(provider=provider, fmt=f"pickle_proto_{pickle_proto}_version_{version}")
        target[key] = pickle_data(to_dict(inventory, version=version), pickle_proto)
        log.debug(f"Inventory for {provider} saved as pickled dict with protocol {pickle_proto}.")

    def _build_all_inventories(self) -> dict[str, bytes | str]:
        result: dict[str, bytes | str] = {}
        for provider in set(PROVIDERS).intersection(tree.__dict__.keys()):
            self._save_inventory_as_json(tree.__dict__[provider], provider, result)
            for pp in range(1, pickle.HIGHEST_PROTOCOL + 1):
                for version in range(1, 3):
                    self._save_inventory_as_pickled_dict(tree.__dict__[provider], provider, version, pp, result)
        _all = SpeasyIndex(name="all", provider="speasy_proxy", uid="", meta=tree.__dict__)
        self._save_inventory_as_json(_all, "all", result)
        for pp in range(1, pickle.HIGHEST_PROTOCOL + 1):
            for version in range(1, 3):
                self._save_inventory_as_pickled_dict(_all, "all", version, pp, result)
        return result

    def ensure_update(self):
        if datetime.now(UTC) >= (self._last_update + timedelta(seconds=self._update_interval)):
            with self._lock:
                log.debug("Updating runtime inventory")
                if 'build_date' not in tree.__dict__:
                    build_dates = [parser.parse(tree.__dict__[p].build_date) for p in tree.__dict__.keys()]
                    tree.__dict__["build_date"] = max(build_dates).isoformat()
                spz.update_inventories()
                self._inventories = self._build_all_inventories()
                self._last_update = datetime.now(UTC)

    def get_inventory(self, provider: str, fmt: str, version: int = 1,
                      pickle_proto: int | None = None, if_newer_than: str | None = None) -> Optional[bytes | str]:
        if if_newer_than is not None:
            if provider == "all":
                if parser.parse(tree.build_date).astimezone(UTC) < parser.parse(if_newer_than).astimezone(UTC):
                    log.debug(f"Inventory for 'all' is not newer than {if_newer_than}. Returning None.")
                    return None
            else:
                if parser.parse(tree.__dict__[provider].build_date).astimezone(UTC) < parser.parse(
                        if_newer_than).astimezone(UTC):
                    log.debug(f"Inventory for '{provider}' is not newer than {if_newer_than}. Returning None.")
                    return None

        key = self._inventory_key(provider, fmt, version, pickle_proto)
        if key not in self._inventories:
            log.warning(f"Inventory for '{provider}' not available (key={key}). Updating.")
            self.ensure_update()
        return self._inventories.get(key)

    def update_sync(self):
        log.info("Updating inventory...")
        self.ensure_update()
        log.info("Inventory updated.")
```

**Step 2: Commit**

```bash
git add speasy_proxy/backend/inventory_updater.py
git commit -m "Refactor inventory_updater into InventoryManager class"
```

---

### Task 10: Create dependencies module

**Files:**
- Create: `speasy_proxy/dependencies.py`

**Step 1: Create the dependencies file**

Create `speasy_proxy/dependencies.py`:

```python
from fastapi import Request, BackgroundTasks, Depends

from speasy_proxy.backend.inventory_updater import InventoryManager


def get_inventory_manager(request: Request) -> InventoryManager:
    return request.app.state.inventory_manager


def trigger_inventory_check(
    background_tasks: BackgroundTasks,
    inventory_mgr: InventoryManager = Depends(get_inventory_manager),
):
    background_tasks.add_task(inventory_mgr.ensure_update)
```

**Step 2: Commit**

```bash
git add speasy_proxy/dependencies.py
git commit -m "Add FastAPI dependency injection for InventoryManager"
```

---

### Task 11: Update app lifespan to create and register InventoryManager

**Files:**
- Modify: `speasy_proxy/__init__.py`

**Step 1: Update __init__.py**

Replace the full contents of `speasy_proxy/__init__.py` with:

```python
__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.13.5'

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from datetime import datetime, UTC
from .index import up_since
from .api.v1 import api_router as v1_api_router
from .frontend import frontend_router
import logging
from .backend.inventory_updater import InventoryManager
from .config import core as config
from contextlib import asynccontextmanager

log = logging.getLogger(__name__)


def get_application(lifespan=None) -> FastAPI:
    root_path = os.environ.get('SPEASY_PROXY_PREFIX', '')
    if root_path:
        log.info(f'Root path set to {root_path}')
        if not root_path.startswith('/'):
            root_path = '/' + root_path
        if root_path.endswith('/'):
            root_path = root_path[:-1]
    else:
        root_path = ''

    _app = FastAPI(
        title="speasy-proxy",
        description="A fast speasy cache server",
        debug=False,
        root_path=root_path,
        lifespan=lifespan
    )
    _app.include_router(frontend_router)
    _app.include_router(v1_api_router)
    _app.mount("/static/", StaticFiles(directory=f"{os.path.dirname(os.path.abspath(__file__))}/static"), name="static")

    up_since.set(datetime.now(UTC))

    _app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return _app


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting up speasy-proxy...")
    mgr = InventoryManager(update_interval_seconds=config.inventory_update_interval.get())
    app.state.inventory_manager = mgr
    mgr.update_sync()
    yield
    log.info("Shutting down speasy-proxy...")

app = get_application(lifespan=lifespan)
```

**Step 2: Commit**

```bash
git add speasy_proxy/__init__.py
git commit -m "Register InventoryManager on app.state in lifespan"
```

---

### Task 12: Update get_data.py to use dependency injection

**Files:**
- Modify: `speasy_proxy/api/v1/get_data.py`

**Step 1: Update imports**

In `speasy_proxy/api/v1/get_data.py`:

1. Remove line 24 (`from speasy_proxy.backend.inventory_updater import ensure_update_inventory`)
2. Add:
   ```python
   from fastapi import Depends
   from speasy_proxy.dependencies import trigger_inventory_check
   ```

**Step 2: Update endpoint signature**

Add `_=Depends(trigger_inventory_check)` to the `get_data` function signature and remove the manual `background_tasks` parameter and `background_tasks.add_task(ensure_update_inventory)` line:

Replace the function signature (lines 55-69) and remove line 71 (`background_tasks.add_task(ensure_update_inventory)`):

```python
@router.get('/get_data', description='Get data from cache or remote server')
async def get_data(request: Request, path: str = Query(example="amda/c1_b_gsm"),
                   start_time: datetime = Query(example="2018-10-24T00:00:00"),
                   stop_time: datetime = Query(example="2018-10-24T02:00:00"),
                   format: DataFormat,
                   zstd_compression: ZstdCompression,
                   output_format: Optional[str] = Query(None, enum=["CDF_ISTP"],
                                                        description="Data format used to retrieve data from remote server (such as AMDA), not the data format of the current request. Only available with AMDA."),
                   coordinate_system: Optional[str] = Query(None, enum=["geo", "gm", "gse", "gsm", "sm", "geitod",
                                                                        "geij2000"],
                                                            description="Coordinate system used to retrieve trajectories from SSCWeb."),
                   method: Optional[str] = Query(None, enum=["API", "BEST", "FILE"],
                                                 description="Method used to retrieve data from CDA."),
                   product_inputs: Optional[Json] = Query(None, description="Product input parameters (in JSON format) used used for example in AMDA templates parameters"),
                   pickle_proto: PickleProtocol,
                   _=Depends(trigger_inventory_check)):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    # ... rest of function body unchanged (without the background_tasks.add_task line)
```

Also remove `BackgroundTasks` from the fastapi import line since it's no longer directly used.

**Step 3: Commit**

```bash
git add speasy_proxy/api/v1/get_data.py
git commit -m "Use dependency injection for inventory check in get_data"
```

---

### Task 13: Update get_inventory.py to use dependency injection

**Files:**
- Modify: `speasy_proxy/api/v1/get_inventory.py`

**Step 1: Update imports**

In `speasy_proxy/api/v1/get_inventory.py`:

1. Replace line 10 (`from speasy_proxy.backend.inventory_updater import ensure_update_inventory, get_inventory as _get_inventory`) with:
   ```python
   from fastapi import Depends
   from speasy_proxy.dependencies import get_inventory_manager
   from speasy_proxy.backend.inventory_updater import InventoryManager
   ```

**Step 2: Update `encode_output` to accept an InventoryManager**

Replace the `encode_output` function:

```python
def encode_output(inventory_mgr: InventoryManager, provider: str, fmt, pickle_proto, version,
                  if_newer_than: str = None):
    return inventory_mgr.get_inventory(provider, fmt=fmt, pickle_proto=pickle_proto, version=version,
                                       if_newer_than=if_newer_than), _mime_type(fmt)
```

**Step 3: Update endpoint to inject InventoryManager**

```python
@router.get('/get_inventory', response_class=Response, description='Get the inventory of a provider or all providers',
            responses={304: {"description": "Client inventory is up to date"}, 200: {"description": "Inventory data"}})
async def get_inventory(request: Request, provider: Provider,
                        format: InventoryFormat, pickle_proto: PickleProtocol,
                        version: int = 1,
                        zstd_compression: ZstdCompression,
                        inventory_mgr: InventoryManager = Depends(get_inventory_manager)):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    log.debug(f'New inventory request {request_id}: {provider}')
    if provider not in list_providers() and provider != "all":
        log.debug(f'{request_id}, unknown provider: {provider}')
        return Response(status_code=status.HTTP_400_BAD_REQUEST, content=f"Unknown or disabled provider: {provider}")
    data, mime = encode_output(inventory_mgr, provider, format, pickle_proto, version,
                               if_newer_than=request.headers.get("If-Modified-Since"))
    if data is None:
        log.debug(f'{request_id}, client inventory is up to date')
        return Response(status_code=status.HTTP_304_NOT_MODIFIED)

    result, mime = compress_if_asked(data, mime, zstd_compression)
    request_duration = (time.time_ns() - request_start_time) / 1000.
    log.debug(f'{request_id}, duration = {request_duration}us')

    return Response(media_type=mime, content=result,
                    headers={'Content-Type': mime})
```

**Step 4: Commit**

```bash
git add speasy_proxy/api/v1/get_inventory.py
git commit -m "Use dependency injection for InventoryManager in get_inventory"
```

---

### Task 14: Update backend/__init__.py to use InventoryManager

**Files:**
- Modify: `speasy_proxy/backend/__init__.py`

**Step 1: Decouple status() from global state**

The `status()` function currently imports `last_update` from the old module-level global. Since `status()` is called from `get_server_status` which doesn't have access to the DI system (it's a simple endpoint), we have two options. The simplest: make `status()` accept `last_update` as a parameter.

Replace `speasy_proxy/backend/__init__.py` with:

```python
from speasy.core.cache import _cache
from speasy_proxy.index import up_since
from speasy_proxy import __version__
from datetime import datetime, UTC, timedelta
import speasy as spz


def status(last_inventory_update: datetime = None, update_interval_seconds: int = 7200):
    _up_since = up_since.value()
    up_time = datetime.now(UTC) - _up_since

    with _cache.transact():
        cache_len = len(_cache)
        cache_disk = _cache.disk_size()
    return {
        'entries': cache_len,
        'cache_disk_size': cache_disk,
        'up_since': _up_since.isoformat(),
        'up_duration': up_time.total_seconds(),
        'last_inventory_update': last_inventory_update.isoformat() if last_inventory_update else 'never',
        'inventory_size': str(
            sum(map(lambda p: len(p.parameters),
                    set(spz.inventories.flat_inventories.__dict__.values())))),
        'docs': 'https://speasyproxy.readthedocs.io/en/latest/',
        'speasy_version': spz.__version__,
        'version': __version__,
        'inventory_update_interval': str(timedelta(seconds=update_interval_seconds)),
    }
```

**Step 2: Update get_server_status.py to inject InventoryManager**

Replace `speasy_proxy/api/v1/get_server_status.py` with:

```python
from fastapi import Depends
from .routes import router
import logging
from speasy_proxy.backend import status
from speasy_proxy.backend.inventory_updater import InventoryManager
from speasy_proxy.dependencies import get_inventory_manager
from .models import ServerStatus

log = logging.getLogger(__name__)


@router.get('/get_server_status', description='Get server status', response_model=ServerStatus)
async def get_server_status(inventory_mgr: InventoryManager = Depends(get_inventory_manager)):
    log.debug('Client asking for server status')
    return status(
        last_inventory_update=inventory_mgr.last_update,
        update_interval_seconds=inventory_mgr.update_interval,
    )
```

**Step 3: Commit**

```bash
git add speasy_proxy/backend/__init__.py speasy_proxy/api/v1/get_server_status.py
git commit -m "Wire get_server_status through dependency injection"
```

---

### Task 15: Verify Phase 2

**Step 1: Run the application to verify no import errors**

```bash
uv run python -c "from speasy_proxy import app; print('App created successfully')"
```

Expected: `App created successfully`

**Step 2: Run tests**

```bash
uv run pytest -v
```

**Step 3: Verify OpenAPI schema**

```bash
uv run python -c "
from speasy_proxy import app
from fastapi.testclient import TestClient
client = TestClient(app)
resp = client.get('/openapi.json')
import json
schema = resp.json()
paths = list(schema['paths'].keys())
print(f'Endpoints: {paths}')
print('OpenAPI schema OK' if resp.status_code == 200 else f'FAIL: {resp.status_code}')
"
```

---

## Phase 3: Async Inventory & Drop fastapi-utilities

### Task 16: Make InventoryManager async with non-blocking updates

**Files:**
- Modify: `speasy_proxy/backend/inventory_updater.py`

**Step 1: Add async update method and periodic loop**

Add these methods to the `InventoryManager` class (at the end of the class):

```python
    async def update_async(self):
        log.info("Updating inventory (async)...")
        new_inventories = await asyncio.to_thread(self._do_update)
        if new_inventories is not None:
            self._inventories = new_inventories
        log.info("Inventory updated.")

    def _do_update(self) -> dict[str, bytes | str] | None:
        if datetime.now(UTC) >= (self._last_update + timedelta(seconds=self._update_interval)):
            log.debug("Updating runtime inventory")
            if 'build_date' not in tree.__dict__:
                build_dates = [parser.parse(tree.__dict__[p].build_date) for p in tree.__dict__.keys()]
                tree.__dict__["build_date"] = max(build_dates).isoformat()
            spz.update_inventories()
            result = self._build_all_inventories()
            self._last_update = datetime.now(UTC)
            return result
        return None

    async def periodic_update_loop(self):
        while True:
            await asyncio.sleep(self._update_interval)
            try:
                await self.update_async()
            except Exception:
                log.exception("Failed to update inventory")
```

Also add `import asyncio` at the top of the file.

The `ensure_update` (sync) method can remain for background task use from `get_data`, but it no longer needs the lock since `_build_all_inventories` writes to a local dict and swaps atomically. Simplify it:

```python
    def ensure_update(self):
        result = self._do_update()
        if result is not None:
            self._inventories = result
```

Remove `self._lock` from `__init__` and the `threading` import if no longer used.

**Step 2: Commit**

```bash
git add speasy_proxy/backend/inventory_updater.py
git commit -m "Add async non-blocking inventory update with atomic swap"
```

---

### Task 17: Update lifespan to use async update and periodic loop

**Files:**
- Modify: `speasy_proxy/__init__.py`

**Step 1: Update lifespan to use async update and background task**

Replace the lifespan function in `speasy_proxy/__init__.py`:

```python
import asyncio

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting up speasy-proxy...")
    mgr = InventoryManager(update_interval_seconds=config.inventory_update_interval.get())
    app.state.inventory_manager = mgr
    await mgr.update_async()
    task = asyncio.create_task(mgr.periodic_update_loop())
    yield
    task.cancel()
    log.info("Shutting down speasy-proxy...")
```

Remove the `update_sync` call and replace with `update_async`.

**Step 2: Commit**

```bash
git add speasy_proxy/__init__.py
git commit -m "Use async inventory update and periodic loop in lifespan"
```

---

### Task 18: Remove fastapi-utilities dependency

**Files:**
- Modify: `pyproject.toml`

**Step 1: Remove fastapi-utilities from dependencies**

In `pyproject.toml`, remove the line `"fastapi-utilities",` from the `dependencies` list (line 43).

**Step 2: Verify no remaining imports**

```bash
cd /var/home/jeandet/Documents/prog/speasy_proxy
grep -r "fastapi_utilities" speasy_proxy/
```

Expected: no output (the old `from fastapi_utilities import repeat_every` was removed in Task 9).

**Step 3: Sync dependencies**

```bash
uv sync --dev
```

**Step 4: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "Remove fastapi-utilities dependency"
```

---

### Task 19: Final verification

**Step 1: Run the application**

```bash
uv run python -c "from speasy_proxy import app; print('App created successfully')"
```

**Step 2: Run tests**

```bash
uv run pytest -v
```

**Step 3: Verify OpenAPI schema**

```bash
uv run python -c "
from speasy_proxy import app
from fastapi.testclient import TestClient
client = TestClient(app)
resp = client.get('/openapi.json')
print('OpenAPI schema OK' if resp.status_code == 200 else f'FAIL: {resp.status_code}')
"
```

**Step 4: Spot-check endpoint signatures haven't changed**

```bash
uv run python -c "
from speasy_proxy import app
from fastapi.testclient import TestClient
client = TestClient(app)
schema = client.get('/openapi.json').json()
for path, methods in schema['paths'].items():
    for method, details in methods.items():
        params = [p['name'] for p in details.get('parameters', [])]
        print(f'{method.upper()} {path}: {params}')
"
```

Verify that all parameter names match the original API.
