# Frontend Modularization — Foundation Slice

**Date:** 2026-06-07
**Status:** Approved design, ready for implementation plan
**Scope:** First increment ("foundation slice") of a larger frontend refactor.

> **AMENDMENT (2026-06-07, post-approval):** The build-tooling decision below was
> reversed after discovering a pre-existing March 10 plan for this same task that
> used a simpler **no-build** approach. The chosen approach is now **plain ES
> modules served directly from `speasy_proxy/static/js/`, vanilla JavaScript, no
> bundler, no TypeScript, no committed build artifacts** — tested with Vitest
> (dev-only). Rationale: the user is not a web developer and relies on the
> assistant; a build-and-commit-bundles ritual is an operational footgun (forgotten
> rebuild → stale deployed site), whereas plain ES modules mean "edit `.js`, refresh
> browser, done" with zero deploy impact. Deduplication alone fixes the divergence
> bugs; TypeScript's compiler checks were judged not worth the permanent build chore.
>
> What this changes vs. the original sections below:
> - **No `web/` TS source tree, no Vite, no `tsconfig.json`, no committed bundles.**
> - Shared + page modules are plain `.js` ES modules under `speasy_proxy/static/js/`.
> - Shared theme CSS at `speasy_proxy/static/css/theme.css`.
> - Vitest config + `package.json` (dev-only) at the **repo root**; tests under `tests/js/`.
> - Templates load a page entry module via
>   `<script type="module" src="{{ base_url }}/static/js/<page>.js">`, with `base_url`
>   passed to the module through a `window.SPEASY_BASE_URL` global set in a tiny inline
>   `<script>`. Inter-module imports use **relative** paths (`./common.js`), so they
>   need no `base_url`.
>
> **Unchanged:** the module decomposition and responsibilities, the codec seam
> returning a normalized `SpeasyData` (now expressed in JSDoc, not TS types), the
> "relocate orchestration verbatim, no engine rewrite" scope, the drift-bug fixes
> (unified `toLocalISOString` with seconds; NaN-safe fetch shared by both pages;
> shared inventory primitives), pure-logic-first testing, and all non-goals.
>
> The authoritative task breakdown is the implementation plan:
> `docs/superpowers/plans/2026-06-07-frontend-modularization.md` (rewritten for this
> approach). The build-tooling rows in the "Decisions" table and the "Directory &
> build architecture" / "Build configuration" subsections below are **superseded** by
> this amendment.

## Problem

The two interactive viewers — `speasy_proxy/templates/plot.html` (2254 lines, the
waveform/spectrogram viewer at `/plot`) and `speasy_proxy/templates/demo_3d.html`
(1306 lines, the 3D orbit viewer at `/demo_3d`) — plus the landing page
`index.html` (480 lines) are each a single self-contained HTML file with one large
inline `<script>` and inline `<style>`. There is no JavaScript tooling, no module
system, and no test coverage on any of this code.

Consequences observed today:

1. **Everything is one global scope per file.** Functions like `renderAllSubplots`
   mix state, DOM manipulation, ECharts option-building, and pixel math at every
   abstraction level at once. Edits ripple unpredictably — "fix one thing, break
   another."
2. **No tests** on logic that is genuinely pure and testable (region/Shue math,
   data merges, viridis LUT, config base64, time formatting, inventory parsing).
3. **Silent divergence between duplicated copies.** The two viewers independently
   reimplement the same concerns and have already drifted into latent bugs:
   - `toLocalISOString` includes seconds in `plot.html` but **not** in
     `demo_3d.html`.
   - `plot.html` sanitizes `NaN`→`null` before `JSON.parse`; `demo_3d.html` uses
     raw `resp.json()` and **can throw** on a `NaN` in the payload.
   - Two different rule-sets parse the **same** speasy inventory `__spz_*` schema
     (`SKIP_KEYS` + `ParameterIndex` detection in `plot.html`;
     `METADATA_KEYS` + `__spz_` prefix + `isLeaf` in `demo_3d.html`).
   - The color palette, `setStatus`/`showLoading`/`showFetchBar`, sidebar/controls
     collapse behavior, `configToBase64`, and ~250 lines of dark-theme CSS are
     copied between files.

## Goal of this slice

Split JS out of the templates into a TypeScript source tree, deduplicate the shared
*leaf* logic into typed and unit-tested modules, and wire both pages (and the index)
to consume those shared modules — **with no behavioral or visual change in the
browser**. This proves the build/test pipeline end-to-end and kills the divergence
bugs, on a foundation the deeper per-page rewrite can later build on.

## Non-goals (explicitly out of scope — future specs)

- Rewriting `plot.html`'s `plotState` / `renderAllSubplots` engine.
- Rewriting `demo_3d.html`'s `updateChartOption` chart engine.
- Redesigning the two inventory-tree DOM builders (they move as-is; their behavioral
  duplication is deferred).
- Bundling ECharts (it stays a CDN-loaded global this slice).
- Implementing the CDF/WASM decoder (only the *seam* is built now — see below).
- Any change to the Python backend, API, or deployment runtime.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Tooling | Vite + TypeScript + Vitest | TypeScript catches the silent-divergence bug class; the bundler is the vehicle for TS + tests + pinned deps. |
| Build timing / bundle location | **Commit built bundles** into `speasy_proxy/static/dist/` | Deploy stays 100% Python: `uv run uvicorn` and Docker need no Node. Cost accepted: noisier diffs, rebuild-before-commit. |
| Test priority | **Pure logic first** | Highest value per effort; no DOM/browser needed. |
| First scope | **Foundation slice** (this doc) | Low risk: dedupe + test leaves, relocate orchestration verbatim. |
| CDF/WASM | **Seam now, implement later** | Codec indirection costs ~nothing now; CDF decoder is a clean future drop-in. |

## Architecture

### Directory layout

```
web/                              # NEW — TS source + tooling. NOT shipped in the wheel.
  package.json                    # Vite + Vitest dev deps; build/test scripts
  vite.config.ts                  # 3 entry points; fixed output names; no content hashing
  tsconfig.json                   # strict for src/shared/**, loose for src/pages/**
  src/
    shared/                       # framework-free, fully unit-tested
      inventory.ts
      speasyData.ts
      merge.ts
      magnetosphere.ts
      spectrogram.ts
      config.ts
      time.ts
      apiClient.ts
      format.ts
      echarts.d.ts                # ambient declaration for the CDN `echarts` global
    pages/                        # relocated page orchestration (loose-typed)
      plot.ts
      demo_3d.ts
      index.ts
    styles/
      theme.css                   # the ~250 lines of shared dark-theme CSS
    shared/**/*.test.ts           # Vitest tests colocated with shared modules

speasy_proxy/static/dist/         # Vite output — COMMITTED to git
  plot.js
  demo_3d.js
  index.js
  theme.css
```

`web/` holds source only; the wheel build (`packages = ["speasy_proxy"]`) never
includes it. Vite emits committed bundles into the existing `speasy_proxy/static/`
mount (served at `/static/`). Nothing about gunicorn / uvicorn / Docker changes.

### Build configuration

- **Entry points:** `src/pages/plot.ts`, `src/pages/demo_3d.ts`, `src/pages/index.ts`.
- **Output:** `speasy_proxy/static/dist/` with **fixed, unhashed filenames**
  (`plot.js`, `demo_3d.js`, `index.js`, `theme.css`) so the Jinja templates can
  reference stable paths without a manifest.
- **ECharts:** remains a CDN `<script>` global. The page modules reference it via an
  ambient `echarts.d.ts` declaration (`declare global` / `window.echarts`). Marked
  `external` in the Vite config so it is not bundled.
- **CSS:** `theme.css` emitted to `dist/`; each page's page-specific CSS that is NOT
  shared stays inline in its template for this slice (only the duplicated chrome moves
  to `theme.css`).

### Shared modules

Each module is framework-free and gets Vitest unit tests. The "Replaces" column names
the duplicated code being unified.

| Module | Public surface | Replaces (today) |
|---|---|---|
| `inventory.ts` | `SpzNode`/`ParameterLeaf` types; `isLeaf`, `isMetadataKey`, `getDisplayName`, `getProductPath`, `walkLeaves` | plot's `SKIP_KEYS` + `ParameterIndex` detection **and** demo_3d's `METADATA_KEYS` + `isLeaf` — unified into one rule set |
| `speasyData.ts` | `SpeasyData` model type; `detectPlotType`; the decode entry consumed by `apiClient` | plot's `.replace(/NaN/)` parse; **fixes** demo_3d's raw `resp.json()` |
| `merge.ts` | `mergeSorted`, `mergeSortedRows`, `mergeIntervals`, `evict`, `buildSeriesData` | plot's cache-merge helpers |
| `magnetosphere.ts` | `shueParams`, `classifyPoint`, `toReData`, `computeAxisRange`, region constants | demo_3d math |
| `spectrogram.ts` | viridis LUT, `computeYEdges`, `renderSpectrogramImage` | plot heatmap rendering |
| `config.ts` | `configToBase64`, `base64ToConfig` | plot **and** index copies |
| `time.ts` | `toLocalISOString` (unified, **with seconds**) + date helpers | both `toLocalISOString` copies (fixes the seconds drift) |
| `apiClient.ts` | `fetchData(...)`, `fetchInventory(...)` (URL building + fetch + decode) | both pages' fetch/URL builders |
| `format.ts` | `formatBytes`, `formatNumber`, `formatDuration` | index.html helpers |

### Codec seam (forward-compat for CDF/WASM)

`apiClient.fetchData()` returns a normalized `SpeasyData` model. Internally it routes
through a decoder indirection:

```
fetchData(...) -> SpeasyData
   decode(contentType, payload) -> SpeasyData
   ships now:  JSON decoder (current behavior, NaN-safe)
   later:      CDF decoder (cdfpp-wasm), selected by response content-type / format
```

The page modules only ever consume `SpeasyData`. A future CDF/WASM decoder implements
the same `decode` contract and slots in behind this interface with **zero page
changes**. No WASM dependency is added in this slice — only the indirection point and
the `SpeasyData` type.

Grounding fact (`speasy_proxy/api/v1/get_data.py:103-104`): server-side resampling via
`max_points` runs **before** encoding, for every format — so `format=cdf` returns the
*already-resampled* (bandwidth-bounded) variable as CDF binary. This is what makes the
future CDF path viable without losing the proxy's downsampling benefit.

### Page entry modules

`pages/plot.ts`, `pages/demo_3d.ts`, `pages/index.ts` contain each page's **existing
orchestration code, relocated verbatim** from the inline `<script>`, with duplicated
leaf helpers swapped for `import`s from `shared/`. The large engines
(`plotState` / `renderAllSubplots`; demo_3d's `updateChartOption`) **move but are not
redesigned** — behavior-identical.

### Template changes

Each template's inline `<script>…</script>` is replaced by:

```html
<link rel="stylesheet" href="{{ base_url }}/static/dist/theme.css">
...
<script type="module" src="{{ base_url }}/static/dist/plot.js"></script>
```

Page-specific (non-shared) inline CSS remains in the template for this slice. The CDN
ECharts `<script>` tags stay. `base_url` injection (already provided by
`frontend/home.py`) is unchanged.

## Typing & testing stance

- **`src/shared/**` → strict TS.** This is where types earn their keep and where every
  unit test lives.
- **`src/pages/**` → loose TS** (`noImplicitAny: false`, permissive) so relocating
  untyped orchestration verbatim does not produce a flood of type errors. These engines
  get tightened when they are rewritten in a future spec.
- **Vitest** covers the `shared/` pure functions. Representative targets:
  - `inventory`: leaf detection, metadata-key filtering, display name, product path
    across both providers (incl. the SSC default-provider case).
  - `speasyData` / decode: NaN-safe parsing, `detectPlotType`.
  - `merge`: `mergeSorted`, `mergeSortedRows`, `mergeIntervals`, `evict`.
  - `magnetosphere`: `shueParams`, `classifyPoint` (region boundaries),
    `toReData` (km→Re, distance clamp), `computeAxisRange`.
  - `spectrogram`: viridis LUT values, `computeYEdges`.
  - `config`: `configToBase64` ⇄ `base64ToConfig` round-trip.
  - `time`: `toLocalISOString` (asserts seconds are present — the drift fix).
  - `format`: bytes/number/duration formatting.
- **No DOM/browser tests this round.** The canvas spectrogram render is verified by eye
  (as today); the page orchestration is verified by manual smoke-test.

## Risks & mitigations

- **Relocating ~3500 lines of inline JS verbatim** is the primary risk — load order,
  `DOMContentLoaded` timing, accidental reliance on global leakage between functions.
  - *Mitigation:* the `shared/` tests pin the pure half; before committing, manually
    smoke-test both `/plot` and `/demo_3d` against the live server (inventory load,
    plot a line product, plot a spectrogram, pan/zoom re-fetch, share-URL round-trip;
    3D: load a trajectory, magnetopause/bow-shock toggle, view buttons).
- **Committed bundles drift from source** if someone edits `web/src` and forgets to
  rebuild.
  - *Mitigation:* document the `npm run build` step (README + CLAUDE.md); rebuild is
    part of the commit ritual for any `web/` change. (A CI check or pre-commit hook to
    enforce freshness is a possible later enhancement, not in this slice.)
- **Unifying the two inventory rule-sets** could subtly change which nodes render.
  - *Mitigation:* derive the unified rules to be a superset that preserves both pages'
    current visible output; the `inventory` tests encode the expected leaf/branch
    decisions for representative AMDA/CDAWeb/SSC fixtures.

## Definition of done

- `web/` builds via `npm run build`; committed bundles exist under
  `speasy_proxy/static/dist/`.
- `npm test` passes; `shared/` modules have unit tests covering the surfaces above.
- The three templates load their bundles + `theme.css`; no remaining duplicated leaf
  logic across `plot.ts` / `demo_3d.ts` / `index.ts` for the concerns listed in the
  shared-modules table.
- Manual smoke-test of `/`, `/plot`, `/demo_3d` shows **no visible or behavioral
  change** versus the pre-refactor pages.
- `apiClient` exposes the codec seam returning `SpeasyData`, with the JSON decoder
  shipped and the CDF decoder left as a documented extension point.
- Python test suite (`SPEASY_PROXY_OFFLINE_TESTS=1 uv run pytest speasy_proxy/`) is
  unaffected.
- README / CLAUDE.md document the `web/` build + test workflow.
