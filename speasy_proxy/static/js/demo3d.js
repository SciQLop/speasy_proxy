import { toLocalISOString, setStatus, showLoading, showFetchBar } from './common.js';
import {
  shueParams, bowShockParams, classifyPoint,
  toReData as sharedToReData, computeAxisRange,
  EARTH_RADIUS_KM, MAX_DISTANCE_RE,
} from './magnetosphere.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
import { isSpzMetaKey } from './inventory-tree.js';

const API_BASE = (window.SPEASY_BASE_URL || '').replace(/\/$/, '') + '/';
    const COLORS = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc'];
    const METADATA_KEYS = new Set([
        'UNITS','FILLVAL','SCALETYP','COORDINATE_SYSTEM','FIELDNAM',
        'CATDESC','DEPEND_0','DEPEND_1','LABL_PTR_1',
        'start_date','stop_date','maxDate','minDate',
        'build_date','Id','Resolution','Geometry','TrajectoryGeometry','ResourceId','GroupId'
    ]);

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
    let earthPixels = null;
    let earthTexW = 0;
    let earthTexH = 0;

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
                earthPixels = ctx.getImageData(0, 0, w, h).data;
                earthTexW = w;
                earthTexH = h;
                resolve(true);
            };
            img.onerror = () => resolve(false);
            img.src = API_BASE + 'static/earth_bluemarble.jpg';
        });
    }

    function sampleEarthColor(x, y, z) {
        if (!earthPixels) return '#2255aa';
        const r = Math.sqrt(x * x + y * y + z * z) || 1;
        const lat = Math.asin(Math.max(-1, Math.min(1, z / r)));
        const lon = Math.atan2(y, x);
        const px = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * (earthTexW - 1));
        const py = Math.floor(((Math.PI / 2 - lat) / Math.PI) * (earthTexH - 1));
        const i = (py * earthTexW + px) * 4;
        return `rgb(${earthPixels[i]},${earthPixels[i + 1]},${earthPixels[i + 2]})`;
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
            shading: earthPixels ? 'lambert' : 'color',
            itemStyle: earthPixels
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

    const REGION_COLORS = ['#91cc75', '#fac858', '#ee6666']; // magnetosphere, magnetosheath, solar wind

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

    // ---- Inventory tree ----
    function isMetadataKey(key) {
  return isSpzMetaKey(key) || METADATA_KEYS.has(key);
}

    function hasVisibleChildren(node) {
        if (typeof node !== 'object' || node === null) return false;
        return Object.keys(node).some(k => !isMetadataKey(k));
    }

    function isLeaf(node) {
        return node && typeof node === 'object' && '__spz_uid__' in node && !hasVisibleChildren(node);
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
                    document.getElementById('stopTime').value = toLocalISOString(stop);
                    document.getElementById('startTime').value = toLocalISOString(start);
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
            } else if (hasVisibleChildren(val)) {
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
            setStatus(`Removed ${uid.split('/').pop()}.`);
            return;
        }

        const startVal = document.getElementById('startTime').value;
        const stopVal = document.getElementById('stopTime').value;
        if (!startVal || !stopVal) {
            try {
                const bounds = JSON.parse(cb.dataset.timeBoundsJson || '{}');
                if (bounds.start) {
                    const e = new Date(bounds.stop || bounds.start);
                    const s = new Date(e.getTime() - getSelectedDurationMs());
                    document.getElementById('startTime').value = toLocalISOString(s);
                    document.getElementById('stopTime').value = toLocalISOString(e);
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
        const startISO = new Date(document.getElementById('startTime').value).toISOString();
        const stopISO = new Date(document.getElementById('stopTime').value).toISOString();
        if (new Date(startISO) >= new Date(stopISO)) {
            cb.checked = false;
            setStatus('Start time must be before stop time.');
            return;
        }

        span.classList.add('loading');
        showLoading(true);
        showFetchBar(true);
        setStatus(`Fetching ${uid.split('/').pop()}...`);
        try {
            const data = await apiFetchData({
  baseUrl: API_BASE, path: uid, startISO, stopISO,
  maxPoints: 10000, coordinateSystem: coordSys,
});
const reData = toReData(data.values.values);

            const color = COLORS[colorIndex % COLORS.length];
            colorIndex++;
            const name = uid.split('/').pop();
            trajectories.set(uid, { name, color, data: reData, uid });
            swatch.style.background = color;
            swatch.style.display = 'inline-block';
            span.classList.add('plotted');
            updateChartOption();
            setStatus(`Plotted ${name} (${reData.length} points).`);
        } catch (err) {
            cb.checked = false;
            setStatus('Error: ' + err.message);
        } finally {
            span.classList.remove('loading');
            showLoading(false);
            showFetchBar(false);
        }
    }

    async function replotAll() {
        const checked = document.querySelectorAll('.tree-node input[type="checkbox"][data-uid]:checked');
        if (checked.length === 0) return;
        const startVal = document.getElementById('startTime').value;
        const stopVal = document.getElementById('stopTime').value;
        if (!startVal || !stopVal) return;
        if (new Date(startVal) >= new Date(stopVal)) {
            setStatus('Start time must be before stop time.');
            return;
        }

        const existingColors = new Map();
        for (const [uid, t] of trajectories) existingColors.set(uid, t.color);
        trajectories.clear();

        const coordSys = document.getElementById('coordSys').value;
        const startISO = new Date(startVal).toISOString();
        const stopISO = new Date(stopVal).toISOString();

        showLoading(true);
        showFetchBar(true);
        setStatus('Refreshing all trajectories...');
        const errors = [];
        const fetches = Array.from(checked).map(async (cb) => {
            const uid = cb.dataset.uid;
            const span = cb.closest('.tree-node');
            const swatch = span.querySelector('.color-swatch');
            span.classList.add('loading');
            try {
                const data = await apiFetchData({
  baseUrl: API_BASE, path: uid, startISO, stopISO,
  maxPoints: 10000, coordinateSystem: coordSys,
});
const reData = toReData(data.values.values);
                const color = existingColors.get(uid) || COLORS[colorIndex++ % COLORS.length];
                trajectories.set(uid, { name: uid.split('/').pop(), color, data: reData, uid });
                swatch.style.background = color;
            } catch (err) {
                errors.push(uid.split('/').pop() + ': ' + err.message);
            } finally {
                span.classList.remove('loading');
            }
        });
        await Promise.all(fetches);
        updateChartOption();
        showLoading(false);
        showFetchBar(false);
        const msg = `Refreshed ${trajectories.size} trajectory(ies).`;
        setStatus(errors.length ? msg + ' Errors: ' + errors.join('; ') : msg);
    }

    function getSelectedDurationMs() {
        const active = document.querySelector('#durationBtns button.active');
        return (active ? parseInt(active.dataset.days) : 7) * 86400000;
    }

    function applyDuration(days) {
        const stopVal = document.getElementById('stopTime').value;
        if (!stopVal) return;
        const stop = new Date(stopVal);
        const start = new Date(stop.getTime() - days * 86400000);
        document.getElementById('startTime').value = toLocalISOString(start);
        replotAll();
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
        if (btn.dataset.view === 'reset') opts.grid3D.viewControl.distance = 150;
        chart.setOption(opts);
    });

    document.getElementById('startTime').addEventListener('change', replotAll);
    document.getElementById('stopTime').addEventListener('change', () => {
        applyDuration(getSelectedDurationMs() / 86400000);
    });
    document.getElementById('coordSys').addEventListener('change', replotAll);

    // Magnetosphere controls
    document.getElementById('showMagnetopause').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
    });
    document.getElementById('showBowShock').addEventListener('change', () => {
        reclassifyAllTrajectories();
        updateChartOption();
    });


    let magnetoTimer = null;
    function debouncedMagnetoUpdate() {
        if (magnetoTimer) clearTimeout(magnetoTimer);
        magnetoTimer = setTimeout(() => {
            reclassifyAllTrajectories();
            updateChartOption();
        }, 500);
    }

    document.getElementById('dpSlider').addEventListener('input', function() {
        document.getElementById('dpValue').textContent = parseFloat(this.value).toFixed(1) + ' nPa';
        debouncedMagnetoUpdate();
    });
    document.getElementById('bzSlider').addEventListener('input', function() {
        document.getElementById('bzValue').textContent = parseFloat(this.value).toFixed(1) + ' nT';
        debouncedMagnetoUpdate();
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

    // ---- Init ----
    async function loadInventory() {
        showLoading(true);
        showFetchBar(true);
        setStatus('Loading inventory...');
        try {
            const inv = await fetchInventory(API_BASE, 'ssc');
            buildTree(inv, document.getElementById('treeContainer'), inv);
            setStatus('Ready — check satellites to plot their orbits.');
        } catch (err) {
            setStatus('Failed to load inventory: ' + err.message);
        } finally {
            showLoading(false);
            showFetchBar(false);
        }
    }

    (async () => {
        await loadEarthTexture();
        initChart();
        loadInventory();
    })();
