import { attachDatePicker, setDateInput, parseDateInput, setStatus, showLoading, showFetchBar, installErrorBoundary, runWithConcurrency, CHART_COLORS, REGION_COLORS } from './common.js';
import {
  shueParams, bowShockParams, classifyPoint,
  toReData as sharedToReData, computeAxisRange,
} from './magnetosphere.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
import { isSpzMetaKey, hasVisibleChildren, SKIP_KEYS } from './inventory-tree.js';

const API_BASE = (window.SPEASY_BASE_URL || '').replace(/\/$/, '') + '/';
    function currentBoundaryParams() {
  const Dp = parseFloat(document.getElementById('dpSlider').value);
  const Bz = parseFloat(document.getElementById('bzSlider').value);
  const mp = shueParams(Dp, Bz);
  const bs = bowShockParams(mp);
  return { mp, bs };
}

    function toReData(values) {
  const { mp, bs } = currentBoundaryParams();
  return sharedToReData(values, mp, bs);
}

    function reclassifyAllTrajectories() {
        const { mp, bs } = currentBoundaryParams();
        for (const t of trajectories.values()) {
            for (const p of t.data) {
                p[3] = classifyPoint(p[0], p[1], p[2], mp, bs);
            }
        }
    }

    // uid -> { name, color, data, uid }
    const trajectories = new Map();
    let colorIndex = 0;
    let chart = null;

    // ---- Earth texture ----
    // Pre-computed color lookup table indexed by parametric UV. The parametric surface
    // callback fires per-vertex on every frame (64k vertices) — pre-computing the color
    // grid once at load time and doing a fast array lookup per frame is orders of
    // magnitude cheaper than sampling the texture per-vertex.
    let earthColorLUT = null;  // { lut: string[], cols: number, rows: number } | null

    function loadEarthTexture() {
        return new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const w = img.naturalWidth, h = img.naturalHeight;
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const pixels = ctx.getImageData(0, 0, w, h).data;
                earthColorLUT = buildEarthColorLUT(pixels, w, h);
                resolve(true);
            };
            img.onerror = () => resolve(false);
            img.src = API_BASE + 'static/earth_bluemarble.jpg';
        });
    }

    function buildEarthColorLUT(pixels, w, h) {
        // Grid resolution: fine enough that adjacent vertices land in the same cell
        // (the surface steps at PI/180, so 360 x 180 covers it with margin).
        const cols = 360;
        const rows = 180;
        const lut = new Array(cols * rows);
        for (let ry = 0; ry < rows; ry++) {
            // Map row to latitude: ry=0 → north pole (lat=PI/2), ry=rows-1 → south pole
            const lat = (Math.PI / 2) * (1 - ry / (rows - 1));
            const py = Math.floor(((Math.PI / 2 - lat) / Math.PI) * (h - 1));
            for (let cx = 0; cx < cols; cx++) {
                // Map column to longitude: cx=0 → -PI, cx=cols-1 → +PI
                const lon = Math.PI * (2 * cx / cols - 1);
                const px = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * (w - 1));
                const i = (py * w + px) * 4;
                lut[ry * cols + cx] = `rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})`;
            }
        }
        return { lut, cols, rows };
    }

    function sampleEarthColor(x, y, z) {
        if (!earthColorLUT) return '#2255aa';
        const r = Math.sqrt(x * x + y * y + z * z) || 1;
        const lat = Math.asin(Math.max(-1, Math.min(1, z / r)));
        const lon = Math.atan2(y, x);
        const cx = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * earthColorLUT.cols);
        const ry = Math.floor(((Math.PI / 2 - lat) / Math.PI) * earthColorLUT.rows);
        const clampedCx = Math.max(0, Math.min(earthColorLUT.cols - 1, cx));
        const clampedRy = Math.max(0, Math.min(earthColorLUT.rows - 1, ry));
        return earthColorLUT.lut[clampedRy * earthColorLUT.cols + clampedCx];
    }

    // ---- Chart ----
    function initChart() {
        chart = echarts.init(document.getElementById('chart3d'), 'dark');
        initChartOption();
        new ResizeObserver(() => chart.resize()).observe(document.getElementById('chart3d'));
    }

    function earthSeries() {
        return {
            type: 'surface',
            parametric: true,
            wireframe: { show: false },
            shading: earthColorLUT ? 'lambert' : 'color',
            itemStyle: earthColorLUT
                ? { color: params => sampleEarthColor(params.value[0], params.value[1], params.value[2]) }
                : { color: '#2255aa', opacity: 0.6 },
            parametricEquation: {
                u: { min: 0, max: Math.PI, step: Math.PI / 180 },
                v: { min: 0, max: 2 * Math.PI, step: Math.PI / 180 },
                x: (u, v) => Math.sin(u) * Math.cos(v),
                y: (u, v) => Math.sin(u) * Math.sin(v),
                z: (u, v) => Math.cos(u)
            },
            silent: true
        };
    }

    // ---- Magnetosphere models ----

    // Shue et al. 1998 magnetopause
    function magnetopauseSeries(Dp, Bz) {
        const { r0, alpha } = shueParams(Dp, Bz);
        const thetaMax = 0.95 * Math.PI;
        return {
            type: 'surface',
            parametric: true,
            wireframe: { show: true, lineStyle: { color: 'rgba(100,180,255,0.6)', width: 1 } },
            shading: 'color',
            itemStyle: { color: 'rgba(100,180,255,0.35)', opacity: 0.35 },
            parametricEquation: {
                u: { min: 0, max: thetaMax, step: thetaMax / 40 },
                v: { min: 0, max: 2 * Math.PI, step: Math.PI / 20 },
                x: (u, v) => { const r = r0 * Math.pow(2 / (1 + Math.cos(u)), alpha); return r * Math.cos(u); },
                y: (u, v) => { const r = r0 * Math.pow(2 / (1 + Math.cos(u)), alpha); return r * Math.sin(u) * Math.cos(v); },
                z: (u, v) => { const r = r0 * Math.pow(2 / (1 + Math.cos(u)), alpha); return r * Math.sin(u) * Math.sin(v); }
            },
            silent: true
        };
    }

    // Bow shock: scaled from magnetopause (Farris & Russell 1994 approx)
    function bowShockSeries(Dp, Bz) {
        const { r0, alpha } = shueParams(Dp, Bz);
        const r0_bs = r0 * 1.28;
        const alpha_bs = alpha * 1.05;
        const thetaMax = 0.85 * Math.PI;
        return {
            type: 'surface',
            parametric: true,
            wireframe: { show: true, lineStyle: { color: 'rgba(255,140,100,0.6)', width: 1 } },
            shading: 'color',
            itemStyle: { color: 'rgba(255,140,100,0.30)', opacity: 0.30 },
            parametricEquation: {
                u: { min: 0, max: thetaMax, step: thetaMax / 40 },
                v: { min: 0, max: 2 * Math.PI, step: Math.PI / 20 },
                x: (u, v) => { const r = r0_bs * Math.pow(2 / (1 + Math.cos(u)), alpha_bs); return r * Math.cos(u); },
                y: (u, v) => { const r = r0_bs * Math.pow(2 / (1 + Math.cos(u)), alpha_bs); return r * Math.sin(u) * Math.cos(v); },
                z: (u, v) => { const r = r0_bs * Math.pow(2 / (1 + Math.cos(u)), alpha_bs); return r * Math.sin(u) * Math.sin(v); }
            },
            silent: true
        };
    }

    function magnetosphereSeries(Dp, Bz) {
        const series = [];
        if (document.getElementById('showMagnetopause').checked) series.push(magnetopauseSeries(Dp, Bz));
        if (document.getElementById('showBowShock').checked) series.push(bowShockSeries(Dp, Bz));
        return series;
    }

    function initChartOption() {
        chart.setOption({
            xAxis3D: { name: 'X (Re)' },
            yAxis3D: { name: 'Y (Re)' },
            zAxis3D: { name: 'Z (Re)' },
            grid3D: {
                boxWidth: 100, boxHeight: 100, boxDepth: 100,
                viewControl: { autoRotate: false, distance: 150, minDistance: 0.5, maxDistance: 5000 },
                light: {
                    main: { intensity: 1.2, shadow: false },
                    ambient: { intensity: 0.4 }
                }
            },
            series: [earthSeries(), ...magnetosphereSeries(2, 0)]
        });
    }

    function updateChartOption() {
        const Dp = parseFloat(document.getElementById('dpSlider').value);
        const Bz = parseFloat(document.getElementById('bzSlider').value);
        const showBoundaries = document.getElementById('showMagnetopause').checked
                            || document.getElementById('showBowShock').checked;
        const trajSeries = Array.from(trajectories.values()).map((t, i) => {
            const s = {
                type: 'line3D',
                name: t.name,
                data: t.data,
                lineStyle: { width: 2 },
                silent: true
            };
            if (showBoundaries) {
                s.lineStyle.color = REGION_COLORS[0];
                s.visualMap = false;
            } else {
                s.lineStyle.color = t.color;
            }
            return s;
        });
        const range = computeAxisRange([...trajectories.values()].map((t) => t.data));
        const opts = {
            xAxis3D: { min: range.min, max: range.max },
            yAxis3D: { min: range.min, max: range.max },
            zAxis3D: { min: range.min, max: range.max },
            series: [earthSeries(), ...magnetosphereSeries(Dp, Bz), ...trajSeries]
        };
        if (showBoundaries && trajSeries.length > 0) {
            opts.visualMap = {
                show: true,
                type: 'piecewise',
                dimension: 3,
                pieces: [
                    { value: 0, label: 'Magnetosphere', color: REGION_COLORS[0] },
                    { value: 1, label: 'Magnetosheath', color: REGION_COLORS[1] },
                    { value: 2, label: 'Solar Wind', color: REGION_COLORS[2] }
                ],
                seriesIndex: trajSeries.map((_, i) => i + 1 + magnetosphereSeries(Dp, Bz).length),
                orient: 'horizontal',
                bottom: 10,
                left: 'center',
                textStyle: { color: '#8892b0' }
            };
        } else {
            opts.visualMap = [];
        }
        chart.setOption(opts, { replaceMerge: ['series', 'visualMap'] });
    }

    // Lightweight slider feedback: update only the magnetopause/bow shock surfaces
    // (series indices 1..N) without rebuilding trajectories or the whole option.
    // The surfaces are cheap (parametric ~40x40 grids), so this stays at 60fps
    // during a drag; reclassifying trajectories would be far more expensive.
    // NOTE: trajectories must be included in the series array — replaceMerge would
    // drop any series not listed here, making them flicker out during the drag.
    function updateMagnetoSurfaces() {
        if (!chart) return;
        const Dp = parseFloat(document.getElementById('dpSlider').value);
        const Bz = parseFloat(document.getElementById('bzSlider').value);
        const showBoundaries = document.getElementById('showMagnetopause').checked
                            || document.getElementById('showBowShock').checked;
        const trajSeries = Array.from(trajectories.values()).map((t) => ({
            type: 'line3D',
            name: t.name,
            data: t.data,
            lineStyle: { width: 2, color: showBoundaries ? REGION_COLORS[0] : t.color },
            silent: true,
        }));
        // Also update axis ranges so enlarging Dp/Bz doesn't clip the surfaces
        // mid-drag (the full updateChartOption on 'change' will refine them).
        const range = computeAxisRange([...trajectories.values()].map((t) => t.data));
        chart.setOption({
            xAxis3D: { min: range.min, max: range.max },
            yAxis3D: { min: range.min, max: range.max },
            zAxis3D: { min: range.min, max: range.max },
            series: [earthSeries(), ...magnetosphereSeries(Dp, Bz), ...trajSeries],
        }, { replaceMerge: ['series'] });
    }

    // uid -> true for satellites currently being fetched (for the legend spinner)
    const loadingUids = new Set();

    function renderLegend() {
        const el = document.getElementById('trajectory-legend');
        if (trajectories.size === 0 && loadingUids.size === 0) {
            el.style.display = 'none';
            return;
        }
        el.innerHTML = '';
        el.style.display = 'block';
        for (const [uid, t] of trajectories) {
            const item = document.createElement('div');
            item.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            swatch.style.background = t.color;
            const name = document.createElement('span');
            name.className = 'legend-name';
            name.textContent = t.name;
            name.title = t.name;
            item.appendChild(swatch);
            item.appendChild(name);
            el.appendChild(item);
        }
        for (const uid of loadingUids) {
            const item = document.createElement('div');
            item.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            swatch.style.background = '#555e7e';
            const name = document.createElement('span');
            name.className = 'legend-name legend-loading';
            name.textContent = uid.split('/').pop() + '…';
            item.appendChild(swatch);
            item.appendChild(name);
            el.appendChild(item);
        }
    }

    function updateActionButtons() {
        const hasTrajectories = trajectories.size > 0;
        document.getElementById('btn-clear').style.display = hasTrajectories ? '' : 'none';
        document.getElementById('btn-export-png').style.display = hasTrajectories ? '' : 'none';
    }

    function clearAllTrajectories() {
        trajectories.clear();
        loadingUids.clear();
        colorIndex = 0;
        for (const cb of document.querySelectorAll('.tree-node input[type="checkbox"][data-uid]')) {
            cb.checked = false;
            const span = cb.closest('.tree-node');
            span.classList.remove('plotted');
            const swatch = span.querySelector('.color-swatch');
            if (swatch) swatch.style.display = 'none';
        }
        syncGroupCheckboxes();
        updateChartOption();
        updateActionButtons();
        renderLegend();
        setStatus('Cleared all trajectories.');
        updateURL();
    }

    function exportPng() {
        if (!chart || trajectories.size === 0) return;
        const url = chart.getDataURL({ pixelRatio: 2, backgroundColor: '#0b0e17' });
        const a = document.createElement('a');
        a.href = url;
        a.download = 'speasy-orbit.png';
        a.click();
    }

    // ---- Inventory tree ----
    function isMetadataKey(key) {
  return isSpzMetaKey(key) || SKIP_KEYS.has(key);
}

    function nodeHasVisibleChildren(node) {
        return hasVisibleChildren(node, isMetadataKey);
    }

    function isLeaf(node) {
        return node && typeof node === 'object' && '__spz_uid__' in node && !nodeHasVisibleChildren(node);
    }

    function findTimeBounds(node) {
        if (!node || typeof node !== 'object') return null;
        if (node.start_date && node.stop_date) return { start: node.start_date, stop: node.stop_date };
        return null;
    }

    function extractGroupName(groupId) {
        if (!groupId || typeof groupId !== 'string') return null;
        const parts = groupId.split('/');
        return parts[parts.length - 1] || null;
    }

    function makeLeafNode(val, key, parentNode) {
        const li = document.createElement('li');
        const displayName = val.__spz_name__ || key;
        li.dataset.name = displayName.toLowerCase();

        const span = document.createElement('div');
        span.className = 'tree-node';
        const uid = (val.__spz_provider__ || 'ssc') + '/' + val.__spz_uid__;
        const bounds = findTimeBounds(val) || findTimeBounds(parentNode) || {};

        const toggle = document.createElement('span');
        toggle.className = 'toggle';
        toggle.textContent = ' ';
        span.appendChild(toggle);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.uid = uid;
        cb.dataset.timeBoundsJson = JSON.stringify(bounds);
        span.appendChild(cb);

        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        span.appendChild(swatch);

        span.appendChild(document.createTextNode(displayName));

        cb.addEventListener('change', () => onToggleSatellite(cb, span, swatch));
        span.addEventListener('click', (e) => {
            if (e.target === cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
        });

        li.appendChild(span);
        return li;
    }

    function makeFolderNode(name, children) {
        const li = document.createElement('li');
        li.dataset.name = name.toLowerCase();

        const span = document.createElement('div');
        span.className = 'tree-node';
        const toggle = document.createElement('span');
        toggle.className = 'toggle';
        toggle.textContent = '▶';
        span.appendChild(toggle);

        const groupCb = document.createElement('input');
        groupCb.type = 'checkbox';
        groupCb.className = 'group-checkbox';
        span.appendChild(groupCb);

        span.appendChild(document.createTextNode(name));

        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        const ul = document.createElement('ul');
        children.forEach(child => ul.appendChild(child));
        childContainer.appendChild(ul);

        groupCb.addEventListener('change', () => {
            const leafCbs = childContainer.querySelectorAll('input[type="checkbox"][data-uid]');
            if (groupCb.checked && !document.getElementById('stopTime').value) {
                let minStop = null;
                for (const cb of leafCbs) {
                    try {
                        const bounds = JSON.parse(cb.dataset.timeBoundsJson || '{}');
                        if (bounds.stop) {
                            const t = new Date(bounds.stop).getTime();
                            if (minStop === null || t < minStop) minStop = t;
                        }
                    } catch (_) {}
                }
                if (minStop !== null) {
                    const stop = new Date(minStop);
                    const start = new Date(minStop - getSelectedDurationMs());
                    setDateInput(document.getElementById('stopTime'), stop);
                    setDateInput(document.getElementById('startTime'), start);
                }
            }
            for (const cb of leafCbs) {
                if (cb.checked !== groupCb.checked) {
                    cb.checked = groupCb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            }
        });

        span.addEventListener('click', (e) => {
            if (e.target === groupCb) return;
            const open = childContainer.classList.toggle('open');
            toggle.textContent = open ? '▼' : '▶';
        });

        li.appendChild(span);
        li.appendChild(childContainer);
        return li;
    }

    function makeCollapsibleNode(name, buildChildren) {
        const li = document.createElement('li');
        li.dataset.name = name.toLowerCase();
        const span = document.createElement('div');
        span.className = 'tree-node';
        const toggle = document.createElement('span');
        toggle.className = 'toggle';
        toggle.textContent = '▶';
        span.appendChild(toggle);
        span.appendChild(document.createTextNode(name));

        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        buildChildren(childContainer);

        span.addEventListener('click', () => {
            const open = childContainer.classList.toggle('open');
            toggle.textContent = open ? '▼' : '▶';
        });
        li.appendChild(span);
        li.appendChild(childContainer);
        return li;
    }

    function buildGroupedLeaves(childKeys, val) {
        const groups = new Map();
        const ungrouped = [];
        for (const k of childKeys) {
            const child = val[k];
            const groupName = extractGroupName(child.GroupId);
            if (groupName) {
                if (!groups.has(groupName)) groups.set(groupName, []);
                groups.get(groupName).push({ key: k, val: child });
            } else {
                ungrouped.push({ key: k, val: child });
            }
        }

        const innerUl = document.createElement('ul');
        const sortedGroups = [...groups.entries()]
            .filter(([, members]) => members.length > 1)
            .sort((a, b) => a[0].localeCompare(b[0]));
        for (const [groupName, members] of sortedGroups) {
            const leafNodes = members
                .sort((a, b) => (a.val.__spz_name__ || a.key).localeCompare(b.val.__spz_name__ || b.key))
                .map(m => makeLeafNode(m.val, m.key, val));
            innerUl.appendChild(makeFolderNode(groupName, leafNodes));
        }

        const singleGroupMembers = [...groups.entries()]
            .filter(([, members]) => members.length === 1)
            .map(([, members]) => members[0]);
        const allFlat = [...ungrouped, ...singleGroupMembers]
            .sort((a, b) => (a.val.__spz_name__ || a.key).localeCompare(b.val.__spz_name__ || b.key));
        for (const item of allFlat) {
            innerUl.appendChild(makeLeafNode(item.val, item.key, val));
        }
        return innerUl;
    }

    function buildTree(obj, parentEl, parentNode) {
        const ul = document.createElement('ul');

        for (const key of Object.keys(obj)) {
            if (isMetadataKey(key)) continue;
            const val = obj[key];
            if (typeof val !== 'object' || val === null) continue;

            if (isLeaf(val)) {
                ul.appendChild(makeLeafNode(val, key, parentNode));
            } else if (nodeHasVisibleChildren(val)) {
                const displayName = val.__spz_name__ || key;
                const childKeys = Object.keys(val).filter(k => !isMetadataKey(k) && typeof val[k] === 'object' && val[k] !== null);
                const allChildrenLeaves = childKeys.length > 0 && childKeys.every(k => isLeaf(val[k]));

                if (allChildrenLeaves) {
                    ul.appendChild(makeCollapsibleNode(displayName, container => {
                        container.appendChild(buildGroupedLeaves(childKeys, val));
                    }));
                } else {
                    ul.appendChild(makeCollapsibleNode(displayName, container => {
                        buildTree(val, container, val);
                    }));
                }
            }
        }
        parentEl.appendChild(ul);
    }

    async function onToggleSatellite(cb, span, swatch) {
        const uid = cb.dataset.uid;

        if (!cb.checked) {
            trajectories.delete(uid);
            span.classList.remove('plotted');
            swatch.style.display = 'none';
            updateChartOption();
            updateActionButtons();
            renderLegend();
            setStatus(`Removed ${uid.split('/').pop()}.`);
            updateURL();
            syncGroupCheckboxes();
            return;
        }

        // Validate time window; auto-fill from inventory bounds if unset.
        const startVal = document.getElementById('startTime').value;
        const stopVal = document.getElementById('stopTime').value;
        if (!startVal || !stopVal) {
            try {
                const bounds = JSON.parse(cb.dataset.timeBoundsJson || '{}');
                if (bounds.start) {
                    const e = new Date(bounds.stop || bounds.start);
                    const s = new Date(e.getTime() - getSelectedDurationMs());
                    setDateInput(document.getElementById('startTime'), s);
                    setDateInput(document.getElementById('stopTime'), e);
                } else {
                    cb.checked = false;
                    setStatus('Set start and stop times first.');
                    return;
                }
            } catch (_) {
                cb.checked = false;
                setStatus('Set start and stop times first.');
                return;
            }
        }

        const coordSys = document.getElementById('coordSys').value;
        const startDate = parseDateInput(document.getElementById('startTime').value);
        const stopDate = parseDateInput(document.getElementById('stopTime').value);
        if (!startDate || !stopDate) {
            cb.checked = false;
            setStatus('Please set valid start and stop times (DD-MM-YYYY HH:MM).');
            return;
        }
        const startISO = startDate.toISOString();
        const stopISO = stopDate.toISOString();
        if (startDate >= stopDate) {
            cb.checked = false;
            setStatus('Start time must be before stop time.');
            return;
        }

        await fetchSatellite(uid, cb, span, swatch, coordSys, startISO, stopISO);
        syncGroupCheckboxes();
    }

    async function fetchTrajectoryData(uid, coordSys, startISO, stopISO) {
        const data = await apiFetchData({
            baseUrl: API_BASE, path: uid, startISO, stopISO,
            maxPoints: 10000, coordinateSystem: coordSys,
        });
        return { reData: toReData(data.values.values) };
    }

    function fetchSatellite(uid, cb, span, swatch, coordSys, startISO, stopISO) {
        span.classList.add('loading');
        loadingUids.add(uid);
        showLoading(true);
        showFetchBar(true);
        renderLegend();
        setStatus(`Fetching ${uid.split('/').pop()}...`);
        return fetchTrajectoryData(uid, coordSys, startISO, stopISO)
            .then(({ reData }) => {
                const color = CHART_COLORS[colorIndex % CHART_COLORS.length];
                colorIndex++;
                const name = uid.split('/').pop();
                trajectories.set(uid, { name, color, data: reData, uid });
                swatch.style.background = color;
                swatch.style.display = 'inline-block';
                span.classList.add('plotted');
                updateChartOption();
                updateActionButtons();
                renderLegend();
                setStatus(`Plotted ${name} (${reData.length} points).`);
                updateURL();
            })
            .catch(err => {
                cb.checked = false;
                setStatus('Error: ' + err.message);
            })
            .finally(() => {
                span.classList.remove('loading');
                loadingUids.delete(uid);
                showLoading(false);
                showFetchBar(false);
                renderLegend();
            });
    }

    async function replotAll() {
        const checked = document.querySelectorAll('.tree-node input[type="checkbox"][data-uid]:checked');
        if (checked.length === 0) return;
        const startDate = parseDateInput(document.getElementById('startTime').value);
        const stopDate = parseDateInput(document.getElementById('stopTime').value);
        if (!startDate || !stopDate) return;
        if (startDate >= stopDate) {
            setStatus('Start time must be before stop time.');
            return;
        }

        const existingColors = new Map();
        for (const [uid, t] of trajectories) existingColors.set(uid, t.color);
        trajectories.clear();

        const coordSys = document.getElementById('coordSys').value;
        const startISO = startDate.toISOString();
        const stopISO = stopDate.toISOString();

        showLoading(true);
        showFetchBar(true);
        loadingUids.clear();
        for (const cb of checked) loadingUids.add(cb.dataset.uid);
        renderLegend();
        setStatus('Refreshing all trajectories...');
        const errors = [];
        const tasks = Array.from(checked).map((cb) => () => {
            const uid = cb.dataset.uid;
            const span = cb.closest('.tree-node');
            const swatch = span.querySelector('.color-swatch');
            span.classList.add('loading');
            return fetchTrajectoryData(uid, coordSys, startISO, stopISO)
                .then(({ reData }) => {
                    const color = existingColors.get(uid) || CHART_COLORS[colorIndex++ % CHART_COLORS.length];
                    trajectories.set(uid, { name: uid.split('/').pop(), color, data: reData, uid });
                    swatch.style.background = color;
                })
                .catch(err => {
                    errors.push(uid.split('/').pop() + ': ' + err.message);
                })
                .finally(() => {
                    span.classList.remove('loading');
                    loadingUids.delete(uid);
                    renderLegend();
                });
        });
        await runWithConcurrency(tasks, 3);
        updateChartOption();
        updateActionButtons();
        renderLegend();
        showLoading(false);
        showFetchBar(false);
        const msg = `Refreshed ${trajectories.size} trajectory(ies).`;
        setStatus(errors.length ? msg + ' Errors: ' + errors.join('; ') : msg);
        updateURL();
    }

    function getSelectedDurationMs() {
        const active = document.querySelector('#durationBtns button.active');
        return (active ? parseInt(active.dataset.days) : 7) * 86400000;
    }

    // Highlight the duration button matching the current start/stop span, or clear
    // all buttons if the span doesn't match any preset. Keeps the UI in sync when
    // the user edits the date fields directly.
    function syncDurationButton() {
        const start = parseDateInput(document.getElementById('startTime').value);
        const stop = parseDateInput(document.getElementById('stopTime').value);
        const buttons = document.querySelectorAll('#durationBtns button[data-days]');
        if (!start || !stop) {
            buttons.forEach(b => b.classList.remove('active'));
            return;
        }
        const spanDays = Math.round((stop.getTime() - start.getTime()) / 86400000);
        let matched = false;
        for (const b of buttons) {
            const isMatch = parseInt(b.dataset.days) === spanDays;
            b.classList.toggle('active', isMatch);
            if (isMatch) matched = true;
        }
        if (!matched) buttons.forEach(b => b.classList.remove('active'));
    }

    function applyDuration(days) {
        const stop = parseDateInput(document.getElementById('stopTime').value);
        if (!stop) return;
        const start = new Date(stop.getTime() - days * 86400000);
        setDateInput(document.getElementById('startTime'), start);
        syncDurationButton();
        debouncedReplotAll();
    }

    document.getElementById('durationBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-days]');
        if (!btn) return;
        document.querySelectorAll('#durationBtns button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyDuration(parseInt(btn.dataset.days));
    });

    // ---- View alignment ----
    const VIEW_ANGLES = {
        reset: { alpha: 40, beta: 40 },
        xy:    { alpha: 90, beta: 0 },
        xz:    { alpha: 0,  beta: 0 },
        yz:    { alpha: 0,  beta: 90 }
    };

    document.getElementById('viewBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-view]');
        if (!btn) return;
        const view = VIEW_ANGLES[btn.dataset.view];
        if (!view) return;
        const opts = { grid3D: { viewControl: { alpha: view.alpha, beta: view.beta } } };
        if (btn.dataset.view === 'reset') {
            opts.grid3D.viewControl.distance = 150;
            // Reset axis range to fit the current trajectories.
            const range = computeAxisRange([...trajectories.values()].map((t) => t.data));
            opts.xAxis3D = { min: range.min, max: range.max };
            opts.yAxis3D = { min: range.min, max: range.max };
            opts.zAxis3D = { min: range.min, max: range.max };
        }
        chart.setOption(opts);
    });

    document.getElementById('btn-clear').addEventListener('click', clearAllTrajectories);
    document.getElementById('btn-export-png').addEventListener('click', exportPng);

    attachDatePicker(document.getElementById('startTime'));
    attachDatePicker(document.getElementById('stopTime'));

    // Route start/stop edits through a short debounce so changing both fields
    // (or a flatpickr pick firing 'change' twice) triggers a single replot.
    let replotTimer = null;
    function debouncedReplotAll() {
        if (replotTimer) clearTimeout(replotTimer);
        replotTimer = setTimeout(replotAll, 250);
    }

    document.getElementById('startTime').addEventListener('change', () => {
        syncDurationButton();
        debouncedReplotAll();
    });
    document.getElementById('stopTime').addEventListener('change', () => {
        applyDuration(getSelectedDurationMs() / 86400000);
    });
    document.getElementById('coordSys').addEventListener('change', replotAll);

    // Magnetosphere controls
    document.getElementById('showMagnetopause').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
        updateURL();
    });
    document.getElementById('showBowShock').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
        updateURL();
    });

    // Slider drags: update only the magnetopause/bow shock surfaces for smooth
    // real-time feedback. Reclassifying trajectories is deferred to the 'change'
    // event (fires on release), which triggers a full updateChartOption.
    document.getElementById('dpSlider').addEventListener('input', function() {
        document.getElementById('dpValue').textContent = parseFloat(this.value).toFixed(1) + ' nPa';
        updateMagnetoSurfaces();
    });
    document.getElementById('bzSlider').addEventListener('input', function() {
        document.getElementById('bzValue').textContent = parseFloat(this.value).toFixed(1) + ' nT';
        updateMagnetoSurfaces();
    });
    // On slider release, reclassify trajectories with the final Dp/Bz.
    document.getElementById('dpSlider').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
        updateURL();
    });
    document.getElementById('bzSlider').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
        updateURL();
    });

    // ---- Search / filter ----
    document.getElementById('searchInput').addEventListener('input', function() {
        const q = this.value.toLowerCase().trim();
        filterTree(document.getElementById('treeContainer'), q);
    });

    function filterTree(container, query) {
        const items = container.querySelectorAll(':scope > ul > li');
        items.forEach(li => {
            const childContainer = li.querySelector(':scope > .tree-children');
            if (!query) {
                li.classList.remove('hidden');
                if (childContainer) filterTree(childContainer, '');
                return;
            }
            const name = li.dataset.name || '';
            let childMatch = false;
            if (childContainer) {
                filterTree(childContainer, query);
                childMatch = Array.from(childContainer.querySelectorAll(':scope > ul > li')).some(c => !c.classList.contains('hidden'));
            }
            const selfMatch = name.includes(query);
            li.classList.toggle('hidden', !selfMatch && !childMatch);
            if (childMatch && childContainer) {
                childContainer.classList.add('open');
                const toggle = li.querySelector(':scope > .tree-node .toggle');
                if (toggle) toggle.textContent = '▼';
            }
        });
    }

    // ---- Controls bar collapse ----
    (function initControlsCollapse() {
        const bar = document.getElementById('controls-bar');
        const btn = document.getElementById('controls-collapse-btn');
        btn.addEventListener('click', () => {
            bar.classList.toggle('collapsed');
            btn.innerHTML = bar.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
            setTimeout(() => chart && chart.resize(), 200);
        });
    })();

    // ---- Sidebar collapse ----
    (function initSidebarCollapse() {
        const sidebar = document.getElementById('sidebar');
        const btn = document.getElementById('sidebar-collapse-btn');
        const overlay = document.getElementById('overlay');
        const isMobile = () => window.matchMedia('(max-width: 700px)').matches;

        function updateBtnPosition() {
            if (isMobile()) {
                btn.innerHTML = '&#9776;';
                return;
            }
            const collapsed = sidebar.classList.contains('collapsed');
            btn.style.left = collapsed ? '0' : sidebar.offsetWidth + 'px';
            btn.innerHTML = collapsed ? '&#9654;' : '&#9664;';
        }

        btn.addEventListener('click', () => {
            if (isMobile()) {
                sidebar.classList.toggle('mobile-open');
                overlay.classList.toggle('visible', sidebar.classList.contains('mobile-open'));
            } else {
                sidebar.classList.toggle('collapsed');
            }
            updateBtnPosition();
            setTimeout(() => chart && chart.resize(), 200);
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('visible');
        });

        updateBtnPosition();
        new ResizeObserver(updateBtnPosition).observe(sidebar);
    })();

    // ---- Shareable URL state ----
    // Flat, readable query params (no base64 config here): coordSys, start/stop,
    // checked uids, Dp/Bz, boundary toggles. Restored on load; checked uids are
    // re-applied once the inventory tree exists.

    let pendingUids = null;  // uids from the URL waiting for the tree to build

    function updateURL() {
        const params = new URLSearchParams();
        const startDate = parseDateInput(document.getElementById('startTime').value);
        const stopDate = parseDateInput(document.getElementById('stopTime').value);
        if (startDate) params.set('start', startDate.toISOString());
        if (stopDate) params.set('stop', stopDate.toISOString());
        params.set('coordSys', document.getElementById('coordSys').value);
        const uids = Array.from(document.querySelectorAll('.tree-node input[type="checkbox"][data-uid]:checked'))
            .map(cb => cb.dataset.uid);
        if (uids.length > 0) params.set('uids', uids.join(','));
        const dp = document.getElementById('dpSlider').value;
        const bz = document.getElementById('bzSlider').value;
        if (dp !== '2') params.set('dp', dp);
        if (bz !== '0') params.set('bz', bz);
        if (document.getElementById('showMagnetopause').checked) params.set('mp', '1');
        if (document.getElementById('showBowShock').checked) params.set('bs', '1');
        const qs = params.toString();
        history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    }

    function restoreFromURL() {
        const params = new URLSearchParams(window.location.search);
        if ([...params.keys()].length === 0) return;

        const coordSys = params.get('coordSys');
        if (coordSys) document.getElementById('coordSys').value = coordSys;
        const start = params.get('start');
        const stop = params.get('stop');
        if (start && !isNaN(new Date(start))) setDateInput(document.getElementById('startTime'), new Date(start));
        if (stop && !isNaN(new Date(stop))) setDateInput(document.getElementById('stopTime'), new Date(stop));
        const dp = params.get('dp');
        if (dp !== null && !isNaN(parseFloat(dp))) {
            document.getElementById('dpSlider').value = dp;
            document.getElementById('dpValue').textContent = parseFloat(dp).toFixed(1) + ' nPa';
        }
        const bz = params.get('bz');
        if (bz !== null && !isNaN(parseFloat(bz))) {
            document.getElementById('bzSlider').value = bz;
            document.getElementById('bzValue').textContent = parseFloat(bz).toFixed(1) + ' nT';
        }
        document.getElementById('showMagnetopause').checked = params.get('mp') === '1';
        document.getElementById('showBowShock').checked = params.get('bs') === '1';
        const uids = params.get('uids');
        pendingUids = uids ? uids.split(',') : null;
    }

    async function applyPendingUids() {
        if (!pendingUids) return;
        const wanted = pendingUids;
        pendingUids = null;
        const cbs = [...document.querySelectorAll('.tree-node input[type="checkbox"][data-uid]')]
            .filter(cb => wanted.includes(cb.dataset.uid));
        if (cbs.length === 0) return;

        // Validate times before fetching. Use the first satellite's inventory
        // bounds to auto-fill if unset.
        const startVal = document.getElementById('startTime').value;
        const stopVal = document.getElementById('stopTime').value;
        if (!startVal || !stopVal) {
            for (const cb of cbs) {
                try {
                    const bounds = JSON.parse(cb.dataset.timeBoundsJson || '{}');
                    if (bounds.start) {
                        const e = new Date(bounds.stop || bounds.start);
                        const s = new Date(e.getTime() - getSelectedDurationMs());
                        setDateInput(document.getElementById('startTime'), s);
                        setDateInput(document.getElementById('stopTime'), e);
                        break;
                    }
                } catch (_) {}
            }
        }

        const coordSys = document.getElementById('coordSys').value;
        const startDate = parseDateInput(document.getElementById('startTime').value);
        const stopDate = parseDateInput(document.getElementById('stopTime').value);
        if (!startDate || !stopDate || startDate >= stopDate) {
            setStatus('Set start and stop times first.');
            return;
        }

        const startISO = startDate.toISOString();
        const stopISO = stopDate.toISOString();
        const tasks = cbs.map(cb => () => {
            const span = cb.closest('.tree-node');
            const swatch = span.querySelector('.color-swatch');
            cb.checked = true;
            return fetchSatellite(cb.dataset.uid, cb, span, swatch, coordSys, startISO, stopISO);
        });
        await runWithConcurrency(tasks, 3);
        syncGroupCheckboxes();
    }

    // Sync folder group-checkbox state from their leaf checkboxes: a folder is
    // checked when at least one leaf is, and fully checked when all leaves are.
    function syncGroupCheckboxes() {
        for (const groupCb of document.querySelectorAll('.group-checkbox')) {
            const folder = groupCb.closest('li');
            const leaves = folder.querySelectorAll('.tree-node input[type="checkbox"][data-uid]');
            const checked = [...leaves].filter(cb => cb.checked).length;
            groupCb.checked = checked === leaves.length && leaves.length > 0;
            groupCb.indeterminate = checked > 0 && checked < leaves.length;
        }
    }

    // ---- Init ----
    async function loadInventory() {
        showLoading(true);
        showFetchBar(true);
        setStatus('Loading inventory...');
        try {
            const inv = await fetchInventory(API_BASE, 'ssc');
            buildTree(inv, document.getElementById('treeContainer'), inv);
            setStatus('Ready — check satellites to plot their orbits.');
            applyPendingUids();
        } catch (err) {
            setStatus('Failed to load inventory: ' + err.message);
            const container = document.getElementById('treeContainer');
            container.innerHTML = '';
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry';
            retryBtn.style.cssText = 'margin:8px;padding:6px 16px;border:none;border-radius:6px;background:#6b8afd;color:#fff;font-size:0.85rem;cursor:pointer;';
            retryBtn.addEventListener('click', () => loadInventory());
            container.appendChild(retryBtn);
            console.error('Inventory load error:', err);
        } finally {
            showLoading(false);
            showFetchBar(false);
        }
    }

    installErrorBoundary('statusBar');
    (async () => {
        restoreFromURL();
        try {
            await loadEarthTexture();
            initChart();
        } catch (e) {
            console.error('3D chart init failed:', e);
            setStatus('Chart library failed to load — 3D view unavailable. Check network connection.');
        }
        // Inventory loads even if the chart didn't, so the tree stays usable.
        loadInventory();
    })();
