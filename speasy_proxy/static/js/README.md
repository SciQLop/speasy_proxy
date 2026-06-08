# Frontend JavaScript (`static/js/`)

Plain ES modules served directly to the browser — **no build step, no bundler, no
TypeScript**. The FastAPI app serves these `.js` files as static assets under
`/static/js/`. To change the frontend: edit a `.js` file and reload the page.

## Layout

**Shared modules** (framework-free, unit-tested in `tests/js/`):

| Module | Responsibility |
|--------|----------------|
| `common.js` | `setStatus`, `showLoading`, `showFetchBar`, `fallbackCopy`, `toLocalISOString` (unified, with seconds), `escapeHtml` |
| `format.js` | `formatBytes`, `formatNumber`, `formatDuration`, `formatDateTime` |
| `inventory-tree.js` | speasy `__spz_*` schema primitives: `isSpzMetaKey`, `getDisplayName`, `getProductPath`, `shouldSkipNode`, `hasVisibleChildren`, `isParameterIndex`, `SKIP_KEYS` |
| `magnetosphere.js` | 3D physics: `shueParams`, `bowShockParams`, `classifyPoint`, `toReData`, `computeAxisRange` |
| `plot-core.js` | data merges, interval coalescing, cache eviction, `detectPlotType`, config base64, subplot/cache factories |
| `spectrogram.js` | viridis LUT, `computeYEdges`, `renderSpectrogramImage` |
| `api-client.js` | `buildDataUrl`, NaN-safe `decodeJson`, `fetchData`/`jsonCodec` (codec seam), `fetchInventory`, `enableCdfCodec` |
| `cdf-codec.js` | `cdfCodec` — decodes `format=cdf` (application/x-cdf) into `SpeasyData` via CDFpp-WASM (`vendor/cdfpp.js` + `cdfpp.wasm`) |

**Page entry modules** (relocated page orchestration; loaded by the templates):

| Module | Page | Template |
|--------|------|----------|
| `home.js` | `/` | `templates/index.html` |
| `plot.js` | `/plot` | `templates/plot.html` |
| `demo3d.js` | `/demo_3d` | `templates/demo_3d.html` |

## How pages load their module

Each template ends with:

```html
<script>window.SPEASY_BASE_URL = '{{ base_url }}';</script>
<script type="module" src="{{ base_url }}/static/js/<page>.js"></script>
```

- The page module reads the API base URL from `window.SPEASY_BASE_URL` (templates
  can't inject `{{ base_url }}` into a static `.js` file).
- Inter-module imports use **relative** paths (`import { ... } from './common.js'`),
  so they need no base URL.
- A module that calls the API takes the base URL as a parameter (e.g.
  `fetchData({ baseUrl, ... })`), it never reads the global itself.
- ECharts (and ECharts-GL for `/demo_3d`) are loaded as CDN globals via `<script>`
  tags in each template's `<head>` — the page modules reference the `echarts` global
  directly; ECharts is intentionally **not** imported/bundled.

## The codec seam (`api-client.js`)

`fetchData(opts, codec = preferredCodec)` decodes the proxy response through a swappable
`codec` = `{ format, async decode(resp) }`. `codec.format` selects the server output
(`get_data?format=...`) and `codec.decode` normalizes it to `SpeasyData`. Pages only ever
see `SpeasyData`, so they are codec-agnostic.

Two codecs ship:

- **`jsonCodec`** (default) — `format=json`, NaN-safe `JSON.parse`.
- **`cdfCodec`** (`cdf-codec.js`) — `format=cdf`, decoded in-browser by the **CDFpp
  WebAssembly** build (`vendor/cdfpp.js` self-locates `vendor/cdfpp.wasm` via
  `import.meta.url` — no bundler). The proxy resamples *before* encoding, so CDF keeps the
  bandwidth bound; it decodes ~6–14× faster than `JSON.parse` and preserves real dtypes
  (int64 epoch, float32/64) with no `NaN`→`null` kludge. Time axes use the WASM
  `time_values_as_ns_since_1970` (leap-second correct).

**Opt in** by setting `window.SPEASY_USE_CDF = true` *before* `api-client.js` loads (e.g. a
`<script>` in the template, next to `window.SPEASY_BASE_URL`). It is **off by default**.
Any CDF-path failure (server, WASM, decode) degrades gracefully: `fetchData` retries the
request once as JSON.

### Vendored WASM assets (`vendor/`)

`vendor/cdfpp.js` (emscripten ES-module glue) + `vendor/cdfpp.wasm` are built from the
**CDFpp** repo (`wacdfpp/`, deployed at `sciqlop.github.io/CDFpp/`). To update: rebuild
there and copy both files over. The mapping is pinned by `tests/js/cdf-codec.test.js`
against real fixtures in `tests/js/fixtures/` (a line and a spectrogram product).

## Tests (run from the repo root)

```bash
npm install      # once, to get the only dev dependency (Vitest)
npm run test:js  # run the unit tests in tests/js/
```

There is **nothing to build**. Vitest is a dev-only dependency; it is not required to
run or deploy the server.

## Not yet modularized

- **CSS** still lives inline in each template's `<style>` block. A shared
  `theme.css` was scoped but deferred: the two viewers' chrome CSS had diverged
  enough (e.g. `body`/`.main`/`.controls-bar`/`.status-bar` differences) that a naive
  extraction risked subtle visual regressions. Revisit as a careful, separate pass.
- The page modules (`plot.js`, `demo3d.js`) still contain large imperative
  orchestration engines relocated verbatim; decomposing those is a future increment.
