# speasy-proxy — Code Review Backlog

Findings from a deep review (2026-06-06). Ordered by priority. Each item lists
severity, location, the problem, a fix approach, and acceptance criteria. Per
project workflow, every bug fix starts with a failing reproducer test.

Status legend: `TODO` · `IN PROGRESS` · `DONE` · `WONTFIX`

---

## P1 — Correctness & resource bugs

### BL-1 · `min_max` resampling backends diverge (numpy vs numba) · DONE
> Fixed: numpy now uses `int(i*n/n_buckets)` edges identical to numba.
> Tests: `test_min_max_backends_match_diverging_case` + randomized equivalence
> (with NaN injection). Reproducer was red (`...randomized[7]`), now green.

**Severity:** High · **Files:** `backend/_resample_numpy.py:11`, `backend/_resample_numba.py:21-22`, `backend/test_resample.py:100-109`

numpy computes bucket edges with `np.linspace(0, n, n_buckets+1, dtype=int)`
(`i*(n/n_buckets)`, two FP roundings); numba uses `int(i*n/n_buckets)` (one).
They are not bit-identical: ~15k `(n, n_buckets)` pairs under n<4000 diverge, and
it propagates to output (e.g. n=60, n_buckets=22 → 54 pts numpy vs 55 numba).
Result: downsampled data depends on whether the `[fast]`/numba extra is installed
(it is in Docker) → dev/prod mismatch. The existing equivalence test only checks
3 hand-picked combos that happen not to diverge → false confidence.

**Fix:** make numpy use the identical integer formula:
```python
for i in range(n_buckets):
    start = int(i * n / n_buckets)
    end   = int((i + 1) * n / n_buckets)
```
**Acceptance:** replace the 3 fixed-tuple equivalence cases with a property-based
test over random `n`/`n_buckets` (and random NaN injection); it must fail before
the fix and pass after.

### BL-2 · `_plot_spectrogram` leaks matplotlib figures & uses pyplot off-thread · DONE
> Fixed: switched from pyplot to an object-oriented `Figure` (no global `Gcf`
> registry, thread-safe, GC'd). Test `test_spectrogram_render_does_not_leak_figures`
> renders 5 spectrograms and asserts `plt.get_fignums()` is unchanged — green.

**Severity:** High · **File:** `backend/bokeh_backend.py:172-189`

`plt.figure()` is created on every `html_bokeh` spectrogram request and **never
closed** → unbounded figure accumulation in a long-running worker. It also runs
in `run_in_threadpool` (from `get_data`) and from the threadpooled
`chart_roulette` endpoint; pyplot's global figure manager is not thread-safe, so
concurrent spectrogram requests can corrupt each other or raise.

**Fix:** drop pyplot for the OO API — `fig = Figure(); ax = fig.subplots()`,
render via `FigureCanvasAgg`, no global state. If pyplot is retained, wrap in
`try/finally: plt.close(fig)` and guard with a module-level lock.
**Acceptance:** a test that renders N spectrograms and asserts
`len(plt.get_fignums()) == 0` afterwards (fails before, passes after).

### BL-3 · `is_up` name shadowing makes `/is_up` always report "up" · DONE
> Fixed: `from speasy.core.http import is_server_up as _http_is_server_up`; the
> BASE_URL branch now calls `_http_is_server_up`. `test_is_up.py` green (run via
> the BL-11 offline mode). Red confirmed via isolated repro: corrected code reaches
> the real checker (`HTTP_CALLED`) vs the bug's self-recursion returning `True`.

**Severity:** High · **File:** `api/v1/is_up.py:7,25,41`

`from speasy.core.http import is_server_up` is shadowed by the local
`def is_server_up(ws_class)`. Inside, `is_server_up(ws_class.BASE_URL)` resolves
to the local function (called with a URL string), which matches neither
`hasattr` branch and returns `True`. The real HTTP check never runs, so any
provider relying on the `BASE_URL` fallback is always reported up.

**Fix:** `from speasy.core.http import is_server_up as _http_is_server_up` and
call `_http_is_server_up(ws_class.BASE_URL)`.
**Acceptance:** test a fake provider class with an unreachable `BASE_URL` and no
`is_server_up` method → expect `is_up == False`.

---

## P2 — Concurrency & blocking

### BL-4 · Blocking `update_inventories()` on the event loop in `get_inventory` · DONE
**Severity:** Medium · **File:** `api/v1/get_inventory.py`

The `async def get_inventory` endpoint called the sync manager lookup directly; on
a cache miss it could reach `spz.update_inventories()`, blocking the event loop.
> Fixed: the lookup now runs via `run_in_threadpool`. Reproducer
> `test_get_inventory_does_not_starve_event_loop` runs a ticker concurrently with a
> blocking lookup and asserts the loop keeps ticking — red (`0 > 20`) before, green
> after.

### BL-5b · Concurrent `_do_update` double-fetch (in-process) · DONE
**Severity:** Medium · **File:** `backend/inventory_updater.py`

Concurrent `_do_update` calls (periodic loop + lazy per-request) shared no lock and
both passed the `last_update + interval` throttle → double upstream fetch.
> Fixed: `_do_update` now takes `self._update_lock` and re-checks `_update_due()`
> inside it (double-checked); the loser bails out. Reproducer
> `test_concurrent_do_update_fetches_once` (2 threads + barrier) — red (`got 2`)
> before, green after.

### BL-5a · Periodic inventory refresh runs in every worker (32× fetches) · DONE
**Severity:** Medium · **Files:** `backend/shared_inventory_store.py` (new), `backend/inventory_updater.py`, `config/__init__.py`

Chosen approach: **elected fetcher + shared store** (one upstream fetch per interval,
all workers converge). Implemented as `SharedInventoryStore` (a defensive
`diskcache.Cache`) + a reworked `InventoryManager`:
- **Hot path unchanged & safe:** `get_inventory` reads only in-memory state; 304 now
  uses the manager's stored `build_dates` (not the live `tree`).
- **Election:** before refreshing, a worker claims an atomic, TTL'd lease
  (`Cache.add(..., expire=lease_ttl)`); the winner fetches + builds + publishes the
  serialized payload (generation bumped last as the commit marker, inside `transact`).
- **Sync:** every `inventory_sync_poll_interval` (~60s) each worker loads a newer
  published generation instead of fetching.
- **Failure policy (availability first):** on fetch/build error nothing is published,
  last-good is kept everywhere, the lease auto-expires, and `last_attempt` +
  `inventory_retry_backoff` prevent hammering (also fixes the old lazy-path hammering).
  Any shared-store failure (open/read/write/corrupt) degrades to per-worker last-good.
- **Startup:** each worker still builds from the forked tree (no network) and seeds
  the shared store; preserves `--preload` no-fetch-at-boot.

New env (PROXY_CORE): `inventory_sync_poll_interval` (60), `inventory_retry_backoff`
(300), `inventory_lease_ttl` (600), `inventory_shared_path` (default
`<index path>/inventory_shared`).

Tests: `test_shared_inventory_store.py` (5), `test_inventory_updater.py` (7 incl.
single-fetch, concurrent-single-fetch ×5 stable, failure→last-good+backoff, degraded
in-process guard, memory-only lookup), `test_app_smoke.py` (boots & serves). All green.
BL-5b (in-process guard) folded in.

---

## P3 — Polish / correctness edges

### BL-6 · `get_data` returns pickle (wrong content-type) for `None` results · DONE
**Severity:** Low · **File:** `api/v1/get_data.py`

`None` + `json` returned a pickled `None` with an `application/python-pickle` mime.
> Fixed: `encode_output` now returns `"null"` (json mime) for `None`+json and the
> plot_data "no data" HTML for `None`+html_bokeh; `python_dict`/`speasy_variable`
> keep pickled-None. Tests in `test_get_data.py` (red→green).

### BL-7 · `get_inventory` returns 304 for genuinely missing keys · DONE
**Severity:** Low · **Files:** `api/v1/get_inventory.py`, `backend/inventory_updater.py`

`?version=5`/unbuilt formats yielded `None` → misleading **304**.
> Fixed: endpoint validates `version ∈ {1,2}` (→400), checks a new defensive
> `InventoryManager.is_current()` for the 304 decision, and returns **404** when the
> requested format/version was never built. `is_current` never 500s on a malformed
> `If-Modified-Since`. `get_inventory` is now a pure in-memory lookup. Tests in
> `test_get_inventory.py` (404/400/304/200/bad-header, red→green).

### BL-8 · `IndexEntry` overwrites its value on construction · DONE
**Severity:** Low · **File:** `index/__init__.py`

> Fixed: `__init__` now writes the default only when the key is absent, so a
> persisted value survives. `up_since` behaviour unchanged (still set to now at
> startup). Tests in `index/test_index.py` (preserve + default-when-absent).

### BL-9 · Minor cleanups · DONE
**Severity:** Trivial
- ✅ `api/v1/get_data.py` — removed the no-op `del var` before `return`.
- ✅ `backend/bokeh_backend.py` — duplicate column names made unique via
  `_unique_columns` so each line gets its own ColumnDataSource entry. Tested.

---

### BL-10 · `from speasy_proxy.api.v1 import is_up` returns the endpoint fn, not the module · DONE
**Severity:** Low (footgun) · **File:** `api/v1/__init__.py`

`from .X import *` bound each endpoint *function* into the package namespace,
shadowing the same-named *submodule*.
> Fixed: replaced the star-imports with `from . import (chart_roulette, …)`. Same
> route-registration side-effect, but the submodules are no longer shadowed.
> Tests in `api/v1/test_package_imports.py` (submodules are modules; router still
> has the routes). The app smoke test confirms routing still works.

### BL-11 · Unit tests pay the import-time inventory/provider network · DONE
**Severity:** Low (test infra) · **Files:** `conftest.py` (new)

Importing any `speasy_proxy` submodule triggers (1) `spz.update_inventories()` and
(2) speasy's eager per-provider init probe at `import speasy` (`speasy/__init__.py:21`).
A degraded provider (AMDA while half-down) made unit-test runs hang or take 5–8 min
and sometimes abort collection (`IncompleteRead`). Added env-guarded `conftest.py`
(`SPEASY_PROXY_OFFLINE_TESTS=1`, inert otherwise) that, before `import speasy`:
- sets `SPEASY_CORE_DISABLED_PROVIDERS` (speasy's own provider-agnostic mechanism)
  so no init probe runs;
- no-ops `update_inventories`.

Offline unit suite now runs in ~1.7s regardless of provider health. `test_api.py`
(needs live providers) leaves the flag unset and is unaffected.
Run unit tests with: `SPEASY_PROXY_OFFLINE_TESTS=1 uv run pytest <unit test files>`.

### BL-12 · numpy lttb emits `RuntimeWarning: Mean of empty slice` · DONE
**Severity:** Trivial · **File:** `backend/_resample_numpy.py`

> Fixed: guarded the `nanmean` with a size/all-NaN check (mirrors the numba
> `next_count > 0` path) → `next_avg = nan` without warning; results unchanged so
> backend equivalence holds. Reproducer `test_lttb_numpy_no_empty_slice_warning`
> (promotes the warning to an error; red→green). The suite is now warning-free.

## Notes
- CLAUDE.md is known-stale (claims no tests exist; omits resampling, presets, the
  ECharts `/plot` & `/demo_3d` frontends, `chart_roulette`). Worth refreshing
  alongside this work.
