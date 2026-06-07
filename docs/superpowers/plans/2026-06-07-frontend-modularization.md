# Frontend Modularization (Foundation Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the inline JavaScript from `plot.html`, `demo_3d.html`, and `index.html` into a TypeScript source tree (`web/`) built by Vite into committed bundles, deduplicating shared leaf logic into strict-typed, Vitest-tested modules — with no behavioral or visual change.

**Architecture:** Source lives in `web/src/` (`shared/` strict-typed + tested, `pages/` loose-typed orchestration relocated verbatim). Vite emits fixed-name bundles to `speasy_proxy/static/js/`, which are committed to git so deployment stays pure-Python. A swappable codec seam in `apiClient` returns a normalized `SpeasyData` model so a future CDF/WASM decoder drops in without page changes.

**Tech Stack:** TypeScript 5, Vite 6 (esbuild), Vitest 2, Node 22 / npm 10. Pages keep ECharts as a CDN-loaded global.

**Reference spec:** `docs/superpowers/specs/2026-06-07-frontend-modularization-design.md`

**Key conventions for this plan:**
- Bundle output dir is `speasy_proxy/static/js/` (NOT `dist/` — `.gitignore` ignores `dist/`).
- Shared theme CSS lives at `speasy_proxy/static/css/theme.css`.
- Shared modules under `web/src/shared/` are strict-typed and tested. Page modules under `web/src/pages/` start with `// @ts-nocheck` (loose) because they are relocated untyped orchestration.
- Tests are colocated as `web/src/shared/<name>.test.ts`.
- All `npm` commands are run from the `web/` directory.

---

## Task 1: Scaffold the `web/` toolchain

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/src/shared/smoke.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "speasy-proxy-web",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  build: {
    outDir: resolve(__dirname, '../speasy_proxy/static/js'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        plot: resolve(__dirname, 'src/pages/plot.ts'),
        demo_3d: resolve(__dirname, 'src/pages/demo_3d.ts'),
        index: resolve(__dirname, 'src/pages/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `web/src/shared/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Ignore `web/node_modules/`**

Append to `.gitignore`:

```
web/node_modules/
```

- [ ] **Step 6: Install deps and verify the test runner works**

Run (from repo root):
```bash
cd web && npm install && npm test
```
Expected: install succeeds; Vitest reports `1 passed` for the smoke test.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts web/src/shared/smoke.test.ts .gitignore
git commit -m "build(web): scaffold Vite + TypeScript + Vitest toolchain"
```

---

## Task 2: `time.ts` — unified date formatting

**Files:**
- Create: `web/src/shared/time.ts`
- Test: `web/src/shared/time.test.ts`

Unifies the two divergent `toLocalISOString` copies (`plot.html:501` includes seconds; `demo_3d.html:1069` omits them). The unified version **includes seconds**.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { toLocalISOString } from './time';

describe('toLocalISOString', () => {
  it('formats a local datetime with seconds, zero-padded', () => {
    const d = new Date(2018, 0, 5, 3, 7, 9); // local time
    expect(toLocalISOString(d)).toBe('2018-01-05T03:07:09');
  });

  it('includes seconds even when zero (the drift fix)', () => {
    const d = new Date(2020, 10, 30, 23, 0, 0);
    expect(toLocalISOString(d)).toBe('2020-11-30T23:00:00');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/time.test.ts`
Expected: FAIL — cannot find module `./time`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/time.ts`:
```ts
export function toLocalISOString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/time.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/time.ts web/src/shared/time.test.ts
git commit -m "feat(web): add shared time module (unified toLocalISOString)"
```

---

## Task 3: `format.ts` — number/byte/duration/date formatting

**Files:**
- Create: `web/src/shared/format.ts`
- Test: `web/src/shared/format.test.ts`

Ports `formatBytes`/`formatNumber`/`formatDuration`/`formatDateTime` from `index.html:382-414`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatBytes, formatNumber, formatDuration } from './format';

describe('format', () => {
  it('formats bytes with unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB');
  });

  it('formats numbers with K/M suffix', () => {
    expect(formatNumber(500)).toBe('500');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(2_000_000)).toBe('2.0M');
  });

  it('formats durations', () => {
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/format.test.ts`
Expected: FAIL — cannot find module `./format`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/format.ts`:
```ts
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

export function formatNumber(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/format.ts web/src/shared/format.test.ts
git commit -m "feat(web): add shared format module"
```

---

## Task 4: `config.ts` — URL config base64 round-trip

**Files:**
- Create: `web/src/shared/config.ts`
- Test: `web/src/shared/config.test.ts`

Ports `configToBase64`/`base64ToConfig` from `plot.html:1930-1938` (also duplicated in `index.html:442`). Uses URL-safe base64.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { configToBase64, base64ToConfig } from './config';

describe('config base64', () => {
  it('round-trips an object', () => {
    const cfg = { version: 1, plots: [{ products: [{ path: 'amda/x' }] }] };
    expect(base64ToConfig(configToBase64(cfg))).toEqual(cfg);
  });

  it('produces URL-safe output (no +, /, or = padding)', () => {
    const cfg = { s: '???>>>ÿÿÿ' };
    const encoded = configToBase64(cfg);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64ToConfig(encoded)).toEqual(cfg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/config.ts`:
```ts
export function configToBase64(config: unknown): string {
  return btoa(JSON.stringify(config))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64ToConfig<T = unknown>(b64: string): T {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded)) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/config.ts web/src/shared/config.test.ts
git commit -m "feat(web): add shared config (URL base64) module"
```

---

## Task 5: `magnetosphere.ts` — 3D physics math

**Files:**
- Create: `web/src/shared/magnetosphere.ts`
- Test: `web/src/shared/magnetosphere.test.ts`

Ports `shueParams` (`demo_3d.html:654`), `classifyPoint` (`:516`), `toReData` (`:536`), `computeAxisRange` (`:637`), and the `EARTH_RADIUS_KM`/`MAX_DISTANCE_RE` constants. The page's `currentBoundaryParams` (which reads DOM sliders) stays in the page and calls `shueParams`/`bowShockParams`; the shared `toReData`/`classifyPoint` take boundary params explicitly (no hidden DOM dependency).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  shueParams,
  bowShockParams,
  classifyPoint,
  toReData,
  computeAxisRange,
  EARTH_RADIUS_KM,
} from './magnetosphere';

describe('magnetosphere', () => {
  it('computes Shue 1998 r0/alpha for nominal solar wind', () => {
    const { r0, alpha } = shueParams(2, 0);
    expect(r0).toBeCloseTo(10.0, 0); // ~10 Re subsolar standoff
    expect(alpha).toBeGreaterThan(0.5);
    expect(alpha).toBeLessThan(0.7);
  });

  it('classifies the subsolar point inside the magnetosphere', () => {
    const mp = shueParams(2, 0);
    const bs = bowShockParams(mp);
    // A point near Earth on the +X axis is inside the magnetopause.
    expect(classifyPoint(3, 0, 0, mp, bs)).toBe(0);
    // A far upstream point is in the solar wind.
    expect(classifyPoint(60, 0, 0, mp, bs)).toBe(2);
  });

  it('converts km to Re, drops too-distant and non-finite points', () => {
    const mp = shueParams(2, 0);
    const bs = bowShockParams(mp);
    const km = [
      [EARTH_RADIUS_KM * 3, 0, 0],        // 3 Re -> kept
      [EARTH_RADIUS_KM * 1000, 0, 0],     // 1000 Re -> dropped (> MAX_DISTANCE_RE)
      [NaN, 0, 0],                        // dropped
    ];
    const re = toReData(km, mp, bs);
    expect(re).toHaveLength(1);
    expect(re[0][0]).toBeCloseTo(3, 6);
    expect(re[0]).toHaveLength(4); // [x, y, z, region]
  });

  it('computes a symmetric axis range padded by 10%', () => {
    const range = computeAxisRange([[[5, -3, 0, 0], [1, 8, -2, 0]]]);
    expect(range.min).toBe(-range.max);
    expect(range.max).toBeGreaterThanOrEqual(9); // ceil(8 * 1.1)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/magnetosphere.test.ts`
Expected: FAIL — cannot find module `./magnetosphere`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/magnetosphere.ts`:
```ts
export const EARTH_RADIUS_KM = 6371.0;
export const MAX_DISTANCE_RE = 500;

// Region classification: 0 = magnetosphere, 1 = magnetosheath, 2 = solar wind
export type Region = 0 | 1 | 2;
export type RePoint = [number, number, number, Region];

export interface BoundaryParams {
  r0: number;
  alpha: number;
}

// Shue et al. 1998 magnetopause
export function shueParams(Dp: number, Bz: number): BoundaryParams {
  const r0 = (10.22 + 1.29 * Math.tanh(0.184 * (Bz + 8.14))) * Math.pow(Dp, -1.0 / 6.6);
  const alpha = (0.58 - 0.007 * Bz) * (1 + 0.024 * Math.log(Dp));
  return { r0, alpha };
}

// Bow shock: scaled from magnetopause (Farris & Russell 1994 approx)
export function bowShockParams(mp: BoundaryParams): BoundaryParams {
  return { r0: mp.r0 * 1.28, alpha: mp.alpha * 1.05 };
}

export function classifyPoint(
  x: number, y: number, z: number,
  mp: BoundaryParams, bs: BoundaryParams,
): Region {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-6) return 0;
  const cosTheta = x / r;
  const rMp = mp.r0 * Math.pow(2 / (1 + cosTheta), mp.alpha);
  if (r <= rMp) return 0;
  const rBs = bs.r0 * Math.pow(2 / (1 + cosTheta), bs.alpha);
  if (r <= rBs) return 1;
  return 2;
}

export function toReData(
  values: ReadonlyArray<ArrayLike<number>>,
  mp: BoundaryParams, bs: BoundaryParams,
): RePoint[] {
  const result: RePoint[] = [];
  for (const p of values) {
    const x = p[0] / EARTH_RADIUS_KM;
    const y = p[1] / EARTH_RADIUS_KM;
    const z = p[2] / EARTH_RADIUS_KM;
    if (x * x + y * y + z * z > MAX_DISTANCE_RE * MAX_DISTANCE_RE) continue;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    result.push([x, y, z, classifyPoint(x, y, z, mp, bs)]);
  }
  return result;
}

export function computeAxisRange(
  pointSets: ReadonlyArray<ReadonlyArray<ArrayLike<number>>>,
): { min: number; max: number } {
  let maxAbs = 2;
  for (const set of pointSets) {
    for (const p of set) {
      for (let i = 0; i < 3; i++) {
        const v = Math.abs(p[i]);
        if (v > maxAbs) maxAbs = v;
      }
    }
  }
  maxAbs = Math.ceil(maxAbs * 1.1);
  return { min: -maxAbs, max: maxAbs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/magnetosphere.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/magnetosphere.ts web/src/shared/magnetosphere.test.ts
git commit -m "feat(web): add shared magnetosphere physics module"
```

---

## Task 6: `merge.ts` — data merge / eviction / series helpers

**Files:**
- Create: `web/src/shared/merge.ts`
- Test: `web/src/shared/merge.test.ts`

Ports `mergeSorted` (`plot.html:1097`), `mergeSortedRows` (`:1073`), `mergeIntervals` (`:1139`), `evictProductCache` (`:952`), `buildSeriesData` (`:1668`). These operate on a `ProductCache` shape; the cache type is defined here so the page can import it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mergeSorted, mergeSortedRows, mergeIntervals, buildSeriesData } from './merge';

describe('merge', () => {
  it('mergeSorted interleaves by time, preferring new on ties', () => {
    const r = mergeSorted([1, 3], [2, 3], { a: [10, 30] }, [[20], [99]], ['a']);
    expect(r.times).toEqual([1, 2, 3]);
    expect(r.columns.a).toEqual([10, 20, 99]); // tie at t=3 keeps new (99)
  });

  it('mergeSortedRows interleaves whole rows by time', () => {
    const r = mergeSortedRows([1, 4], [2], [[1, 1], [4, 4]], [[2, 2]]);
    expect(r.times).toEqual([1, 2, 4]);
    expect(r.rows).toEqual([[1, 1], [2, 2], [4, 4]]);
  });

  it('mergeIntervals coalesces overlapping spans', () => {
    expect(mergeIntervals([[1, 3], [2, 5], [10, 12]])).toEqual([[1, 5], [10, 12]]);
  });

  it('buildSeriesData zips times and values into [t, v] pairs', () => {
    expect(buildSeriesData([1, 2], [10, 20])).toEqual([[1, 10], [2, 20]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/merge.test.ts`
Expected: FAIL — cannot find module `./merge`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/merge.ts`:
```ts
export interface ProductCache {
  path: string;
  intervals: Array<[number, number]>;
  times: number[];
  columns: Record<string, number[]>;
  columnNames: string[];
  unit: string;
  yAxis: number[] | number[][] | null;
  yAxisName: string;
  yAxisUnit: string;
  rows: number[][];
  displayType: string;
}

export function mergeSortedRows(
  oldTimes: number[], newTimes: number[],
  oldRows: number[][], newRows: number[][],
): { times: number[]; rows: number[][] } {
  const resultTimes: number[] = [];
  const resultRows: number[][] = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) {
      resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++;
    } else if (oldTimes[i] > newTimes[j]) {
      resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++;
    } else {
      resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); i++; j++;
    }
  }
  while (i < oldTimes.length) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
  while (j < newTimes.length) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
  return { times: resultTimes, rows: resultRows };
}

export function mergeSorted(
  oldTimes: number[], newTimes: number[],
  oldColumns: Record<string, number[]>, newValues: number[][], columnNames: string[],
): { times: number[]; columns: Record<string, number[]> } {
  const resultTimes: number[] = [];
  const resultColumns: Record<string, number[]> = {};
  for (const cn of columnNames) resultColumns[cn] = [];

  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) {
      resultTimes.push(oldTimes[i]);
      for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
      i++;
    } else if (oldTimes[i] > newTimes[j]) {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      j++;
    } else {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      i++; j++;
    }
  }
  while (i < oldTimes.length) {
    resultTimes.push(oldTimes[i]);
    for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
    i++;
  }
  while (j < newTimes.length) {
    resultTimes.push(newTimes[j]);
    for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
    j++;
  }
  return { times: resultTimes, columns: resultColumns };
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [intervals[0].slice() as [number, number]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) {
      last[1] = Math.max(last[1], intervals[i][1]);
    } else {
      merged.push(intervals[i].slice() as [number, number]);
    }
  }
  return merged;
}

export function evictProductCache(cache: ProductCache, maxPoints: number): void {
  if (cache.times.length <= maxPoints) return;
  const excess = cache.times.length - maxPoints;
  cache.times = cache.times.slice(excess);
  if (cache.rows.length > 0) {
    cache.rows = cache.rows.slice(excess);
  } else {
    for (const cn of cache.columnNames) {
      cache.columns[cn] = cache.columns[cn].slice(excess);
    }
  }
  if (cache.times.length > 0) {
    const newStart = cache.times[0];
    cache.intervals = cache.intervals
      .map((iv) => [Math.max(iv[0], newStart), iv[1]] as [number, number])
      .filter((iv) => iv[1] > iv[0]);
  }
}

export function buildSeriesData(times: number[], values: number[]): Array<[number, number]> {
  const data: Array<[number, number]> = new Array(times.length);
  for (let i = 0; i < times.length; i++) data[i] = [times[i], values[i]];
  return data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/merge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/merge.ts web/src/shared/merge.test.ts
git commit -m "feat(web): add shared merge/eviction/series module"
```

---

## Task 7: `spectrogram.ts` — viridis LUT, y-edges, image render

**Files:**
- Create: `web/src/shared/spectrogram.ts`
- Test: `web/src/shared/spectrogram.test.ts`

Ports `VIRIDIS`/`VIRIDIS_LUT` (`plot.html:1677-1702`), `computeYEdges` (`:1463`), `renderSpectrogramImage` (`:1704`). `renderSpectrogramImage` now takes an explicit `view` argument instead of reading the page's `currentView` global. The canvas render itself is not unit-tested (no DOM in the node test env); the LUT and `computeYEdges` are.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { VIRIDIS_LUT, computeYEdges } from './spectrogram';

describe('spectrogram', () => {
  it('builds a 256-entry RGB viridis LUT with correct endpoints', () => {
    expect(VIRIDIS_LUT).toHaveLength(256 * 3);
    // viridis starts dark purple (68,1,84) and ends yellow (253,231,37)
    expect([VIRIDIS_LUT[0], VIRIDIS_LUT[1], VIRIDIS_LUT[2]]).toEqual([68, 1, 84]);
    expect([VIRIDIS_LUT[765], VIRIDIS_LUT[766], VIRIDIS_LUT[767]]).toEqual([253, 231, 37]);
  });

  it('computes bin edges around centers', () => {
    const edges = computeYEdges([1, 2, 3]);
    expect(edges).toHaveLength(4);
    expect(edges[1]).toBeCloseTo(1.5, 6);
    expect(edges[2]).toBeCloseTo(2.5, 6);
    expect(edges[0]).toBeCloseTo(0.5, 6);
    expect(edges[3]).toBeCloseTo(3.5, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/spectrogram.test.ts`
Expected: FAIL — cannot find module `./spectrogram`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/spectrogram.ts`:
```ts
// Viridis-like colormap as RGB stops for interpolation
const VIRIDIS: Array<[number, [number, number, number]]> = [
  [0.0, [68, 1, 84]], [0.1, [72, 40, 120]], [0.2, [62, 73, 137]],
  [0.3, [49, 104, 142]], [0.4, [38, 130, 142]], [0.5, [31, 158, 137]],
  [0.6, [53, 183, 121]], [0.7, [110, 206, 88]], [0.8, [181, 222, 43]],
  [0.9, [229, 228, 32]], [1.0, [253, 231, 37]],
];

// Pre-computed 256-entry viridis LUT (R,G,B as flat Uint8Array)
export const VIRIDIS_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    for (; j < VIRIDIS.length - 1; j++) {
      if (t <= VIRIDIS[j + 1][0]) break;
    }
    const f = (t - VIRIDIS[j][0]) / (VIRIDIS[j + 1][0] - VIRIDIS[j][0]);
    const a = VIRIDIS[j][1], c = VIRIDIS[j + 1][1];
    lut[i * 3] = Math.round(a[0] + f * (c[0] - a[0]));
    lut[i * 3 + 1] = Math.round(a[1] + f * (c[1] - a[1]));
    lut[i * 3 + 2] = Math.round(a[2] + f * (c[2] - a[2]));
  }
  return lut;
})();

export function computeYEdges(yBinsFlat: number[]): number[] {
  const yEdges = new Array<number>(yBinsFlat.length + 1);
  for (let i = 1; i < yBinsFlat.length; i++) {
    yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
  }
  yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
  yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
    (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length - 1] - yBinsFlat[yBinsFlat.length - 2]) / 2 : 0.5);
  return yEdges;
}

export interface SpectrogramView {
  start: number | null;
  end: number | null;
}

export interface SpectrogramImage {
  canvas: HTMLCanvasElement;
  tStart: number;
  tEnd: number;
  yMin: number;
  yMax: number;
}

export function renderSpectrogramImage(
  times: number[], rows: number[][], yBinsFlat: number[],
  vMin: number, vMax: number, logScaleParam: boolean,
  view: SpectrogramView,
): SpectrogramImage | null {
  const v = (view.start != null && view.end != null)
    ? { start: view.start, end: view.end }
    : { start: times[0], end: times[times.length - 1] };

  const viewRange = v.end - v.start;
  const renderStart = v.start - viewRange * 0.5;
  const renderEnd = v.end + viewRange * 0.5;

  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < renderStart) lo = mid + 1; else hi = mid;
  }
  const iStart = lo;
  lo = iStart; hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= renderEnd) lo = mid + 1; else hi = mid;
  }
  const iEnd = lo;

  const nTime = iEnd - iStart;
  const nY = yBinsFlat.length;
  if (nTime <= 0 || nY <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = nTime;
  canvas.height = nY;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(nTime, nY);
  const pixels = imgData.data;

  const logVMin = Math.log10(Math.max(vMin, 1e-30));
  const logVMax = Math.log10(vMax);

  for (let t = 0; t < nTime; t++) {
    const row = rows[iStart + t];
    if (!row) continue;
    for (let y = 0; y < nY; y++) {
      const val = row[y];
      if (val == null || isNaN(val) || val <= 0) continue;
      let norm: number;
      if (logScaleParam) {
        norm = (Math.log10(val) - logVMin) / (logVMax - logVMin);
      } else {
        norm = (val - vMin) / (vMax - vMin);
      }
      const li = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      const py = (nY - 1 - y);
      const idx = (py * nTime + t) * 4;
      pixels[idx] = VIRIDIS_LUT[li];
      pixels[idx + 1] = VIRIDIS_LUT[li + 1];
      pixels[idx + 2] = VIRIDIS_LUT[li + 2];
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return {
    canvas,
    tStart: times[iStart],
    tEnd: times[Math.min(iEnd, times.length) - 1],
    yMin: yBinsFlat[0],
    yMax: yBinsFlat[nY - 1],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/spectrogram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/spectrogram.ts web/src/shared/spectrogram.test.ts
git commit -m "feat(web): add shared spectrogram render module"
```

---

## Task 8: `inventory.ts` — speasy `__spz_*` schema primitives

**Files:**
- Create: `web/src/shared/inventory.ts`
- Test: `web/src/shared/inventory.test.ts`

Extracts the **mechanically shared** inventory primitives. To preserve each page's exact tree behavior, the page-specific skip-sets stay in the pages; this module shares only `getDisplayName` (`plot.html:519` / `demo_3d.html:807`), `getProductPath` (`plot.html:523` / `demo_3d.html:812`, with an optional default provider for the SSC case), `isSpzMetaKey` (the `__spz_` prefix check used by `demo_3d.html:781`), `hasVisibleChildren` (`demo_3d.html:784`), and `isParameterIndex` (plot's leaf test).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  isSpzMetaKey, getDisplayName, getProductPath, hasVisibleChildren, isParameterIndex,
  type SpzNode,
} from './inventory';

describe('inventory primitives', () => {
  it('detects __spz_ meta keys', () => {
    expect(isSpzMetaKey('__spz_uid__')).toBe(true);
    expect(isSpzMetaKey('Cluster')).toBe(false);
  });

  it('resolves display name with fallbacks', () => {
    expect(getDisplayName({ __spz_name__: 'B GSM' } as SpzNode, 'k')).toBe('B GSM');
    expect(getDisplayName({ name: 'fallback' } as SpzNode, 'k')).toBe('fallback');
    expect(getDisplayName({} as SpzNode, 'key-fallback')).toBe('key-fallback');
  });

  it('builds product path, honoring a default provider', () => {
    expect(getProductPath({ __spz_provider__: 'amda', __spz_uid__: 'x' } as SpzNode)).toBe('amda/x');
    expect(getProductPath({ __spz_uid__: 'ace' } as SpzNode, 'ssc')).toBe('ssc/ace');
  });

  it('detects visible (non-meta) children', () => {
    expect(hasVisibleChildren({ __spz_uid__: 'x', child: {} } as SpzNode)).toBe(true);
    expect(hasVisibleChildren({ __spz_uid__: 'x' } as SpzNode)).toBe(false);
  });

  it('detects a ParameterIndex leaf', () => {
    expect(isParameterIndex({ __spz_type__: 'ParameterIndex' } as SpzNode)).toBe(true);
    expect(isParameterIndex({ __spz_type__: 'CatalogIndex' } as SpzNode)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/shared/inventory.test.ts`
Expected: FAIL — cannot find module `./inventory`.

- [ ] **Step 3: Write the implementation**

`web/src/shared/inventory.ts`:
```ts
export interface SpzNode {
  __spz_type__?: string;
  __spz_name__?: string;
  __spz_provider__?: string;
  __spz_uid__?: string;
  name?: string;
  [key: string]: unknown;
}

export function isSpzMetaKey(key: string): boolean {
  return key.startsWith('__spz_');
}

export function getDisplayName(node: SpzNode, key: string): string {
  return (node && (node.__spz_name__ || node.name)) || key;
}

export function getProductPath(node: SpzNode, defaultProvider?: string): string {
  const provider = node.__spz_provider__ || defaultProvider;
  return provider + '/' + node.__spz_uid__;
}

export function hasVisibleChildren(
  node: unknown,
  isMeta: (key: string) => boolean = isSpzMetaKey,
): boolean {
  if (typeof node !== 'object' || node === null) return false;
  return Object.keys(node).some((k) => !isMeta(k));
}

export function isParameterIndex(node: SpzNode): boolean {
  return node.__spz_type__ === 'ParameterIndex';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/shared/inventory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/shared/inventory.ts web/src/shared/inventory.test.ts
git commit -m "feat(web): add shared inventory schema primitives"
```

---

## Task 9: `speasyData.ts` + `apiClient.ts` — data model, NaN-safe decode, codec seam

**Files:**
- Create: `web/src/shared/speasyData.ts`
- Create: `web/src/shared/apiClient.ts`
- Test: `web/src/shared/speasyData.test.ts`
- Test: `web/src/shared/apiClient.test.ts`

`speasyData.ts` defines the normalized `SpeasyData` model, the NaN-safe JSON decode (`plot.html:1059`), and `detectPlotType` (`plot.html:1063`). `apiClient.ts` builds the `/get_data` URL (unifying `plot.html:1042` and `demo_3d.html:1037`) and exposes the **codec seam**: `fetchData(opts, codec=jsonCodec)`. The `Codec` interface takes a `Response` so a future CDF codec can read `arrayBuffer()` instead of `text()`.

- [ ] **Step 1: Write the failing tests**

`web/src/shared/speasyData.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodeJson, detectPlotType } from './speasyData';

describe('speasyData', () => {
  it('parses JSON with bare NaN tokens (the proxy emits NaN)', () => {
    const data = decodeJson('{"axes":[{"values":[1,2]}],"values":{"values":[[NaN],[3]]}}');
    expect(data.values.values[0][0]).toBeNull();
    expect(data.values.values[1][0]).toBe(3);
  });

  it('detects heatmap from DISPLAY_TYPE', () => {
    const d = { axes: [{ values: [] }, { values: [] }], values: { values: [[1]], meta: { DISPLAY_TYPE: 'spectrogram' } } };
    expect(detectPlotType(d as any)).toBe('heatmap');
  });

  it('detects heatmap from wide multi-axis data', () => {
    const wide = { axes: [{ values: [] }, { values: [] }], values: { values: [new Array(15).fill(0)] } };
    expect(detectPlotType(wide as any)).toBe('heatmap');
  });

  it('defaults to line', () => {
    const d = { axes: [{ values: [] }], values: { values: [[1, 2]] } };
    expect(detectPlotType(d as any)).toBe('line');
  });
});
```

`web/src/shared/apiClient.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildDataUrl } from './apiClient';

describe('buildDataUrl', () => {
  it('builds a JSON get_data URL with required params', () => {
    const url = buildDataUrl({
      baseUrl: 'https://h/cache/', path: 'amda/b gsm',
      startISO: '2018-01-01T00:00:00.000Z', stopISO: '2018-01-02T00:00:00.000Z',
      maxPoints: 5000,
    });
    expect(url).toContain('format=json');
    expect(url).toContain('path=amda%2Fb%20gsm');
    expect(url).toContain('max_points=5000');
    expect(url).not.toContain('coordinate_system');
  });

  it('appends coordinate_system when provided', () => {
    const url = buildDataUrl({
      baseUrl: 'https://h/cache/', path: 'ssc/ace',
      startISO: 'a', stopISO: 'b', maxPoints: 100, coordinateSystem: 'GSE',
    });
    expect(url).toContain('coordinate_system=GSE');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/shared/speasyData.test.ts src/shared/apiClient.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write `web/src/shared/speasyData.ts`**

```ts
export interface SpeasyAxis {
  values: number[] | number[][];
  name?: string;
  meta?: Record<string, unknown>;
}

export interface SpeasyValues {
  values: number[][];
  meta?: Record<string, unknown>;
}

export interface SpeasyData {
  axes: SpeasyAxis[];
  values: SpeasyValues;
  columns?: string[];
}

// The proxy's json format emits bare `NaN` tokens; sanitize before JSON.parse.
export function decodeJson(text: string): SpeasyData {
  return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
}

export function detectPlotType(json: SpeasyData): 'line' | 'heatmap' {
  const meta = json.values.meta || {};
  const displayType = String(meta.DISPLAY_TYPE || '').toLowerCase();
  const numCols = json.values.values.length > 0 ? json.values.values[0].length : 0;
  if (displayType === 'spectrogram' || (numCols > 10 && json.axes.length >= 2)) {
    return 'heatmap';
  }
  return 'line';
}
```

- [ ] **Step 4: Write `web/src/shared/apiClient.ts`**

```ts
import { decodeJson, type SpeasyData } from './speasyData';

export interface FetchDataOptions {
  baseUrl: string;        // ends with '/'
  path: string;
  startISO: string;
  stopISO: string;
  maxPoints: number;
  coordinateSystem?: string;
  signal?: AbortSignal;
}

export function buildDataUrl(o: FetchDataOptions): string {
  let url =
    o.baseUrl + 'get_data?format=json&path=' + encodeURIComponent(o.path) +
    '&start_time=' + encodeURIComponent(o.startISO) +
    '&stop_time=' + encodeURIComponent(o.stopISO) +
    '&max_points=' + o.maxPoints;
  if (o.coordinateSystem) url += '&coordinate_system=' + encodeURIComponent(o.coordinateSystem);
  return url;
}

// Codec seam: a future CDF/WASM codec implements the same interface and reads
// resp.arrayBuffer() instead of resp.text(). Pages only ever see SpeasyData.
export interface Codec {
  decode(resp: Response): Promise<SpeasyData>;
}

export const jsonCodec: Codec = {
  async decode(resp: Response): Promise<SpeasyData> {
    return decodeJson(await resp.text());
  },
};

export async function fetchData(o: FetchDataOptions, codec: Codec = jsonCodec): Promise<SpeasyData> {
  const resp = await fetch(buildDataUrl(o), o.signal ? { signal: o.signal } : undefined);
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`;
    try {
      const err = await resp.json();
      msg = err.error || err.detail || msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return codec.decode(resp);
}

export async function fetchInventory(baseUrl: string, provider: string): Promise<unknown> {
  const resp = await fetch(baseUrl + 'get_inventory?format=json&provider=' + provider);
  if (!resp.ok) throw new Error('Server returned ' + resp.status);
  return decodeJson(await resp.text());
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/shared/speasyData.test.ts src/shared/apiClient.test.ts`
Expected: PASS (speasyData 4, apiClient 2).

- [ ] **Step 6: Run the whole shared test suite + typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: all tests pass; `tsc --noEmit` reports no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/shared/speasyData.ts web/src/shared/speasyData.test.ts web/src/shared/apiClient.ts web/src/shared/apiClient.test.ts
git commit -m "feat(web): add SpeasyData model + apiClient codec seam"
```

---

## Task 10: Relocate `index.html` script into `pages/index.ts`

**Files:**
- Create: `web/src/pages/index.ts`
- Modify: `speasy_proxy/templates/index.html`

The smallest page — done first as the lowest-risk relocation. The inline `<script>` body is `index.html:381-477`.

- [ ] **Step 1: Create `web/src/pages/index.ts` from the inline script**

Copy the JavaScript inside `index.html`'s `<script>` (lines 382-476, i.e. everything between `<script>` and `</script>`) verbatim into `web/src/pages/index.ts`, then prepend the `@ts-nocheck` pragma and the shared imports, and **delete** the now-duplicated local definitions of `formatBytes`, `formatNumber`, `formatDuration`, `formatDateTime`, and `configToBase64`.

The file should begin:
```ts
// @ts-nocheck
import { formatBytes, formatNumber, formatDuration, formatDateTime } from '../shared/format';
import { configToBase64 } from '../shared/config';
```
…followed by the remaining page code (`setValue`, `updateStatus`, `loadPresets`, and the bottom `updateStatus(); setInterval(updateStatus, 10000); loadPresets();`). The five deleted functions are replaced by the imports above — confirm no remaining `function formatBytes`/`function configToBase64` etc. definitions exist in the file.

- [ ] **Step 2: Replace the inline script in `index.html`**

In `speasy_proxy/templates/index.html`, replace the entire `<script>…</script>` block (lines 381-477) with:
```html
<script type="module" src="{{ base_url }}/static/js/index.js"></script>
```
Leave the small inline `<script>document.write(new Date().getFullYear())</script>` in the footer (line 377) as-is. Do NOT touch the `<style>` block (index's CSS is page-specific, not shared).

- [ ] **Step 3: Build and verify the bundle is produced**

Run: `cd web && npm run build`
Expected: build succeeds; `speasy_proxy/static/js/index.js` exists. (Note: `plot.js`/`demo_3d.js` entries don't exist yet, so the build will fail on missing inputs — to unblock, temporarily create empty stubs `web/src/pages/plot.ts` and `web/src/pages/demo_3d.ts` each containing `// @ts-nocheck\nexport {};` so the build completes. These stubs are fleshed out in Tasks 11-12.)

- [ ] **Step 4: Smoke-test the home page**

Run (from repo root, separate terminal):
```bash
SPEASY_PROXY_OFFLINE_TESTS=1 uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/`. Expected: status cards populate (or show `—` offline), no console errors referencing `index.js`. Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/index.ts web/src/pages/plot.ts web/src/pages/demo_3d.ts speasy_proxy/templates/index.html speasy_proxy/static/js/index.js
git commit -m "refactor(web): move index.html script into pages/index.ts module"
```

---

## Task 11: Relocate `demo_3d.html` script into `pages/demo_3d.ts`

**Files:**
- Modify (replace stub): `web/src/pages/demo_3d.ts`
- Modify: `speasy_proxy/templates/demo_3d.html`

The inline `<script>` body is `demo_3d.html:502-1304`. Relocate it verbatim, then swap duplicated leaf logic for shared imports.

- [ ] **Step 1: Populate `web/src/pages/demo_3d.ts`**

Copy the JavaScript inside `demo_3d.html`'s `<script>` (lines 503-1303) verbatim into `web/src/pages/demo_3d.ts`. Prepend:
```ts
// @ts-nocheck
import { toLocalISOString } from '../shared/time';
import {
  shueParams, bowShockParams, classifyPoint,
  toReData as sharedToReData, computeAxisRange,
  EARTH_RADIUS_KM, MAX_DISTANCE_RE,
} from '../shared/magnetosphere';
import { fetchData as apiFetchData, fetchInventory } from '../shared/apiClient';
import { isSpzMetaKey } from '../shared/inventory';
```

Then make these edits in the relocated body:

1. **Delete** the local `const EARTH_RADIUS_KM = 6371.0;` and `const MAX_DISTANCE_RE = 500;` (now imported).
2. **Delete** the local `function classifyPoint`, `function shueParams`, `function computeAxisRange`, and `function toLocalISOString` (now imported).
3. **Replace** `currentBoundaryParams` so its bow-shock derivation uses the shared helper:
```ts
function currentBoundaryParams() {
  const Dp = parseFloat(document.getElementById('dpSlider').value);
  const Bz = parseFloat(document.getElementById('bzSlider').value);
  const mp = shueParams(Dp, Bz);
  const bs = bowShockParams(mp);
  return { mp, bs };
}
```
4. **Replace** the local `function toReData(values)` body to delegate to the shared one:
```ts
function toReData(values) {
  const { mp, bs } = currentBoundaryParams();
  return sharedToReData(values, mp, bs);
}
```
5. **Replace** the call `const range = computeAxisRange();` inside `updateChartOption` with:
```ts
const range = computeAxisRange([...trajectories.values()].map((t) => t.data));
```
6. **Replace** the two manual fetch+parse blocks (in `onToggleSatellite` around `demo_3d.html:1043-1048` and in `replotAll` around `:1103-1108`). In each, the lines:
```ts
const resp = await fetch(url);
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const json = await resp.json();
const values = json.values.values;
const reData = toReData(values);
```
become (using the shared client, which is NaN-safe — fixing the demo_3d raw-parse bug):
```ts
const data = await apiFetchData({
  baseUrl: API_BASE, path: uid, startISO, stopISO,
  maxPoints: 10000, coordinateSystem: coordSys,
});
const reData = toReData(data.values.values);
```
Delete the now-unused `const url = ...` lines that built the get_data URL by hand in those two blocks. (Keep the surrounding `try/catch/finally`, status updates, and color/trajectory bookkeeping unchanged.)
7. **Replace** `function isMetadataKey(key)` to reuse the shared prefix check:
```ts
function isMetadataKey(key) {
  return isSpzMetaKey(key) || METADATA_KEYS.has(key);
}
```
(Keep the local `METADATA_KEYS` set — it is demo_3d-specific.)
8. **Replace** the inventory fetch in `loadInventory` (`demo_3d.html:1286-1288`):
```ts
const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=ssc');
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const inv = await resp.json();
```
with:
```ts
const inv = await fetchInventory(API_BASE, 'ssc');
```

- [ ] **Step 2: Replace the inline script in `demo_3d.html`**

In `speasy_proxy/templates/demo_3d.html`, replace the entire `<script>…</script>` block at lines 502-1304 (the one starting `const API_BASE = '{{ base_url }}/';`) with:
```html
<script type="module" src="{{ base_url }}/static/js/demo_3d.js"></script>
```
**Keep** the two ECharts CDN `<script>` tags in `<head>` (lines 7-8) — they define the `echarts`/`echarts-gl` globals the module relies on. Do NOT touch the `<style>` block yet (CSS extraction is Task 13).

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: build succeeds; `speasy_proxy/static/js/demo_3d.js` exists.

- [ ] **Step 4: Smoke-test the 3D viewer**

Run (repo root):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
(No `SPEASY_PROXY_OFFLINE_TESTS` here — the 3D viewer needs the SSC inventory + a real trajectory fetch.) Open `http://localhost:8099/demo_3d`. Verify, with the browser console open and no errors:
- The satellite tree loads and is searchable.
- Checking a satellite plots its orbit (a colored line) and the Earth renders textured.
- Toggling **Magnetopause** / **Bow Shock** shows the surfaces and recolors trajectories by region.
- The **Reset / XY / XZ / YZ** view buttons reorient the camera.
- The **Dp** / **Bz** sliders update the boundary shape.
Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/demo_3d.ts speasy_proxy/templates/demo_3d.html speasy_proxy/static/js/demo_3d.js
git commit -m "refactor(web): move demo_3d script into module; share physics + NaN-safe fetch"
```

---

## Task 12: Relocate `plot.html` script into `pages/plot.ts`

**Files:**
- Modify (replace stub): `web/src/pages/plot.ts`
- Modify: `speasy_proxy/templates/plot.html`

The inline `<script>` body is `plot.html:405-2251`. Relocate it verbatim, then swap duplicated leaf logic for shared imports.

- [ ] **Step 1: Populate `web/src/pages/plot.ts`**

Copy the JavaScript inside `plot.html`'s `<script>` (lines 406-2250) verbatim into `web/src/pages/plot.ts`. Prepend:
```ts
// @ts-nocheck
import { toLocalISOString } from '../shared/time';
import { configToBase64, base64ToConfig } from '../shared/config';
import { getDisplayName, getProductPath } from '../shared/inventory';
import { detectPlotType } from '../shared/speasyData';
import {
  mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache, buildSeriesData,
} from '../shared/merge';
import { computeYEdges, renderSpectrogramImage } from '../shared/spectrogram';
import { fetchData as apiFetchData, fetchInventory } from '../shared/apiClient';
```

Then make these edits in the relocated body:

1. **Delete** the local definitions of: `toLocalISOString` (`:501`), `getDisplayName` (`:519`), `getProductPath` (`:523`), `detectPlotType` (`:1063`), `mergeSortedRows` (`:1073`), `mergeSorted` (`:1097`), `mergeIntervals` (`:1139`), `evictProductCache` (`:952`), `buildSeriesData` (`:1668`), `computeYEdges` (`:1463`), `configToBase64` (`:1930`), `base64ToConfig` (`:1935`), and the `VIRIDIS`/`VIRIDIS_LUT` constants (`:1677-1702`) and `renderSpectrogramImage` (`:1704`). All are now imported. Keep `escapeHtml`, `fallbackCopy`, `shouldSkipNode`, `SKIP_KEYS`, `CHART_COLORS`, and everything else.
2. **Update the `evictProductCache` call sites.** The shared signature is `evictProductCache(cache, maxPoints)`; the page currently calls `evictProductCache(cache)` relying on a module-global `MAX_CACHE_POINTS`. Change each call (in `onMultiZoomPan`, `plot.html:1642`) to:
```ts
evictProductCache(subplot.productData[prod.path], MAX_CACHE_POINTS);
```
3. **Update the `renderSpectrogramImage` call.** The shared signature adds an explicit `view` argument. In `buildSubplotHeatmap` (`plot.html:1494`), change:
```ts
const img = renderSpectrogramImage(cache.times, cache.rows, yBinsFlat, vMin, vMax, subplot.logScale);
```
to:
```ts
const img = renderSpectrogramImage(cache.times, cache.rows, yBinsFlat, vMin, vMax, subplot.logScale, currentView);
```
4. **Replace the local `fetchData`** (`plot.html:1039-1061`) so it delegates URL-building + NaN-safe parsing to the shared client while keeping the page's width-based `max_points` logic:
```ts
async function fetchData(product, startTime, stopTime, signal) {
  const startISO = new Date(startTime).toISOString();
  const stopISO = new Date(stopTime).toISOString();
  const maxPoints = Math.max(
    10000,
    (document.getElementById('chart')?.clientWidth || 2000) * (1 + 2 * BUFFER_RATIO),
  );
  return apiFetchData({ baseUrl: API_BASE, path: product, startISO, stopISO, maxPoints, signal });
}
```
(`BUFFER_RATIO` is declared later in the file at `:1781`; it is hoisted as a `const` in module scope and remains accessible — keep its declaration where it is.)
5. **Replace the inventory fetch** in `loadInventory` (`plot.html:557-559`):
```ts
const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=all');
if (!resp.ok) throw new Error('Server returned ' + resp.status);
inventory = JSON.parse(await resp.text());
```
with:
```ts
inventory = await fetchInventory(API_BASE, 'all');
```

- [ ] **Step 2: Replace the inline script in `plot.html`**

In `speasy_proxy/templates/plot.html`, replace the entire `<script>…</script>` block at lines 405-2251 (the one starting `const BASE_URL = '{{ base_url }}';`) with:
```html
<script type="module" src="{{ base_url }}/static/js/plot.js"></script>
```
**Keep** the ECharts CDN `<script>` in `<head>` (line 7). Do NOT touch the `<style>` block yet (CSS extraction is Task 13).

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: build succeeds; `speasy_proxy/static/js/plot.js` exists.

- [ ] **Step 4: Smoke-test the plot viewer**

Run (repo root):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/plot`. With the console open and no errors, verify:
- Inventory tree loads; product search filters results.
- Selecting a 1-D product and clicking **Plot** draws a line series.
- Selecting a spectrogram product renders a heatmap image with the viridis colormap.
- Mouse-wheel pan and ctrl+wheel zoom trigger a re-fetch (fetch bar appears) and the view stays smooth.
- **Add to plot** creates/append subplots; **Log Y** / **Log Z** toggle scales.
- **Share** produces a URL; opening it in a new tab restores the same plot (`?config=` round-trip).
Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/plot.ts speasy_proxy/templates/plot.html speasy_proxy/static/js/plot.js
git commit -m "refactor(web): move plot script into module; consume shared modules"
```

---

## Task 13: Extract shared viewer CSS into `theme.css`

**Files:**
- Create: `speasy_proxy/static/css/theme.css`
- Modify: `speasy_proxy/templates/plot.html`
- Modify: `speasy_proxy/templates/demo_3d.html`

`plot.html` (`:8-327`) and `demo_3d.html` (`:9-420`) share ~250 lines of identical "chrome" CSS. Extract the shared rules into one stylesheet both link. Page-specific rules stay inline.

- [ ] **Step 1: Create `speasy_proxy/static/css/theme.css`**

Populate it with the rules that are byte-identical between the two templates' `<style>` blocks. These are: the universal reset (`*, *::before, *::after`), `body`, `.sidebar`, `.sidebar.collapsed`, `.sidebar-collapse-btn` (+ `:hover`), `.sidebar-header` (+ `.back-link`, `h2`, `input[type="text"]`, `:focus`), `.tree-container`, `.main`, `.controls-bar` (+ `.collapsed`), `.controls-collapse-btn` (+ `:hover`), `.controls-bar label`, the shared `.controls-bar input` rules, `.chart-wrapper`, `.chart-loading-overlay` (+ `.visible`, `.spinner`), `@keyframes spin`, `.fetch-bar` (+ `.active`), `@keyframes fetch-bar-slide`, and `.status-bar`. Copy them verbatim from `plot.html`'s `<style>`.

- [ ] **Step 2: Link `theme.css` and remove the duplicated rules from `plot.html`**

In `speasy_proxy/templates/plot.html` `<head>`, add before the existing `<style>`:
```html
<link rel="stylesheet" href="{{ base_url }}/static/css/theme.css">
```
Then delete the rules from the inline `<style>` that now live in `theme.css` (the ones listed in Step 1). **Keep** plot-specific rules: `#chart`, `.resize-handle` (+ states), the `@media (max-width: 768px)` block, `.add-dropdown-item` (+ `:hover`), and any rule whose selector/value differs from `theme.css`.

- [ ] **Step 3: Link `theme.css` and remove the duplicated rules from `demo_3d.html`**

In `speasy_proxy/templates/demo_3d.html` `<head>`, add before the existing `<style>`:
```html
<link rel="stylesheet" href="{{ base_url }}/static/css/theme.css">
```
Then delete the rules from the inline `<style>` that now live in `theme.css`. **Keep** demo_3d-specific rules: `.tree-container ul`/`li`, `.tree-node` (+ children, checkbox, swatch, states), `#chart3d`, `.controls-bar select`, `.controls-sep`, `.controls-bar input[type="range"]`, `.controls-value`, `.duration-btns` (+ buttons/states), the scrollbar styling, and the `@media (max-width: 700px)` block (demo_3d's mobile rules differ from plot's).

- [ ] **Step 4: Smoke-test both pages for visual parity**

Run (repo root):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/plot` and `http://localhost:8099/demo_3d`. Verify both look **identical to before** the CSS move: dark theme, sidebar, controls bar, collapse buttons, status bar, spinner/fetch-bar all styled correctly. Check the browser Network tab shows `theme.css` loaded (200). Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/css/theme.css speasy_proxy/templates/plot.html speasy_proxy/templates/demo_3d.html
git commit -m "refactor(web): extract shared viewer chrome into theme.css"
```

---

## Task 14: Full verification pass + developer docs

**Files:**
- Modify: `CLAUDE.md`
- Create: `web/README.md`

- [ ] **Step 1: Run the full JS suite, typecheck, and a clean build**

Run:
```bash
cd web && npm test && npm run typecheck && npm run build
```
Expected: all Vitest suites pass; `tsc --noEmit` clean; build writes `plot.js`, `demo_3d.js`, `index.js` to `speasy_proxy/static/js/`.

- [ ] **Step 2: Confirm committed bundles are current**

Run (repo root):
```bash
git status --short speasy_proxy/static/js/
```
Expected: empty output (the freshly built bundles match what's committed). If not empty, `git add` and re-commit the bundles.

- [ ] **Step 3: Confirm the Python suite is unaffected**

Run (repo root):
```bash
SPEASY_PROXY_OFFLINE_TESTS=1 uv run pytest speasy_proxy/
```
Expected: same pass count as before the refactor (no regressions).

- [ ] **Step 4: Write `web/README.md`**

```markdown
# Frontend source (`web/`)

TypeScript source for the interactive viewer pages, built by Vite into committed
bundles under `speasy_proxy/static/js/`. The Python app serves those bundles; it
does **not** need Node at runtime.

## Layout
- `src/shared/` — framework-free, strict-typed, unit-tested modules shared by the pages.
- `src/pages/` — per-page entry modules (`plot`, `demo_3d`, `index`), loose-typed.
- `src/shared/*.test.ts` — Vitest unit tests (pure logic).

## Workflow (run from `web/`)
- `npm install` — once, to get dev deps.
- `npm test` — run the unit tests.
- `npm run typecheck` — `tsc --noEmit` (strict for shared/, pages are `@ts-nocheck`).
- `npm run build` — rebuild the committed bundles in `speasy_proxy/static/js/`.

## Important
After editing anything under `web/src/`, run `npm run build` and **commit the updated
bundles in `speasy_proxy/static/js/`** along with your source change. The shared theme
CSS lives at `speasy_proxy/static/css/theme.css` (hand-maintained, not built by Vite).
```

- [ ] **Step 5: Update `CLAUDE.md`**

Add a "Frontend (`web/`)" subsection under the Architecture section documenting: the `web/` TS source tree, that bundles are built by Vite into `speasy_proxy/static/js/` and committed, that the deploy needs no Node, the `npm test` / `npm run build` workflow, and the rule to rebuild+commit bundles after any `web/src/` change. Also correct the stale "Currently no test files exist" claim if present.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md web/README.md
git commit -m "docs: document the web/ frontend build + test workflow"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Toolchain (Vite/TS/Vitest), committed bundles, no Node in deploy → Task 1, 14. ✓
- All 9 shared modules with tests → Tasks 2-9. ✓
- Codec seam returning `SpeasyData`, JSON decoder shipped, CDF as extension point → Task 9. ✓
- Page entry modules (relocated verbatim, leaves swapped, `@ts-nocheck`) → Tasks 10-12. ✓
- Templates load module bundles + theme.css → Tasks 10-13. ✓
- Shared theme CSS extraction → Task 13. ✓
- Strict shared / loose pages typing → Task 1 (tsconfig) + `@ts-nocheck` in Tasks 10-12. ✓
- Smoke-test both pages against live server → Tasks 11, 12, 13. ✓
- Python suite unaffected; docs → Task 14. ✓
- Drift-bug fixes (seconds in time; NaN-safe demo_3d fetch; unified inventory primitives) → Tasks 2, 9, 11, 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows concrete code or an exact verbatim-relocation instruction with line refs. ✓

**Type/name consistency:** `evictProductCache(cache, maxPoints)`, `renderSpectrogramImage(..., view)`, `toReData(values, mp, bs)`, `bowShockParams(mp)`, `computeAxisRange(pointSets)`, `fetchData(opts, codec)`, `fetchInventory(baseUrl, provider)`, `Codec.decode(resp)` are referenced identically across defining (Tasks 5-9) and consuming (Tasks 11-12) tasks. Bundle paths are `speasy_proxy/static/js/<name>.js` everywhere; CSS is `speasy_proxy/static/css/theme.css` everywhere. ✓

**Path note:** Output is `static/js/` (not `dist/`) because `.gitignore` ignores `dist/`; `web/node_modules/` is added to `.gitignore` in Task 1.
