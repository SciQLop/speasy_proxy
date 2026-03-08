# 3D Trajectory Demo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/demo_3d` page that renders satellite orbits in 3D using ECharts GL, with SSCWeb inventory browsing and coordinate system selection.

**Architecture:** Single new HTML template served by one new route. All data fetched client-side from existing `/get_data` and `/get_inventory` endpoints. No backend data logic changes.

**Tech Stack:** ECharts v5 + echarts-gl (CDN), FastAPI/Jinja2 (existing), vanilla JS

---

### Task 1: Add the `/demo_3d` route

**Files:**
- Modify: `speasy_proxy/frontend/home.py:33-36` (add route after existing `/plot` route)

**Step 1: Add the route handler**

Add this after the `plot()` function in `home.py`:

```python
@router.get('/demo_3d', response_class=HTMLResponse)
def demo_3d(request: Request, x_scheme: Annotated[str | None, Header()] = None):
    base_url = _build_base_url(request, x_scheme)
    return templates.TemplateResponse(request, name="demo_3d.html", context={"request": request, 'base_url': base_url})
```

**Step 2: Commit**

```bash
git add speasy_proxy/frontend/home.py
git commit -m "feat: add /demo_3d route"
```

---

### Task 2: Create the `demo_3d.html` template — page skeleton and styles

**Files:**
- Create: `speasy_proxy/templates/demo_3d.html`

**Step 1: Create the HTML file with layout and CSS**

Create `speasy_proxy/templates/demo_3d.html` with:

- `<head>`: ECharts v5 CDN + echarts-gl CDN (`https://cdn.jsdelivr.net/npm/echarts-gl@2/dist/echarts-gl.min.js`)
- Dark theme CSS matching `plot.html` (background `#0b0e17`, sidebar `#111627`, border `#1e2640`, text `#e0e6f0`)
- Layout: sidebar (320px) + main chart container (flex: 1)
- Sidebar sections:
  1. Search input for filtering the inventory tree
  2. Scrollable inventory tree container
  3. Controls section: coordinate system `<select>` (options: GSE, GSM, GEO, GM, SM, GEITOD, GEIJ2000), start/stop `<input type="datetime-local">`, "Plot" button
  4. "Plotted satellites" list (empty initially)
- Main area: `<div id="chart3d">` filling remaining space
- Status bar at bottom

**Step 2: Commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "feat: demo_3d page skeleton with layout and styles"
```

---

### Task 3: Inventory tree — load and render SSCWeb satellites

**Files:**
- Modify: `speasy_proxy/templates/demo_3d.html` (add JS)

**Step 1: Add inventory loading and tree rendering JS**

Add `<script>` at bottom of body with:

```javascript
const API_BASE = '{{ base_url }}/';
let inventory = {};
let selectedSatellite = null;

async function loadInventory() {
    const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=ssc');
    inventory = JSON.parse(await resp.text());
    renderTree(inventory);
}
```

Tree rendering logic:
- Recursively render the SSCWeb inventory as nested collapsible `<ul>/<li>` elements
- Skip metadata keys (those starting with `__spz_` or known metadata like `UNITS`, `FILLVAL`, etc.)
- Leaf nodes (items with `__spz_uid__` containing a product path) are clickable — clicking sets `selectedSatellite` to the `__spz_uid__` value and highlights the node
- If a leaf has `start_date`/`stop_date`, populate the time inputs with those values as defaults

Search filtering:
- Filter tree nodes by text input (case-insensitive substring match on `__spz_name__`)
- Show/hide branches that don't match

Call `loadInventory()` on page load.

**Step 2: Commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "feat: demo_3d inventory tree with search"
```

---

### Task 4: ECharts 3D scene — Earth sphere and axes

**Files:**
- Modify: `speasy_proxy/templates/demo_3d.html` (add JS)

**Step 1: Initialize ECharts GL with Earth and axes**

```javascript
const RE = 6371.0; // km
const chart = echarts.init(document.getElementById('chart3d'), 'dark');

const COLORS = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc'];
let colorIndex = 0;
let trajectories = []; // {name, path, series, color}

function buildOption() {
    const series = [];

    // Earth sphere: surface3D parametric
    series.push({
        type: 'surface',
        parametric: true,
        wireframe: { show: false },
        shading: 'color',
        itemStyle: { color: '#2255aa', opacity: 0.6 },
        parametricEquation: {
            u: { min: 0, max: Math.PI, step: Math.PI / 20 },
            v: { min: 0, max: 2 * Math.PI, step: Math.PI / 20 },
            x: (u, v) => Math.sin(u) * Math.cos(v),
            y: (u, v) => Math.sin(u) * Math.sin(v),
            z: (u, v) => Math.cos(u),
        }
    });

    // Add all trajectory series
    trajectories.forEach(t => series.push(t.series));

    return {
        xAxis3D: { name: 'X (Re)' },
        yAxis3D: { name: 'Y (Re)' },
        zAxis3D: { name: 'Z (Re)' },
        grid3D: {
            viewControl: { autoRotate: false },
            boxWidth: 100, boxHeight: 100, boxDepth: 100
        },
        series
    };
}

chart.setOption(buildOption());
new ResizeObserver(() => chart.resize()).observe(document.getElementById('chart3d'));
```

**Step 2: Commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "feat: demo_3d 3D scene with Earth sphere"
```

---

### Task 5: Fetch trajectory data and render as line3D

**Files:**
- Modify: `speasy_proxy/templates/demo_3d.html` (add JS)

**Step 1: Add data fetching and trajectory rendering**

Wire the "Plot" button click handler:

```javascript
async function plotTrajectory() {
    if (!selectedSatellite) return;
    const coordSys = document.getElementById('coord-select').value;
    const start = document.getElementById('start-time').value;
    const stop = document.getElementById('stop-time').value;
    if (!start || !stop) return;

    const startISO = new Date(start).toISOString();
    const stopISO = new Date(stop).toISOString();
    const url = `${API_BASE}get_data?path=${encodeURIComponent(selectedSatellite)}&format=json&coordinate_system=${coordSys}&start_time=${encodeURIComponent(startISO)}&stop_time=${encodeURIComponent(stopISO)}`;

    setStatus('Fetching data...');
    const resp = await fetch(url);
    const data = JSON.parse(await resp.text());

    // data.values.values is [[x_km, y_km, z_km], ...]
    const points = data.values.values.map(p => [p[0] / RE, p[1] / RE, p[2] / RE]);
    const color = COLORS[colorIndex % COLORS.length];
    colorIndex++;

    const name = selectedSatellite.split('/').pop();
    const series = {
        type: 'line3D',
        name: name,
        data: points,
        lineStyle: { width: 2, color: color }
    };

    trajectories.push({ name, path: selectedSatellite, series, color });
    chart.setOption(buildOption());
    updatePlottedList();
    setStatus('Ready');
}

document.getElementById('plot-btn').addEventListener('click', plotTrajectory);
```

**Step 2: Add the "plotted satellites" list management**

```javascript
function updatePlottedList() {
    const container = document.getElementById('plotted-list');
    container.innerHTML = '';
    trajectories.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'plotted-item';
        row.innerHTML = `
            <span class="color-swatch" style="background:${t.color}"></span>
            <span>${t.name}</span>
            <button class="remove-btn" data-index="${i}">&times;</button>
        `;
        row.querySelector('.remove-btn').addEventListener('click', () => {
            trajectories.splice(i, 1);
            chart.setOption(buildOption(), true);
            updatePlottedList();
        });
        container.appendChild(row);
    });
}
```

CSS for `.plotted-item`, `.color-swatch`, `.remove-btn` should be added to the `<style>` block.

**Step 3: Add status bar helper**

```javascript
function setStatus(msg) {
    document.getElementById('status-bar').textContent = msg;
}
```

**Step 4: Commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "feat: demo_3d trajectory fetching and rendering"
```

---

### Task 6: Polish and verify

**Files:**
- Modify: `speasy_proxy/templates/demo_3d.html` (minor tweaks)

**Step 1: Run the dev server and test**

```bash
uv run uvicorn speasy_proxy:app --reload
```

Open `http://localhost:8000/demo_3d` in browser. Verify:
- Inventory tree loads with SSCWeb satellites
- Search filters work
- Selecting a satellite + time range + coordinate system + clicking Plot renders a 3D orbit
- Earth sphere visible at origin
- Multiple satellites can be plotted with distinct colors
- Remove button works
- 3D rotation/zoom/pan works

**Step 2: Fix any issues found during testing**

**Step 3: Final commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "feat: polish demo_3d page"
```

---

### Summary of files changed

| File | Action |
|------|--------|
| `speasy_proxy/frontend/home.py` | Add `/demo_3d` route (4 lines) |
| `speasy_proxy/templates/demo_3d.html` | Create (~400 lines: HTML + CSS + JS) |
