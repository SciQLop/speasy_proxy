import {
  attachDatePicker, setDateInput, parseDateInput, escapeHtml,
  setStatus, showLoading, showFetchBar, fallbackCopy,
} from './common.js';
import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS } from './inventory-tree.js';
import {
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  detectPlotType, mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache,
  buildSeriesData, configToBase64, base64ToConfig,
  normalizeWheelDelta, zoomRange, panRange, axisExtent, structureKey, resampleTarget,
} from './plot-core.js';
import { computeYEdges, renderSpectrogramImage } from './spectrogram.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';

    const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');
    const API_BASE = BASE_URL + '/';
    const MAX_CACHE_POINTS = 500000;
    const CHART_COLORS = [
        '#5470c6','#91cc75','#fac858','#ee6666','#73c0de',
        '#3ba272','#fc8452','#9a60b4','#ea7ccc'
    ];

    // State
    let chart = null;
    let inventory = null;
    let selectedProduct = null;  // currently selected in the tree (not yet plotted)
    let leafIndex = [];
    let zoomDebounceTimer = null;
    let suppressDataZoom = false;

    // Multi-plot state — single source of truth
    const plotState = {
        version: 1,
        time_range: { start: null, stop: null },
        plots: [],  // array of subplot objects
        intervals: []  // [{start, stop, color?, label?}] — vertical spans across all subplots
    };

    let currentView = { start: null, end: null };
    let fetchController = null;
    let lastStructureKey = null;  // structure of the last full chart build; used to pick merge vs rebuild

    // ===== Task 4: Inventory Tree =====

    async function loadInventory() {
        const container = document.getElementById('tree-container');
        container.innerHTML = '<div class="loading-text">Loading inventory...</div>';
        try {
            inventory = await fetchInventory(API_BASE, 'all');
            renderTree(inventory);
            setupSearch();
        } catch (e) {
            container.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'loading-text';
            msg.textContent = 'Failed to load inventory: ' + e.message;
            container.appendChild(msg);
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry';
            retryBtn.style.cssText = 'margin:8px 0;padding:6px 16px;border:none;border-radius:6px;background:#6b8afd;color:#fff;font-size:0.85rem;cursor:pointer;';
            retryBtn.addEventListener('click', () => loadInventory());
            container.appendChild(retryBtn);
            console.error('Inventory load error:', e);
        }
    }

    function renderTree(data) {
        const container = document.getElementById('tree-container');
        container.innerHTML = '';
        if (!data || typeof data !== 'object') return;
        const keys = Object.keys(data).filter(k => !SKIP_KEYS.has(k)).sort();
        for (const key of keys) {
            if (shouldSkipNode(data[key])) continue;
            const node = buildTreeNode(data[key], key);
            if (node) container.appendChild(node);
        }
    }

    function buildTreeNode(data, key) {
        if (!data || typeof data !== 'object') return null;
        if (shouldSkipNode(data)) return null;

        const displayName = getDisplayName(data, key);

        // Leaf node
        if (data.__spz_type__ === 'ParameterIndex') {
            const div = document.createElement('div');
            div.style.cssText = 'padding:3px 0 3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;';
            div.textContent = displayName;
            div.title = getProductPath(data);
            div.addEventListener('mouseenter', () => { div.style.background = '#1e2640'; });
            div.addEventListener('mouseleave', () => {
                if (!div.classList.contains('selected')) div.style.background = '';
            });
            div.addEventListener('click', () => selectProduct(data, div));
            div.addEventListener('dblclick', () => { selectProduct(data, div); doPlot(); });
            return div;
        }

        // Branch node — collect children first
        const childKeys = Object.keys(data).filter(k => !SKIP_KEYS.has(k)).sort();
        const childNodes = [];
        for (const ck of childKeys) {
            if (typeof data[ck] !== 'object' || data[ck] === null) continue;
            if (shouldSkipNode(data[ck])) continue;
            const child = buildTreeNode(data[ck], ck);
            if (child) childNodes.push(child);
        }
        if (childNodes.length === 0) return null;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-left:4px;';

        const header = document.createElement('div');
        header.style.cssText = 'padding:3px 0;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const arrow = document.createElement('span');
        arrow.textContent = '▶ ';
        arrow.style.cssText = 'font-size:0.7em;display:inline-block;transition:transform 0.15s;color:#555e7e;';
        header.appendChild(arrow);
        header.appendChild(document.createTextNode(displayName));

        const childContainer = document.createElement('div');
        childContainer.style.cssText = 'display:none;margin-left:12px;';
        for (const cn of childNodes) childContainer.appendChild(cn);

        header.addEventListener('click', () => {
            const open = childContainer.style.display !== 'none';
            childContainer.style.display = open ? 'none' : 'block';
            arrow.style.transform = open ? '' : 'rotate(90deg)';
        });

        wrapper.appendChild(header);
        wrapper.appendChild(childContainer);
        return wrapper;
    }

    let previousSelectedLabel = null;

    function selectProduct(node, labelEl) {
        // Un-highlight previous
        if (previousSelectedLabel) {
            previousSelectedLabel.classList.remove('selected');
            previousSelectedLabel.style.background = '';
        }
        // Highlight new
        labelEl.classList.add('selected');
        labelEl.style.background = '#1e2640';
        previousSelectedLabel = labelEl;

        selectedProduct = getProductPath(node);
        document.getElementById('product-path').value = selectedProduct;
        document.getElementById('btn-plot').disabled = false;
        document.getElementById('btn-add').disabled = false;

        // Pre-fill date inputs
        if (node.stop_date) {
            const stopDate = new Date(node.stop_date);
            stopDate.setMonth(stopDate.getMonth() - 2);
            const startDate = new Date(stopDate);
            startDate.setDate(startDate.getDate() - 1);
            setDateInput(document.getElementById('stop-time'), stopDate);
            setDateInput(document.getElementById('start-time'), startDate);
        }

        updateURL();
    }

    // ===== Task 5: Search/Filter =====

    function setupSearch() {
        leafIndex = [];
        buildLeafIndex(inventory, []);

        document.getElementById('search-box').addEventListener('input', function() {
            const query = this.value.trim().toLowerCase();
            if (query.length < 2) {
                renderTree(inventory);
                return;
            }
            renderSearchResults(query);
        });
    }

    function buildLeafIndex(node, breadcrumb) {
        if (!node || typeof node !== 'object') return;
        if (shouldSkipNode(node)) return;

        if (node.__spz_type__ === 'ParameterIndex') {
            const displayName = node.__spz_name__ || node.name || '';
            const bc = breadcrumb.concat(displayName);
            leafIndex.push({
                name: bc.join(' / ').toLowerCase(),
                displayName: displayName,
                breadcrumb: bc,
                node: node,
                path: getProductPath(node)
            });
            return;
        }

        const keys = Object.keys(node).filter(k => !SKIP_KEYS.has(k));
        for (const k of keys) {
            if (typeof node[k] === 'object' && node[k] !== null) {
                buildLeafIndex(node[k], breadcrumb.concat(getDisplayName(node[k], k)));
            }
        }
    }

    function renderSearchResults(query) {
        const container = document.getElementById('tree-container');
        container.innerHTML = '';

        const terms = query.split(/\s+/).filter(t => t.length > 0);
        const results = leafIndex.filter(leaf => {
            return terms.every(t => leaf.name.indexOf(t) !== -1);
        });

        if (results.length === 0) {
            container.innerHTML = '<div class="loading-text">No results found.</div>';
            return;
        }

        const max = Math.min(results.length, 100);
        for (let i = 0; i < max; i++) {
            const leaf = results[i];
            const div = document.createElement('div');
            div.style.cssText = 'padding:4px 4px;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

            const prefix = leaf.breadcrumb.slice(0, -1).join(' / ');
            if (prefix) {
                const span = document.createElement('span');
                span.style.color = '#555e7e';
                span.textContent = prefix + ' / ';
                div.appendChild(span);
            }
            div.appendChild(document.createTextNode(leaf.displayName));
            div.title = leaf.path;

            div.addEventListener('mouseenter', () => { div.style.background = '#1e2640'; });
            div.addEventListener('mouseleave', () => {
                if (!div.classList.contains('selected')) div.style.background = '';
            });
            div.addEventListener('click', () => selectProduct(leaf.node, div));
            div.addEventListener('dblclick', () => { selectProduct(leaf.node, div); doPlot(); });
            container.appendChild(div);
        }

        if (results.length > 100) {
            const more = document.createElement('div');
            more.className = 'loading-text';
            more.textContent = '... and ' + (results.length - 100) + ' more results';
            container.appendChild(more);
        }
    }

    // ===== Task 6: Data Fetch and ECharts Plot =====

    function initChart() {
        const el = document.getElementById('chart');
        chart = echarts.init(el, 'dark');
        new ResizeObserver(() => {
            chart.resize();
            if (plotState.plots.length > 0) renderAllSubplots(true);
        }).observe(el);
    }

    function bindControls() {
        attachDatePicker(document.getElementById('start-time'));
        attachDatePicker(document.getElementById('stop-time'));

        document.getElementById('btn-plot').addEventListener('click', doPlot);
        document.getElementById('start-time').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doPlot();
        });
        document.getElementById('stop-time').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doPlot();
        });

        document.getElementById('range-chips').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.pan) panTime(Number(btn.dataset.pan));
            else if (btn.dataset.ms) applyRelativeRange(Number(btn.dataset.ms));
        });

        // Arrow keys pan the time window when not typing in a field.
        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); panTime(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); panTime(1); }
        });
        document.getElementById('btn-log-scale').addEventListener('click', () => {
            const heatmapPlots = plotState.plots.filter(sp => sp.plotType === 'heatmap');
            if (heatmapPlots.length === 0) return;
            for (const sp of heatmapPlots) sp.logScale = !sp.logScale;
            document.getElementById('btn-log-scale').textContent = heatmapPlots[0].logScale ? 'Log Z' : 'Linear Z';
            renderAllSubplots(true);
        });
        document.getElementById('btn-log-y').addEventListener('click', () => {
            if (plotState.plots.length === 0) return;
            for (const sp of plotState.plots) sp.y_axis.log = !sp.y_axis.log;
            document.getElementById('btn-log-y').textContent = plotState.plots[0].y_axis.log ? 'Log Y' : 'Linear Y';
            renderAllSubplots(true);
        });
        document.getElementById('btn-clear').addEventListener('click', clearAllPlots);

        // Add to plot dropdown
        document.getElementById('btn-add').addEventListener('click', () => {
            const dropdown = document.getElementById('add-dropdown');
            if (dropdown.style.display === 'none') {
                populateAddDropdown();
                dropdown.style.display = 'block';
            } else {
                dropdown.style.display = 'none';
            }
        });

        // Close dropdown/popover on outside click
        document.addEventListener('click', (e) => {
            const addBtn = document.getElementById('btn-add');
            const dropdown = document.getElementById('add-dropdown');
            if (!addBtn.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
            const shareBtn = document.getElementById('btn-share');
            const popover = document.getElementById('share-popover');
            if (!shareBtn.contains(e.target) && !popover.contains(e.target)) {
                popover.style.display = 'none';
            }
        });

        // Share button
        document.getElementById('btn-share').addEventListener('click', () => {
            if (plotState.plots.length === 0) return;
            const popover = document.getElementById('share-popover');
            if (popover.style.display === 'none') {
                updateShareURL();
                popover.style.display = 'block';
            } else {
                popover.style.display = 'none';
            }
        });

        document.getElementById('btn-copy-url').addEventListener('click', () => {
            const urlInput = document.getElementById('share-url');
            const copyBtn = document.getElementById('btn-copy-url');
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(urlInput.value).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
                }).catch(() => {
                    fallbackCopy(urlInput, copyBtn);
                });
            } else {
                fallbackCopy(urlInput, copyBtn);
            }
        });
    }

    function populateAddDropdown() {
        const dropdown = document.getElementById('add-dropdown');
        dropdown.innerHTML = '';

        const newItem = document.createElement('div');
        newItem.className = 'add-dropdown-item';
        newItem.textContent = '+ New subplot';
        newItem.addEventListener('click', () => {
            addProductToPlot(null);
            dropdown.style.display = 'none';
        });
        dropdown.appendChild(newItem);

        for (let i = 0; i < plotState.plots.length; i++) {
            const sp = plotState.plots[i];
            const label = sp.products.length > 0 ? sp.products[0].path.split('/').pop() : 'empty';

            const item = document.createElement('div');
            item.className = 'add-dropdown-item';
            item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

            const textSpan = document.createElement('span');
            textSpan.textContent = 'Subplot ' + (i + 1) + ': ' + label;
            textSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
            item.appendChild(textSpan);

            const removeBtn = document.createElement('span');
            removeBtn.textContent = '✕';
            removeBtn.title = 'Remove subplot';
            removeBtn.style.cssText = 'margin-left:8px;color:#ee6666;cursor:pointer;padding:0 4px;';
            const idx = i;
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeSubplot(idx);
                dropdown.style.display = 'none';
            });
            item.appendChild(removeBtn);

            item.addEventListener('click', () => {
                addProductToPlot(idx);
                dropdown.style.display = 'none';
            });
            dropdown.appendChild(item);
        }
    }

    function addProductToPlot(subplotIndex) {
        if (!chart) { setStatus('Chart not available — check network connection.'); return; }
        const product = document.getElementById('product-path').value;
        const startDate = parseDateInput(document.getElementById('start-time').value);
        const stopDate = parseDateInput(document.getElementById('stop-time').value);

        if (!product) { setStatus('No product selected.'); return; }
        if (!startDate || !stopDate) { setStatus('Please set valid start and stop times (DD-MM-YYYY HH:MM).'); return; }

        plotState.time_range.start = startDate.toISOString();
        plotState.time_range.stop = stopDate.toISOString();

        let subplot;
        if (subplotIndex === null) {
            subplot = createSubplotData();
            plotState.plots.push(subplot);
        } else {
            subplot = plotState.plots[subplotIndex];
        }

        if (subplot.products.some(p => p.path === product)) {
            setStatus('Product already in this subplot.');
            return;
        }

        subplot.products.push({ path: product, label: product });
        subplot.productData[product] = createProductCache(product);

        updateURL();
        fetchProductAndRender(plotState.plots.indexOf(subplot), product);
    }

    function removeSubplot(index) {
        plotState.plots.splice(index, 1);
        if (plotState.plots.length === 0) {
            chart.clear();
            document.getElementById('btn-clear').style.display = 'none';
            setStatus('Ready');
        } else {
            renderAllSubplots();
        }
        updateURL();
    }

    function clearAllPlots() {
        plotState.plots = [];
        chart.clear();
        document.getElementById('btn-clear').style.display = 'none';
        document.getElementById('btn-log-scale').style.display = 'none';
        document.getElementById('btn-log-y').style.display = 'none';
        document.getElementById('btn-share').disabled = true;
        history.replaceState(null, '', window.location.pathname);
        setStatus('Ready');
    }

    function updateShareURL() {
        if (plotState.plots.length === 0) return;
        const config = stateToConfig();
        const encoded = configToBase64(config);
        const fullUrl = window.location.origin + window.location.pathname + '?config=' + encoded;
        document.getElementById('share-url').value = fullUrl;
    }

    async function fetchProductAndRender(subplotIndex, productPath) {
        showLoading(true);
        setStatus('Fetching ' + productPath + '...');

        const startTime = plotState.time_range.start;
        const stopTime = plotState.time_range.stop;
        const startISO = new Date(startTime).toISOString();
        const stopISO = new Date(stopTime).toISOString();
        const fetchStartMs = new Date(startTime).getTime();
        const fetchStopMs = new Date(stopTime).getTime();

        try {
            const data = await fetchData(productPath, startISO, stopISO);
            if (!data || !data.values || !data.axes || data.axes.length === 0) {
                setStatus('No data returned for ' + productPath);
                showLoading(false);
                return;
            }

            const subplot = plotState.plots[subplotIndex];
            const cache = subplot.productData[productPath];
            mergeProductData(cache, data, fetchStartMs, fetchStopMs);

            if (subplot.products[0].path === productPath) {
                subplot.plotType = detectPlotType(data);
            }

            renderAllSubplots();
            setStatus('Added ' + productPath);
        } catch (e) {
            setStatus('Error fetching ' + productPath + ': ' + e.message);
            console.error(e);
        } finally {
            showLoading(false);
        }
    }

    // ===== Time navigation (quick-range chips + pan) =====

    function currentStopMs() {
        const d = parseDateInput(document.getElementById('stop-time').value);
        return d ? d.getTime() : Date.now();
    }

    function currentStartMs() {
        const d = parseDateInput(document.getElementById('start-time').value);
        return d ? d.getTime() : currentStopMs() - 86400000;
    }

    // Set the window and re-plot fresh. Caches are reset so a new (possibly disjoint)
    // window fetches clean data instead of merging across a time gap.
    function replotOverRange(startMs, stopMs) {
        setDateInput(document.getElementById('start-time'), new Date(startMs));
        setDateInput(document.getElementById('stop-time'), new Date(stopMs));
        plotState.time_range.start = new Date(startMs).toISOString();
        plotState.time_range.stop = new Date(stopMs).toISOString();

        if (plotState.plots.length === 0) {
            if (document.getElementById('product-path').value) doPlot();
            return;
        }
        for (const sp of plotState.plots) {
            for (const prod of sp.products) sp.productData[prod.path] = createProductCache(prod.path);
        }
        updateURL();
        fetchAllAndRender();
    }

    function applyRelativeRange(spanMs) {
        const stop = currentStopMs();
        replotOverRange(stop - spanMs, stop);
    }

    function panTime(dir) {
        const start = currentStartMs(), stop = currentStopMs();
        const width = (stop - start) || 86400000;
        replotOverRange(start + dir * width, stop + dir * width);
    }

    async function doPlot() {
        if (!chart) { setStatus('Chart not available — check network connection.'); return; }
        const product = document.getElementById('product-path').value;
        const startDate = parseDateInput(document.getElementById('start-time').value);
        const stopDate = parseDateInput(document.getElementById('stop-time').value);

        if (!product) { setStatus('No product selected.'); return; }
        if (!startDate || !stopDate) { setStatus('Please set valid start and stop times (DD-MM-YYYY HH:MM).'); return; }

        // Reset: clear all subplots, create one with this product
        plotState.time_range.start = startDate.toISOString();
        plotState.time_range.stop = stopDate.toISOString();
        plotState.plots = [];

        const subplot = createSubplotData();
        subplot.products.push({ path: product, label: product });
        subplot.productData[product] = createProductCache(product);
        plotState.plots.push(subplot);

        updateURL();
        await fetchAllAndRender();
    }

    async function fetchData(product, startTime, stopTime, signal) {
        const startISO = new Date(startTime).toISOString();
        const stopISO = new Date(stopTime).toISOString();
        const chartWidth = document.getElementById('chart')?.clientWidth || 0;
        const maxPoints = resampleTarget(chartWidth, POINTS_PER_PIXEL, BUFFER_RATIO);
        return apiFetchData({ baseUrl: API_BASE, path: product, startISO, stopISO, maxPoints, signal });
    }

    function mergeProductData(cache, json, fetchStart, fetchStop) {
        const rawTimes = json.axes[0].values;
        const newTimes = rawTimes.map(t => t / 1e6);
        const newValues = json.values.values;
        const columns = json.columns || [];
        const unit = (json.values.meta && json.values.meta.UNITS) || '';

        const isHeatmap = detectPlotType(json) === 'heatmap';

        if (cache.times.length === 0) {
            cache.times = newTimes;
            cache.unit = unit;
            cache.intervals = [[fetchStart, fetchStop]];
            cache.displayType = (json.values.meta || {}).DISPLAY_TYPE || '';

            if (isHeatmap) {
                if (json.axes.length >= 2) {
                    cache.yAxis = json.axes[1].values;
                    cache.yAxisName = json.axes[1].name || '';
                    cache.yAxisUnit = (json.axes[1].meta && json.axes[1].meta.UNITS) || '';
                } else {
                    cache.yAxis = newValues[0] ? newValues[0].map((_, i) => i) : [];
                }
                cache.rows = newValues;
                cache.columnNames = columns;
            } else {
                cache.columnNames = columns.length > 0 ? columns :
                    (newValues[0] ? newValues[0].map((_, i) => 'col_' + i) : ['value']);
                for (let c = 0; c < cache.columnNames.length; c++) {
                    cache.columns[cache.columnNames[c]] = newValues.map(row => row[c]);
                }
            }
        } else {
            if (isHeatmap) {
                const merged = mergeSortedRows(cache.times, newTimes, cache.rows, newValues);
                cache.times = merged.times;
                cache.rows = merged.rows;
            } else {
                const merged = mergeSorted(cache.times, newTimes, cache.columns, newValues, cache.columnNames);
                cache.times = merged.times;
                cache.columns = merged.columns;
            }
            cache.intervals = mergeIntervals(cache.intervals.concat([[fetchStart, fetchStop]]));
        }
    }

    function renderAllSubplots(preserveView, dataOnly) {
        const n = plotState.plots.length;
        if (n === 0) return;

        const grids = [];
        const xAxes = [];
        const yAxes = [];
        const series = [];
        const titles = [];
        const TOP_PAD = 30;
        const BOT_PAD = 60;
        const GAP = 20;

        const chartHeight = chart.getHeight();
        const usableHeight = chartHeight - TOP_PAD - BOT_PAD - GAP * (n - 1);
        const subplotHeight = Math.max(80, usableHeight / n);

        for (let i = 0; i < n; i++) {
            const subplot = plotState.plots[i];
            const topPx = TOP_PAD + i * (subplotHeight + GAP);
            const firstSeriesIdx = series.length;

            grids.push({
                left: 80, right: 20, top: topPx, height: subplotHeight, containLabel: false
            });

            const subplotTitle = subplot.products.map(p => p.label || p.path.split('/').pop()).join(', ');
            titles.push({
                text: subplotTitle,
                left: 85,
                top: topPx,
                textStyle: { color: '#8892b0', fontSize: 11, fontWeight: 'normal' }
            });

            const firstCache = subplot.productData[subplot.products[0]?.path];
            const times = firstCache?.times || [];
            const extent = axisExtent(times, AXIS_PAD_RATIO);

            xAxes.push({
                type: 'time',
                gridIndex: i,
                axisLabel: { show: i === n - 1, color: '#8892b0' },
                axisLine: { lineStyle: { color: '#2a3358' } },
                splitLine: { show: false },
                axisPointer: {
                    show: true,
                    type: 'line',
                    lineStyle: { color: '#6b8afd', width: 1, type: 'dashed' },
                    label: { show: i === n - 1, backgroundColor: '#1a1f36', color: '#e0e6f0', borderColor: '#2a3358' }
                },
                min: extent.min,
                max: extent.max
            });

            if (subplot.plotType === 'heatmap' && firstCache) {
                const yBins = firstCache.yAxis;
                const yBinsFlat = Array.isArray(yBins?.[0]) ? yBins[0] : (yBins || []);
                const yEdges = computeYEdges(yBinsFlat);
                const yLabel = firstCache.yAxisName + (firstCache.yAxisUnit ? ' (' + firstCache.yAxisUnit + ')' : '');

                const hasYOverride = !!subplot._yOverride;
                const heatYMin = hasYOverride ? subplot._yOverride.min : (subplot.y_axis.log ? Math.max(yEdges[0], 1e-10) : yEdges[0]);
                const heatYMax = hasYOverride ? subplot._yOverride.max : yEdges[yBinsFlat.length];
                yAxes.push({
                    type: subplot.y_axis.log ? 'log' : 'value',
                    gridIndex: i,
                    name: yLabel,
                    nameLocation: 'middle',
                    nameGap: 50,
                    nameTextStyle: { color: '#8892b0' },
                    axisLabel: { color: '#8892b0', showMinLabel: !hasYOverride, showMaxLabel: !hasYOverride },
                    axisLine: { lineStyle: { color: '#2a3358' } },
                    splitLine: { show: false },
                    min: heatYMin,
                    max: heatYMax
                });

                series.push({
                    type: 'scatter',
                    data: [],
                    xAxisIndex: i,
                    yAxisIndex: i,
                    silent: true
                });

                subplot._gridIndex = i;
            } else {
                const lineYAxis = {
                    type: subplot.y_axis.log ? 'log' : 'value',
                    gridIndex: i,
                    name: firstCache?.unit || '',
                    nameLocation: 'middle',
                    nameGap: 50,
                    nameTextStyle: { color: '#8892b0' },
                    axisLabel: { color: '#8892b0' },
                    axisLine: { lineStyle: { color: '#2a3358' } },
                    splitLine: { lineStyle: { color: '#1e2640' } }
                };
                if (subplot._yOverride) {
                    lineYAxis.min = subplot._yOverride.min;
                    lineYAxis.max = subplot._yOverride.max;
                    lineYAxis.axisLabel.showMinLabel = false;
                    lineYAxis.axisLabel.showMaxLabel = false;
                }
                yAxes.push(lineYAxis);

                let colorIdx = 0;
                for (const prod of subplot.products) {
                    const cache = subplot.productData[prod.path];
                    if (!cache || cache.times.length === 0) continue;

                    const prodLabel = prod.label || prod.path.split('/').pop();
                    for (let c = 0; c < cache.columnNames.length; c++) {
                        const colName = cache.columnNames[c];
                        const seriesName = n > 1 || subplot.products.length > 1
                            ? prodLabel + ' ' + colName
                            : colName;
                        series.push({
                            name: seriesName,
                            type: 'line',
                            showSymbol: false,
                            lineStyle: { width: 1.2 },
                            color: CHART_COLORS[colorIdx % CHART_COLORS.length],
                            data: buildSeriesData(cache.times, cache.columns[colName]),
                            // No client-side `sampling` — the server already resamples to a
                            // pixel-appropriate count; ECharts LTTB on top only drops points.
                            large: true,
                            largeThreshold: 50000,
                            xAxisIndex: i,
                            yAxisIndex: i
                        });
                        colorIdx++;
                    }
                }
            }

            if (plotState.intervals.length > 0 && series.length > firstSeriesIdx) {
                series[firstSeriesIdx].markArea = {
                    silent: false,
                    data: plotState.intervals.map(iv => [
                        {
                            xAxis: iv.start,
                            itemStyle: { color: iv.color },
                            name: iv.label
                        },
                        { xAxis: iv.stop }
                    ]),
                    tooltip: { show: true, formatter: params => params.name || '' },
                    label: { show: false }
                };
            }
        }

        const xAxisIndices = xAxes.map((_, i) => i);
        const firstTimes = plotState.plots[0].productData[plotState.plots[0].products[0]?.path]?.times || [];
        const dzStart = preserveView && currentView.start != null ? currentView.start : (firstTimes[0] || 0);
        const dzEnd = preserveView && currentView.end != null ? currentView.end : (firstTimes[firstTimes.length - 1] || 0);

        const dataZoom = [
            {
                type: 'inside',
                xAxisIndex: xAxisIndices,
                filterMode: 'none',
                zoomOnMouseWheel: false,
                moveOnMouseWheel: false,
                moveOnMouseMove: true,
                preventDefaultMouseMove: true,
                startValue: dzStart,
                endValue: dzEnd
            },
            {
                type: 'slider',
                xAxisIndex: xAxisIndices,
                bottom: 8,
                height: 20,
                borderColor: '#2a3358',
                backgroundColor: '#111627',
                fillerColor: 'rgba(107,138,253,0.15)',
                handleStyle: { color: '#6b8afd' },
                textStyle: { color: '#8892b0' },
                filterMode: 'none',
                startValue: dzStart,
                endValue: dzEnd
            }
        ];

        const option = {
            backgroundColor: 'transparent',
            animation: false,
            title: titles,
            legend: {
                type: 'scroll',
                top: 5,
                textStyle: { color: '#e0e6f0' }
            },
            axisPointer: {
                link: [{ xAxisIndex: 'all' }]
            },
            tooltip: {
                trigger: 'axis',
                backgroundColor: '#1a1f36',
                borderColor: '#2a3358',
                textStyle: { color: '#e0e6f0', fontSize: 12 },
                axisPointer: { type: 'line' },
                formatter: function(params) {
                    if (!params || params.length === 0) return '';
                    const t = params[0].axisValue;
                    let html = params[0].axisValueLabel + '<br/>';
                    for (const iv of plotState.intervals) {
                        const s = new Date(iv.start).getTime();
                        const e = new Date(iv.stop).getTime();
                        if (iv.label && t >= s && t <= e) {
                            html += '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:'
                                + iv.color + ';margin-right:4px;"></span>'
                                + '<b>' + iv.label + '</b><br/>';
                        }
                    }
                    for (const p of params) {
                        if (p.value != null) {
                            html += p.marker + ' ' + p.seriesName + ': ' + p.value[1] + '<br/>';
                        }
                    }
                    return html;
                }
            },
            grid: grids,
            xAxis: xAxes,
            yAxis: yAxes,
            dataZoom: dataZoom,
            series: series,
            graphic: []
        };

        // Data-only updates (pan/zoom refetch) merge series in place — no teardown, no resize,
        // so the chart doesn't flash. Structural changes (subplot count, plot type, log axis,
        // products) fall back to a full rebuild.
        const canMerge = dataOnly && lastStructureKey === structureKey(plotState.plots);
        suppressDataZoom = true;
        if (canMerge) {
            chart.setOption(option, { replaceMerge: ['series'], lazyUpdate: true });
        } else {
            chart.setOption(option, true);
            chart.resize();
            lastStructureKey = structureKey(plotState.plots);
        }
        suppressDataZoom = false;

        if (!preserveView) {
            currentView.start = dzStart;
            currentView.end = dzEnd;
        }

        // Render heatmap images after chart is set up
        const heatmapGraphics = [];
        for (const subplot of plotState.plots) {
            if (subplot.plotType === 'heatmap') {
                const graphic = buildSubplotHeatmap(subplot);
                if (graphic) heatmapGraphics.push(graphic);
            }
        }
        if (heatmapGraphics.length > 0) {
            chart.setOption({ graphic: heatmapGraphics });
        }

        const hasHeatmap = plotState.plots.some(sp => sp.plotType === 'heatmap');
        document.getElementById('btn-log-scale').style.display = hasHeatmap ? '' : 'none';
        document.getElementById('btn-log-y').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-clear').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-share').disabled = n === 0;

        setupMultiZoomHandler();
        updateShareURL();
    }

    function buildSubplotHeatmap(subplot) {
        const cache = subplot.productData[subplot.products[0]?.path];
        if (!cache || !cache.yAxis || cache.rows.length === 0) return null;

        const yBinsFlat = Array.isArray(cache.yAxis[0]) ? cache.yAxis[0] : cache.yAxis;

        let vMin = Infinity, vMax = -Infinity;
        for (const row of cache.rows) {
            if (!row) continue;
            for (const val of row) {
                if (val != null && !isNaN(val) && val > 0) {
                    if (val < vMin) vMin = val;
                    if (val > vMax) vMax = val;
                }
            }
        }
        if (vMin === Infinity) vMin = 1e-30;
        if (vMax === -Infinity) vMax = 1;
        if (vMin === vMax) vMax = vMin * 10;

        const img = renderSpectrogramImage(cache.times, cache.rows, yBinsFlat, vMin, vMax, subplot.logScale, currentView);
        if (!img) return null;

        subplot.lastHeatmapImg = img;
        return buildHeatmapGraphicElement(subplot._gridIndex, img);
    }

    function buildHeatmapGraphicElement(gridIdx, img) {
        const tStartPx = chart.convertToPixel({ xAxisIndex: gridIdx }, img.tStart);
        const tEndPx = chart.convertToPixel({ xAxisIndex: gridIdx }, img.tEnd);
        const yMinPx = chart.convertToPixel({ yAxisIndex: gridIdx }, img.yMin);
        const yMaxPx = chart.convertToPixel({ yAxisIndex: gridIdx }, img.yMax);

        const gridRect = chart.getModel().getComponent('grid', gridIdx).coordinateSystem.getRect();

        return {
            type: 'group',
            clipPath: {
                type: 'rect',
                shape: { x: gridRect.x, y: gridRect.y, width: gridRect.width, height: gridRect.height }
            },
            children: [{
                type: 'image',
                z: -1,
                style: {
                    image: img.canvas,
                    x: Math.min(tStartPx, tEndPx),
                    y: Math.min(yMinPx, yMaxPx),
                    width: Math.abs(tEndPx - tStartPx),
                    height: Math.abs(yMaxPx - yMinPx)
                },
                silent: true
            }]
        };
    }

    function repositionAllHeatmaps() {
        const graphics = [];
        for (const subplot of plotState.plots) {
            if (subplot.plotType === 'heatmap' && subplot.lastHeatmapImg) {
                graphics.push(buildHeatmapGraphicElement(subplot._gridIndex, subplot.lastHeatmapImg));
            }
        }
        if (graphics.length > 0) {
            chart.setOption({ graphic: graphics });
        }
    }

    function setupMultiZoomHandler() {
        chart.off('datazoom');
        chart.on('datazoom', () => {
            if (suppressDataZoom) return;
            if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
            zoomDebounceTimer = setTimeout(onMultiZoomPan, 200);
        });

        const chartDom = chart.getDom();
        chartDom.removeEventListener('wheel', handleWheel, true);
        chartDom.addEventListener('wheel', handleWheel, { passive: false, capture: true });

        // Y axis drag-to-pan
        let yDrag = null;
        chartDom.addEventListener('mousedown', (e) => {
            const domRect = chartDom.getBoundingClientRect();
            const hit = getSubplotAtY(e.clientX - domRect.left, e.clientY - domRect.top);
            if (hit && hit.onYAxis) {
                yDrag = { index: hit.index, startY: e.clientY, range: getYAxisRange(hit.index), rect: hit.rect };
                e.preventDefault();
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (!yDrag) return;
            const dy = e.clientY - yDrag.startY;
            const span = yDrag.range.max - yDrag.range.min;
            const shift = (dy / yDrag.rect.height) * span;
            setYAxisRange(yDrag.index, yDrag.range.min + shift, yDrag.range.max + shift);
        });
        window.addEventListener('mouseup', () => { yDrag = null; });

        // Y axis double-click to reset
        chartDom.addEventListener('dblclick', (e) => {
            const domRect = chartDom.getBoundingClientRect();
            const hit = getSubplotAtY(e.clientX - domRect.left, e.clientY - domRect.top);
            if (hit && hit.onYAxis) {
                resetYAxisRange(hit.index);
                e.preventDefault();
            }
        });

        // Reposition heatmap images on zoom/resize
        chart.off('finished');
        chart.on('finished', () => repositionAllHeatmaps());
    }

    async function onMultiZoomPan() {
        if (plotState.plots.length === 0) return;

        const view = getVisibleRange();
        if (!view) return;
        currentView.start = view.start;
        currentView.end = view.end;

        plotState.time_range.start = new Date(view.start).toISOString();
        plotState.time_range.stop = new Date(view.end).toISOString();
        updateURL();

        const viewRange = view.end - view.start;
        const buffer = viewRange * BUFFER_RATIO;

        if (fetchController) fetchController.abort();
        const controller = new AbortController();
        fetchController = controller;
        showFetchBar(true);

        const fetchStart = new Date(view.start - buffer).toISOString();
        const fetchStop = new Date(view.end + buffer).toISOString();

        const fetchJobs = [];
        for (const subplot of plotState.plots) {
            for (const prod of subplot.products) {
                const cache = subplot.productData[prod.path];
                if (!cache || cache.times.length === 0) continue;

                fetchJobs.push(
                    fetchData(prod.path, fetchStart, fetchStop, controller.signal)
                        .then(data => ({ cache, data }))
                        .catch(e => {
                            if (e.name !== 'AbortError') console.error('Fetch error for', prod.path, e);
                            return null;
                        })
                );
            }
        }

        const results = await Promise.all(fetchJobs);

        if (controller.signal.aborted) return;

        const valid = results.filter(r => r && r.data?.axes?.[0]?.values?.length);
        if (valid.length > 0) {
            for (const r of valid) resetProductCache(r.cache);
            for (const r of valid) mergeProductData(r.cache, r.data, view.start - buffer, view.end + buffer);
        }
        const anyFetched = valid.length > 0;

        if (anyFetched) {
            for (const subplot of plotState.plots) {
                for (const prod of subplot.products) {
                    evictProductCache(subplot.productData[prod.path], MAX_CACHE_POINTS);
                }
            }
            const liveView = getVisibleRange();
            if (liveView) {
                currentView.start = liveView.start;
                currentView.end = liveView.end;
            }
            renderAllSubplots(true, true);
        }

        if (fetchController === controller) {
            showFetchBar(false);
            fetchController = null;
        }
    }

    function resetProductCache(cache) {
        cache.times = [];
        cache.intervals = [];
        cache.rows = [];
        for (const cn of cache.columnNames) {
            cache.columns[cn] = [];
        }
    }

    // ===== Continuous Pan/Zoom =====
    //
    // On every zoom/pan, re-fetch the full visible range + buffer for all products.
    // Server-side resampling (max_points) keeps payloads bounded regardless of time range.

    const BUFFER_RATIO = 1.0;      // pre-fetch 1x view width on each side
    const POINTS_PER_PIXEL = 2.0;  // target density of the *visible* window (server resample target)
    const AXIS_PAD_RATIO = 0.5;    // x-axis domain padding beyond loaded data, so drag-pan has room

    function getVisibleRange() {
        // Read the actual axis extent from the chart — most reliable source
        const option = chart.getOption();
        if (!option || !option.dataZoom || option.dataZoom.length === 0) return null;
        const dz = option.dataZoom[0];

        // If startValue/endValue are set, use them directly
        if (dz.startValue != null && dz.endValue != null) {
            return { start: dz.startValue, end: dz.endValue };
        }

        // Fallback: compute from percentages relative to xAxis min/max
        const xAxis = option.xAxis[0];
        const axisMin = xAxis.min;
        const axisMax = xAxis.max;
        if (axisMin != null && axisMax != null && dz.start != null && dz.end != null) {
            const range = axisMax - axisMin;
            return {
                start: axisMin + range * (dz.start / 100),
                end: axisMin + range * (dz.end / 100)
            };
        }
        return null;
    }

    const ZOOM_SENSITIVITY = 0.0015;  // zoom amount per normalized wheel pixel
    const PAN_SENSITIVITY = 0.0015;   // pan amount (fraction of view) per normalized wheel pixel

    function getSubplotAtY(mouseX, mouseY) {
        for (let i = 0; i < plotState.plots.length; i++) {
            try {
                const rect = chart.getModel().getComponent('grid', i).coordinateSystem.getRect();
                if (mouseY >= rect.y && mouseY <= rect.y + rect.height) {
                    const onYAxis = mouseX < rect.x;
                    return { index: i, rect, onYAxis };
                }
            } catch (_) {}
        }
        return null;
    }

    function getYAxisRange(subplotIdx) {
        const subplot = plotState.plots[subplotIdx];
        if (subplot._yOverride) return subplot._yOverride;
        const axis = chart.getModel().getComponent('yAxis', subplotIdx);
        const extent = axis.axis.scale.getExtent();
        return { min: extent[0], max: extent[1] };
    }

    function setYAxisRange(subplotIdx, min, max) {
        plotState.plots[subplotIdx]._yOverride = { min, max };
        const yAxisOpt = [];
        for (let i = 0; i < plotState.plots.length; i++) {
            const ov = plotState.plots[i]._yOverride;
            yAxisOpt.push(ov ? { min: ov.min, max: ov.max, axisLabel: { showMinLabel: false, showMaxLabel: false } } : {});
        }
        chart.setOption({ yAxis: yAxisOpt });
    }

    function resetYAxisRange(subplotIdx) {
        delete plotState.plots[subplotIdx]._yOverride;
        renderAllSubplots(true);
    }

    // Wheel = zoom at the cursor (the natural convention); Shift+wheel = pan.
    // Drag-to-pan is handled natively by the inside dataZoom (moveOnMouseMove).
    function handleWheel(e) {
        e.preventDefault();
        e.stopPropagation();

        const chartDom = chart.getDom();
        const domRect = chartDom.getBoundingClientRect();
        const mouseX = e.clientX - domRect.left;
        const mouseY = e.clientY - domRect.top;
        const hit = getSubplotAtY(mouseX, mouseY);
        const delta = normalizeWheelDelta(e.deltaY, e.deltaMode);
        const isPan = e.shiftKey;

        // Y-axis gutter: zoom/pan the value axis of that subplot.
        if (hit && hit.onYAxis) {
            const range = getYAxisRange(hit.index);
            const span = range.max - range.min;
            if (isPan) {
                const shift = span * PAN_SENSITIVITY * delta;
                setYAxisRange(hit.index, range.min + shift, range.max + shift);
            } else {
                const cursorFrac = 1 - (mouseY - hit.rect.y) / hit.rect.height;
                const z = zoomRange(range.min, range.max, cursorFrac, delta * ZOOM_SENSITIVITY);
                if (z.end - z.start > span * 0.001) setYAxisRange(hit.index, z.start, z.end);
            }
            return;
        }

        // Plot body: zoom/pan the time axis.
        const view = getVisibleRange();
        if (!view) return;

        let next;
        if (isPan) {
            next = panRange(view.start, view.end, PAN_SENSITIVITY * delta);
        } else {
            const cursorFrac = hit
                ? Math.max(0, Math.min(1, (mouseX - hit.rect.x) / hit.rect.width))
                : 0.5;
            next = zoomRange(view.start, view.end, cursorFrac, delta * ZOOM_SENSITIVITY);
            if (next.end - next.start < 1000) return;  // floor at 1s
        }

        currentView.start = next.start;
        currentView.end = next.end;

        const padding = (next.end - next.start) * 2;
        const xAxisUpdate = plotState.plots.map(() => ({
            min: next.start - padding,
            max: next.end + padding
        }));
        const dzUpdate = [
            { startValue: next.start, endValue: next.end },
            { startValue: next.start, endValue: next.end }
        ];

        suppressDataZoom = true;
        chart.setOption({ xAxis: xAxisUpdate, dataZoom: dzUpdate });
        suppressDataZoom = false;

        if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
        zoomDebounceTimer = setTimeout(onMultiZoomPan, 200);
    }

    // ===== Task 8: URL State =====

    function stateToConfig() {
        const config = {
            version: 1,
            time_range: { ...plotState.time_range },
            plots: plotState.plots.map(subplotToConfig)
        };
        if (plotState.intervals.length > 0) {
            config.intervals = plotState.intervals;
        }
        return config;
    }

    function updateURL() {
        if (plotState.plots.length === 0) return;
        const config = stateToConfig();
        const encoded = configToBase64(config);
        const newUrl = window.location.pathname + '?config=' + encoded;
        history.replaceState(null, '', newUrl);
        if (document.getElementById('share-popover').style.display !== 'none') {
            updateShareURL();
        }
    }

    function loadFromURLParams() {
        const params = new URLSearchParams(window.location.search);

        // Backward compat: redirect old ?path=&start=&stop= to ?config=
        const path = params.get('path');
        const start = params.get('start');
        const stop = params.get('stop');
        if (path) {
            const config = {
                version: 1,
                time_range: { start: start, stop: stop },
                plots: [{ products: [{ path: path }], y_axis: { log: false } }]
            };
            const encoded = configToBase64(config);
            history.replaceState(null, '', window.location.pathname + '?config=' + encoded);
            applyConfig(config);
            return;
        }

        // New format: ?config=base64
        const configParam = params.get('config');
        if (configParam) {
            try {
                const config = base64ToConfig(configParam);
                applyConfig(config);
            } catch (e) {
                console.error('Invalid config URL:', e);
                setStatus('Invalid config in URL.');
            }
        }
    }

    function applyConfig(config) {
        plotState.time_range.start = config.time_range.start;
        plotState.time_range.stop = config.time_range.stop;

        if (config.time_range.start) {
            setDateInput(document.getElementById('start-time'), new Date(config.time_range.start));
        }
        if (config.time_range.stop) {
            setDateInput(document.getElementById('stop-time'), new Date(config.time_range.stop));
        }

        plotState.intervals = (config.intervals || []).map(iv => ({
            start: iv.start,
            stop: iv.stop,
            color: iv.color || 'rgba(100, 140, 255, 0.12)',
            label: iv.label || ''
        }));

        plotState.plots = config.plots.map(subplotFromConfig);
        updateEventsPanel();

        if (plotState.plots.length > 0 && plotState.plots[0].products.length > 0) {
            document.getElementById('product-path').value = plotState.plots[0].products[0].path;
            document.getElementById('btn-plot').disabled = false;
        }

        setTimeout(() => fetchAllAndRender(), 100);
    }

    async function fetchAllAndRender() {
        showLoading(true);
        setStatus('Fetching data...');

        const startTime = plotState.time_range.start;
        const stopTime = plotState.time_range.stop;
        if (!startTime || !stopTime) { showLoading(false); return; }

        const startISO = new Date(startTime).toISOString();
        const stopISO = new Date(stopTime).toISOString();
        const fetchStartMs = new Date(startTime).getTime();
        const fetchStopMs = new Date(stopTime).getTime();

        // Fetch all products in parallel
        const fetchPromises = [];
        for (const subplot of plotState.plots) {
            for (const prod of subplot.products) {
                fetchPromises.push(
                    fetchData(prod.path, startISO, stopISO)
                        .then(data => ({ subplot, path: prod.path, data }))
                        .catch(e => ({ subplot, path: prod.path, error: e }))
                );
            }
        }

        const results = await Promise.all(fetchPromises);

        for (const result of results) {
            if (result.error) {
                console.error('Fetch error for', result.path, result.error);
                continue;
            }
            const { subplot, path, data } = result;
            if (!data || !data.values || !data.axes || data.axes.length === 0) continue;

            const cache = subplot.productData[path];
            mergeProductData(cache, data, fetchStartMs, fetchStopMs);

            // Detect plot type from first product
            if (subplot.products[0].path === path) {
                subplot.plotType = detectPlotType(data);
            }
        }

        currentView = { start: fetchStartMs, end: fetchStopMs };
        renderAllSubplots();

        const totalProducts = plotState.plots.reduce((n, sp) => n + sp.products.length, 0);
        setStatus('Loaded ' + totalProducts + ' product(s) across ' + plotState.plots.length + ' subplot(s)');
        showLoading(false);
    }

    // ===== Sidebar Resize =====

    function initResize() {
        const handle = document.getElementById('resize-handle');
        const sidebar = document.querySelector('.sidebar');
        let startX, startWidth;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = sidebar.getBoundingClientRect().width;
            handle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            function onMouseMove(e) {
                const newWidth = Math.max(160, Math.min(startWidth + e.clientX - startX, window.innerWidth - 200));
                sidebar.style.width = newWidth + 'px';
                if (chart) chart.resize();
            }

            function onMouseUp() {
                handle.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // ===== Sidebar Collapse =====

    function initSidebarCollapse() {
        const sidebar = document.querySelector('.sidebar');
        const btn = document.getElementById('sidebar-collapse-btn');
        const handle = document.getElementById('resize-handle');

        function updateBtn() {
            const collapsed = sidebar.classList.contains('collapsed');
            btn.innerHTML = collapsed ? '&#9654;' : '&#9664;';
            btn.style.left = collapsed ? '0' : sidebar.getBoundingClientRect().width + 'px';
            handle.style.display = collapsed ? 'none' : '';
        }

        btn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            updateBtn();
        });

        sidebar.addEventListener('transitionend', () => updateBtn());

        new ResizeObserver(() => updateBtn()).observe(sidebar);
        updateBtn();
    }

    // ===== Controls Bar Collapse =====

    function initControlsCollapse() {
        const bar = document.querySelector('.controls-bar');
        const btn = document.getElementById('controls-collapse-btn');

        btn.addEventListener('click', () => {
            bar.classList.toggle('collapsed');
            btn.innerHTML = bar.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
        });
    }

    // ===== Presets =====

    async function loadPresets() {
        try {
            const resp = await fetch(API_BASE + 'get_presets');
            if (!resp.ok) return;
            const presets = await resp.json();
            if (presets.length === 0) return;

            const container = document.getElementById('presets-container');
            const list = document.getElementById('presets-list');
            const toggle = document.getElementById('presets-toggle');
            const arrow = document.getElementById('presets-arrow');

            toggle.addEventListener('click', () => {
                const open = list.style.display !== 'none';
                list.style.display = open ? 'none' : 'block';
                arrow.style.transform = open ? '' : 'rotate(90deg)';
            });

            for (const preset of presets) {
                const item = document.createElement('div');
                item.style.cssText = 'padding:4px 8px;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.85rem;';
                item.textContent = preset.name;
                item.title = preset.description || preset.name;
                item.addEventListener('mouseenter', () => { item.style.background = '#1e2640'; });
                item.addEventListener('mouseleave', () => { item.style.background = ''; });
                item.addEventListener('click', () => applyConfig(preset.config));
                list.appendChild(item);
            }

            container.style.display = '';
        } catch (e) {
            console.error('Failed to load presets:', e);
        }
    }

    // ===== Events Panel =====

    function updateEventsPanel() {
        const container = document.getElementById('events-container');
        const list = document.getElementById('events-list');
        const toggle = document.getElementById('events-toggle');
        const arrow = document.getElementById('events-arrow');

        list.innerHTML = '';

        if (plotState.intervals.length === 0) {
            container.style.display = 'none';
            return;
        }

        if (!toggle._bound) {
            toggle.addEventListener('click', () => {
                const open = list.style.display !== 'none';
                list.style.display = open ? 'none' : 'block';
                arrow.style.transform = open ? '' : 'rotate(90deg)';
            });
            toggle._bound = true;
        }

        const sorted = [...plotState.intervals].sort((a, b) => new Date(a.start) - new Date(b.start));
        for (const iv of sorted) {
            const fmtDate = d => new Date(d).toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, '');
            const dateRange = fmtDate(iv.start) + ' — ' + fmtDate(iv.stop);
            const tooltip = dateRange + (iv.label ? '\n' + iv.label : '');

            const item = document.createElement('div');
            item.style.cssText = 'padding:4px 8px;cursor:pointer;border-radius:4px;font-size:0.85rem;display:flex;align-items:center;gap:6px;';
            const swatch = document.createElement('span');
            swatch.style.cssText = 'width:10px;height:10px;border-radius:2px;flex-shrink:0;background:' + iv.color + ';';
            const text = document.createElement('span');
            text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            text.textContent = dateRange;
            item.appendChild(swatch);
            item.appendChild(text);
            item.title = tooltip;
            item.addEventListener('mouseenter', () => { item.style.background = '#1e2640'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('click', () => centerOnInterval(iv));
            list.appendChild(item);
        }

        container.style.display = '';
    }

    function centerOnInterval(iv) {
        const start = new Date(iv.start).getTime();
        const end = new Date(iv.stop).getTime();
        const duration = end - start;
        const padding = duration * 1.0;
        chart.dispatchAction({
            type: 'dataZoom',
            dataZoomIndex: 0,
            startValue: start - padding,
            endValue: end + padding
        });
    }

    // ===== Init =====

    document.addEventListener('DOMContentLoaded', () => {
        bindControls();
        initResize();
        initSidebarCollapse();
        initControlsCollapse();
        loadInventory();
        loadPresets();
        try {
            initChart();
        } catch (e) {
            console.error('Chart init failed:', e);
            setStatus('Chart library failed to load — plotting unavailable. Check network connection.');
        }
        loadFromURLParams();
    });
