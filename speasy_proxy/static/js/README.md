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
| `api-client.js` | `buildDataUrl`, NaN-safe `decodeJson`, `fetchData`/`jsonCodec` (codec seam), `fetchInventory` |

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

`fetchData(opts, codec = jsonCodec)` decodes the proxy response through a swappable
`codec.decode(resp)`. Today only `jsonCodec` ships (NaN-safe JSON). A future CDF/WASM
decoder can implement the same interface (reading `resp.arrayBuffer()`), and pages —
which only ever see the normalized `SpeasyData` shape — would need no changes.

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
