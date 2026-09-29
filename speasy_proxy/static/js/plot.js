import {
  attachDatePicker, setDateInput, parseDateInput, parseUtc,
  setStatus, showLoading, showFetchBar, fallbackCopy,
  installErrorBoundary,
} from './common.js';
import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS, isSpzMetaKey, isSelectableProduct, browsableChildKeys, hasSelectableDescendant, paramSpecs, nodeTooltip } from './inventory-tree.js';
import {
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  detectPlotType, mergeSorted, spliceRows, mergeIntervals, evictProductCache,
  configToBase64, base64ToConfig, isCovered, resolutionSufficient, rangesOverlap, trimCacheWindow, cacheToCsv,
  structureKey, resampleTarget, plotTypeFromCache, computeValueRange, mergeValueRange, cleanText, distinctCrumbs,
  logHintFromRange,
  paramValue, withParam,
} from './plot-core.js';
import { ascendingSpectrogram } from './spectrogram.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
import { createPlotView, PRODUCT_MIME } from './plot-view.js';

    const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');
    const API_BASE = BASE_URL + '/';
    const MAX_CACHE_POINTS = 500000;
    const DAY_MS = 86400000;
    const MAX_SEARCH_RESULTS = 100;

    // Pan/zoom refetches the visible range + buffer for products whose cache doesn't
    // already cover it densely enough. Server-side resampling (max_points) keeps
    // payloads bounded regardless of time range.
    const BUFFER_RATIO = 1.0;          // pre-fetch 1x view width on each side
    const POINTS_PER_PIXEL = 2.0;      // target density of the *visible* window (server resample target)
    const ZOOM_IN_REFETCH_RATIO = 0.5; // zooming into < half the fetched span triggers a denser refetch
    const TRIM_WINDOW_RATIO = 2.0;     // keep cached data within view ± 2x view span; older data is dropped
    const YOUNG_FETCH_MS = 700;        // an in-flight pan fetch younger than this is cheap to abort...
    const MIN_USEFUL_OVERLAP = 0.5;    // ...unless it covers at least this share of the new request

    // State
    let plotView = null;
    let inventory = null;
    let selectedProduct = null;  // currently selected in the tree (not yet plotted)
    let leafIndex = [];
    let zoomDebounceTimer = null;

    // Multi-plot state — single source of truth
    const plotState = {
        time_range: { start: null, stop: null },
        plots: [],  // array of subplot objects
        intervals: []  // [{start, stop, color?, label?}] — vertical spans across all subplots
    };

    let currentView = { start: null, end: null };
    let inFlight = null;  // the running pan/zoom fetch: { controller, start, stop, t0 }
    let panFetchQueued = false;  // a pan/zoom arrived while a fetch was in flight — rerun once after it
    let lastStructureKey = null;  // structure of the last full chart build; used to pick merge vs rebuild
    const loadingSubplots = new Set();  // subplots currently fetching data (for the spinner)

    // ===== Inventory Tree =====

    async function loadInventory() {
        const container = document.getElementById('tree-container');
        container.innerHTML = '<div class="loading-text">Loading inventory...</div>';
        try {
            // version 2: keeps AMDA template-argument `choices` as real JSON
            // (see renderProductParams) instead of version 1's stringified repr.
            inventory = await fetchInventory(API_BASE, 'all', 2);
            renderTree(inventory);
            leafIndex = [];
            buildLeafIndex(inventory, []);
            // Subplots drawn before the inventory arrived have no parameter dropdowns yet.
            if (plotView && plotState.plots.length > 0) renderAllSubplots(true);
            // Restore the params box for a product already selected by the time this
            // resolves (a ?config=/?path= URL applies before the inventory fetch
            // finishes) -- otherwise a page refresh with e.g. a chosen coordinate_system
            // silently loses the visible box, even though the data itself round-trips.
            if (selectedProduct) {
                const leaf = leafIndex.find(l => l.path === selectedProduct);
                if (leaf) {
                    const prod = plotState.plots.flatMap(sp => sp.products).find(p => p.path === selectedProduct);
                    renderProductParams(leaf.node, prod);
                }
            }
        } catch (e) {
            container.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'loading-text';
            msg.textContent = 'Failed to load inventory: ' + e.message;
            container.appendChild(msg);
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry';
            retryBtn.className = 'retry-btn';
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

        if (isSelectableProduct(data)) {
            const div = productLeaf(data);
            div.appendChild(document.createTextNode(displayName));
            return div;
        }

        // Branch node: its children are only built the first time it is opened. Building the
        // whole ~100k-node inventory up front froze the page for ~0.6 s on every load.
        if (!hasSelectableDescendant(data)) return null;

        const branch = document.createElement('details');
        branch.className = 'tree-branch';
        const summary = document.createElement('summary');
        summary.textContent = displayName;
        summary.title = nodeTooltip(data);
        const children = document.createElement('div');
        children.className = 'tree-children';
        branch.appendChild(summary);
        branch.appendChild(children);
        let built = false;
        branch.addEventListener('toggle', () => {
            if (!branch.open || built) return;
            built = true;
            for (const ck of browsableChildKeys(data).sort()) {
                const child = buildTreeNode(data[ck], ck);
                if (child) children.appendChild(child);
            }
        });
        return branch;
    }

    // Where the product sits, then its inventory metadata (description, units, coverage...).
    function hoverText(head, node) {
        const metadata = nodeTooltip(node);
        return metadata ? head + '\n\n' + metadata : head;
    }

    // A product row in the tree or the search results. Click selects it (its params show
    // under the search box), double-click or "+" adds it as a new subplot, dragging it onto
    // a subplot overlays it there.
    function productLeaf(node) {
        const div = document.createElement('div');
        div.className = 'tree-leaf';
        div.title = hoverText(getProductPath(node), node);
        div.draggable = true;
        const add = document.createElement('button');
        add.className = 'tree-add';
        add.textContent = '+';
        add.title = 'Add as a new subplot';
        div.appendChild(add);

        const addAsNewSubplot = () => {
            selectProduct(node, div);
            addProductToPlot(selectedProduct, {});
            closeDrawer();
        };
        div.addEventListener('click', () => selectProduct(node, div));
        div.addEventListener('dblclick', addAsNewSubplot);
        add.addEventListener('click', (e) => { e.stopPropagation(); addAsNewSubplot(); });
        div.addEventListener('dragstart', (e) => {
            selectProduct(node, div);
            e.dataTransfer.setData(PRODUCT_MIME, selectedProduct);
            e.dataTransfer.effectAllowed = 'copy';
        });
        return div;
    }

    let previousSelectedLabel = null;

    function selectProduct(node, labelEl) {
        if (previousSelectedLabel) previousSelectedLabel.classList.remove('selected');
        labelEl.classList.add('selected');
        previousSelectedLabel = labelEl;

        selectedProduct = getProductPath(node);
        showProductPanel(selectedProduct);

        // Pre-fill date inputs only if they're empty — clicking a product to
        // inspect it shouldn't clobber a time window the user already set.
        const stopEl = document.getElementById('stop-time');
        const startEl = document.getElementById('start-time');
        if (!stopEl.value && !startEl.value && node.stop_date) {
            const stopDate = parseUtc(node.stop_date);
            const startDate = new Date(stopDate.getTime() - 7 * DAY_MS);
            setDateInput(stopEl, stopDate);
            setDateInput(startEl, startDate);
        }

        renderProductParams(node);
        updateURL();
    }

    function showProductPanel(path) {
        document.getElementById('product-panel').style.display = path ? '' : 'none';
        document.getElementById('product-path').textContent = path || '';
    }

    // ===== Per-product extra parameters (AMDA template args, SSC/3DView frames) =====

    let productParamSelects = {};   // key -> <select> currently shown in #product-params
    let productParamsKind = null;   // null | 'product_inputs' (AMDA) | 'coordinate_system' (SSC/3DView)
    let paramsGeneration = 0;       // guards a stale async frame-list fetch from clobbering a later selection
    let frames3d = [];              // 3DView frames once fetched; paramSpecs shows J2000 until then

    let cdpp3dviewFramesPromise = null;
    function get3dViewFrames() {
        if (!cdpp3dviewFramesPromise) {
            cdpp3dviewFramesPromise = fetch(API_BASE + 'get_3dview_frames')
                .then(r => r.ok ? r.json() : { frames: [] })
                .then(d => d.frames || [])
                .catch(() => []);
            // An empty result (network hiccup, or the provider's own frame fetch
            // failing server-side) isn't worth memoizing forever -- let the next
            // product selection retry instead of being stuck with no frames all session.
            cdpp3dviewFramesPromise.then(frames => {
                if (frames.length === 0) cdpp3dviewFramesPromise = null;
                else frames3d = frames;
            });
        }
        return cdpp3dviewFramesPromise;
    }

    function addParamSelect(container, key, labelText, options, selected) {
        const label = document.createElement('label');
        label.textContent = labelText;
        const select = document.createElement('select');
        for (const [optLabel, optValue] of options) {
            const opt = document.createElement('option');
            opt.value = optValue;
            opt.textContent = optLabel;
            select.appendChild(opt);
        }
        select.value = selected;
        select.addEventListener('change', onProductParamsChanged);
        productParamSelects[key] = select;
        container.appendChild(label);
        container.appendChild(select);
    }

    // A param select (coordinate_system, an AMDA argument, ...) only takes effect
    // once collectProductParams() is read again -- which otherwise only happens the
    // next time the product is added. If the product is already plotted, changing
    // a dropdown must re-fetch it live instead of silently doing nothing. The old
    // cache is dropped, not just refreshed: merging e.g. a GSE fetch into a cache
    // that already holds J2000 samples for the same product would silently mix
    // two coordinate frames in one series.
    function onProductParamsChanged() {
        const product = selectedProduct;
        if (!product) return;
        const newParams = collectProductParams();
        let changed = false;
        for (const subplot of plotState.plots) {
            const prod = subplot.products.find(p => p.path === product);
            if (!prod) continue;
            prod.coordinateSystem = newParams.coordinateSystem;
            prod.productInputs = newParams.productInputs;
            subplot.productData[product] = createProductCache(product);
            changed = true;
        }
        if (changed) {
            updateURL();
            fetchAllAndRender();
        }
    }

    // The sidebar's dropdowns for the selected product, one per paramSpecs entry.
    // presetValues (optional): a plotted product ({ coordinateSystem?, productInputs? })
    // whose choices to show instead of the defaults -- restores a page-refresh/shared
    // config's actual choice (see loadInventory) rather than silently resetting it.
    function renderProductParams(node, presetValues) {
        const container = document.getElementById('product-params');
        const myGeneration = ++paramsGeneration;
        const draw = (frames) => {
            container.innerHTML = '';
            productParamSelects = {};
            const specs = paramSpecs(node, frames);
            productParamsKind = specs.length === 0 ? null
                : specs[0].key === 'coordinate_system' ? 'coordinate_system' : 'product_inputs';
            for (const spec of specs) {
                addParamSelect(container, spec.key, spec.label, spec.choices,
                    presetValues ? paramValue(presetValues, spec) : spec.default);
            }
        };
        draw(frames3d);
        if (node.__spz_provider__ === 'cdpp3dview' && frames3d.length === 0) {
            get3dViewFrames().then(frames => {
                if (myGeneration === paramsGeneration && frames.length > 0) draw(frames);
            });
        }
    }

    // The toolbar's dropdowns for a plotted product; [] until the inventory is loaded.
    // A 3DView product asks for the frame list once, then redraws with it.
    let frames3dRequested = false;
    function paramSpecsOf(path) {
        const leaf = leafIndex.find(l => l.path === path);
        if (!leaf) return [];
        if (leaf.node.__spz_provider__ === 'cdpp3dview' && !frames3dRequested) {
            frames3dRequested = true;
            get3dViewFrames().then(frames => { if (frames.length > 0) renderAllSubplots(true); });
        }
        return paramSpecs(leaf.node, frames3d);
    }

    // Read back whatever renderProductParams built, in the shape fetchData() expects.
    function collectProductParams() {
        if (productParamsKind === 'coordinate_system') {
            const select = productParamSelects['coordinate_system'];
            return select ? { coordinateSystem: select.value } : {};
        }
        if (productParamsKind === 'product_inputs') {
            const inputs = {};
            for (const key of Object.keys(productParamSelects)) inputs[key] = productParamSelects[key].value;
            return Object.keys(inputs).length > 0 ? { productInputs: inputs } : {};
        }
        return {};
    }

    // ===== Search =====

    // Bound once in bindControls: loadInventory can run again (Retry).
    function onSearchInput(e) {
        if (!inventory) return;
        const query = e.target.value.trim().toLowerCase();
        if (query.length < 2) renderTree(inventory);
        else renderSearchResults(query);
    }

    function buildLeafIndex(node, breadcrumb) {
        if (!node || typeof node !== 'object') return;
        if (shouldSkipNode(node)) return;

        // The breadcrumb already ends with this product's own name (added by the parent).
        if (isSelectableProduct(node)) {
            leafIndex.push({
                name: breadcrumb.join(' / ').toLowerCase(),
                displayName: breadcrumb[breadcrumb.length - 1],
                breadcrumb,
                node,
                path: getProductPath(node),
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
        const results = leafIndex.filter(leaf => terms.every(t => leaf.name.includes(t)));

        if (results.length === 0) {
            container.innerHTML = '<div class="loading-text">No results found.</div>';
            return;
        }

        // Name first: a long path gets cut off at the end, and the name is what you pick by.
        const shown = results.slice(0, MAX_SEARCH_RESULTS);
        const crumbs = distinctCrumbs(shown.map(leaf => leaf.breadcrumb.slice(0, -1)));
        shown.forEach((leaf, i) => {
            const div = productLeaf(leaf.node);
            div.title = hoverText(leaf.breadcrumb.join(' / ') + '\n' + leaf.path, leaf.node);
            div.appendChild(document.createTextNode(leaf.displayName));
            const crumb = document.createElement('span');
            crumb.className = 'tree-crumb';
            crumb.textContent = crumbs[i];
            div.appendChild(crumb);
            container.appendChild(div);
        });

        if (results.length > MAX_SEARCH_RESULTS) {
            const more = document.createElement('div');
            more.className = 'loading-text';
            more.textContent = '... and ' + (results.length - MAX_SEARCH_RESULTS) + ' more results';
            container.appendChild(more);
        }
    }

    // ===== Chart and controls =====

    function initChart() {
        const el = document.getElementById('chart');
        plotView = createPlotView(el, { onViewChange, onAction: subplotAction, paramSpecsOf });
        let resizeRaf = 0;
        new ResizeObserver(() => {
            if (resizeRaf) return;
            resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; plotView.resize(); });
        }).observe(el);
    }

    function bindControls() {
        attachDatePicker(document.getElementById('start-time'));
        attachDatePicker(document.getElementById('stop-time'));

        document.getElementById('search-box').addEventListener('input', onSearchInput);
        for (const id of ['start-time', 'stop-time']) {
            document.getElementById(id).addEventListener('keydown', (e) => {
                if (e.key === 'Enter') applyTypedRange();
            });
        }

        document.getElementById('range-chips').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.pan) panTime(Number(btn.dataset.pan));
            else if (btn.dataset.ms) applyRelativeRange(Number(btn.dataset.ms));
        });
        document.getElementById('btn-now').addEventListener('click', () => {
            const width = (currentStopMs() - currentStartMs()) || DAY_MS;
            const now = Date.now();
            replotOverRange(now - width, now);
        });

        // Arrow keys pan the time window when not typing in a field.
        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); panTime(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); panTime(1); }
        });
        document.getElementById('btn-clear').addEventListener('click', clearAllPlots);

        document.getElementById('btn-export-png').addEventListener('click', exportPng);
        document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

        // Close the share popover on outside click
        document.addEventListener('click', (e) => {
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

    function download(href, filename) {
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        a.click();
    }

    function exportPng() {
        if (!plotView || plotState.plots.length === 0) return;
        download(plotView.toDataURL(2, '#0b0e17'), 'speasy-plot.png');
    }

    // Line data of the visible window, one CSV block per product; spectrograms are skipped.
    function exportCsv() {
        const startMs = currentView.start ?? -Infinity;
        const stopMs = currentView.end ?? Infinity;
        const caches = plotState.plots.flatMap(sp => sp.products.map(p => sp.productData[p.path]))
            .filter(cache => cache && cache.times.length > 0);
        const lines = caches.filter(cache => Object.keys(cache.columns).length > 0);
        if (lines.length === 0) { setStatus('No line data to export.'); return; }
        const blob = new Blob([lines.map(c => cacheToCsv(c, startMs, stopMs)).join('\n\n') + '\n'], { type: 'text/csv' });
        const href = URL.createObjectURL(blob);
        download(href, 'speasy-export.csv');
        URL.revokeObjectURL(href);
        const skipped = caches.length - lines.length;
        setStatus('Exported ' + lines.length + ' product(s) to CSV.'
            + (skipped > 0 ? ' (' + skipped + ' spectrogram(s) skipped — CSV is for line data.)' : ''));
    }

    // Per-subplot edits reported by the chart (its toolbar, title chips and drop targets).
    const subplotActions = {
        logY: ({ index }) => editSubplot(index, (sp) => {
            sp.y_axis.log = !sp.y_axis.log;
            sp._yScaleAuto = false;
            delete sp._yOverride;  // a manual linear range can start at <= 0, invalid on log
        }),
        logZ: ({ index }) => editSubplot(index, (sp) => {
            sp.logScale = !sp.logScale;
            sp._zScaleAuto = false;
        }),
        colormap: ({ index, value }) => editSubplot(index, (sp) => { sp.colormap = value; }),
        productParam: ({ index, path, key, value }) => setProductParam(index, path, key, value),
        remove: ({ index }) => removeSubplot(index),
        removeProduct: ({ index, path }) => removeProductFromSubplot(index, path),
        addProduct: ({ index, path }) => addProductToPlot(path, index === null ? {} : { into: index }),
        insertProduct: ({ index, path }) => addProductToPlot(path, { at: index }),
    };

    function subplotAction(action) {
        subplotActions[action.type]?.(action);
    }

    // Only this subplot's copy of the product changes; its cache is dropped, not merged,
    // so two frames or template settings never mix in one series.
    function setProductParam(index, path, key, value) {
        const subplot = plotState.plots[index];
        if (!subplot) return;
        subplot.products = subplot.products.map(p => (p.path === path ? withParam(p, key, value) : p));
        subplot.productData[path] = createProductCache(path);
        const leaf = path === selectedProduct && leafIndex.find(l => l.path === path);
        if (leaf) renderProductParams(leaf.node, subplot.products.find(p => p.path === path));
        updateURL();
        fetchAllAndRender();
    }

    function editSubplot(index, edit) {
        const subplot = plotState.plots[index];
        if (!subplot) return;
        edit(subplot);
        renderAllSubplots(true);
        updateURL();
    }

    // target: { into: i } overlays on subplot i, { at: i } inserts a new subplot at i, {}
    // appends one. Params (coordinate system, AMDA arguments) come from the sidebar panel,
    // which describes the selected product only.
    function addProductToPlot(product, { into = null, at = plotState.plots.length } = {}) {
        if (!plotView) { setStatus('Chart not available — check network connection.'); return; }
        if (!product) { setStatus('No product selected.'); return; }
        const range = typedRange();
        if (!range) return;

        const existing = into === null ? null : plotState.plots[into];
        if (existing && existing.products.some(p => p.path === product)) {
            setStatus('Product already in this subplot.');
            return;
        }

        plotState.time_range.start = range.start.toISOString();
        plotState.time_range.stop = range.stop.toISOString();

        const subplot = existing || createSubplotData();
        if (!existing) plotState.plots.splice(at, 0, subplot);
        const params = product === selectedProduct ? collectProductParams() : {};
        subplot.products.push({ path: product, label: product, ...params });
        subplot.productData[product] = createProductCache(product);

        updateURL();
        fetchProductAndRender(subplot, product);
    }

    function removeSubplot(index) {
        plotState.plots.splice(index, 1);
        if (plotState.plots.length === 0) {
            clearAllPlots();
            return;
        }
        renderAllSubplots(true);
        updateURL();
    }

    function removeProductFromSubplot(subplotIndex, productPath) {
        const subplot = plotState.plots[subplotIndex];
        if (!subplot) return;
        subplot.products = subplot.products.filter(p => p.path !== productPath);
        delete subplot.productData[productPath];
        if (subplot.products.length === 0) {
            removeSubplot(subplotIndex);
        } else {
            // The first product drives the plot type: re-detect in case it was the one removed.
            subplot.plotType = plotTypeFromCache(subplot.productData[subplot.products[0].path]);
            renderAllSubplots(true);
            updateURL();
        }
    }

    function clearAllPlots() {
        plotState.plots = [];
        plotView.clear();
        syncBarActions();
        history.replaceState(null, '', window.location.pathname);
        setStatus('Ready');
    }

    // The top bar's actions need something plotted; disabling (not hiding) them keeps
    // the bar from reflowing as subplots come and go.
    function syncBarActions() {
        const none = plotState.plots.length === 0;
        for (const id of ['btn-export-png', 'btn-export-csv', 'btn-share', 'btn-clear']) {
            document.getElementById(id).disabled = none;
        }
    }

    function updateShareURL() {
        if (plotState.plots.length === 0) return;
        const config = stateToConfig();
        const encoded = configToBase64(config);
        // origin + pathname, not BASE_URL: behind a reverse proxy BASE_URL already
        // carries the root_path prefix that pathname repeats.
        const fullUrl = window.location.origin + window.location.pathname + '?config=' + encoded;
        document.getElementById('share-url').value = fullUrl;
    }

    async function fetchProductAndRender(subplot, productPath) {
        const cache = subplot.productData[productPath];
        const prod = subplot.products.find(p => p.path === productPath);
        const startMs = Date.parse(plotState.time_range.start);
        const stopMs = Date.parse(plotState.time_range.stop);
        trackLoading(+1);
        loadingSubplots.add(subplot);
        renderAllSubplots(true);  // the new subplot shows at once, with its loading dot
        setStatus('Fetching ' + productPath + '...');
        try {
            const data = await fetchData(productPath, startMs, stopMs, undefined, prod);
            if (!isLive(subplot, productPath, cache)) return;
            if (!hasData(data)) { setStatus('No data returned for ' + productPath); return; }
            ingest(subplot, productPath, cache, data, startMs, stopMs);
            setStatus('Added ' + productPath);
        } catch (e) {
            setStatus('Error fetching ' + productPath + ': ' + e.message);
            console.error(e);
        } finally {
            trackLoading(-1);
            loadingSubplots.delete(subplot);
            // Also on failure: the subplot is drawn empty, with its ✕, instead of lingering unseen.
            if (plotState.plots.length > 0) renderAllSubplots(true);
        }
    }

    // A fetch result still belongs on screen only if its cache is the live one: a new
    // range, a params change or a remove/re-add replaces the cache while it is in flight.
    const isLive = (subplot, path, cache) =>
        plotState.plots.includes(subplot) && subplot.productData[path] === cache;

    const hasData = (data) => !!data?.values && data.axes?.length > 0;

    // The first product of a subplot decides its plot type and scale hints.
    function ingest(subplot, path, cache, data, startMs, stopMs) {
        mergeProductData(cache, data, startMs, stopMs);
        if (subplot.products[0].path !== path) return;
        subplot.plotType = detectPlotType(data);
        applyScaleHints(subplot, data);
    }

    // Several loads can overlap; the overlay stays up until the last one ends.
    let activeLoads = 0;
    function trackLoading(delta) {
        activeLoads += delta;
        showLoading(activeLoads > 0);
    }

    // ===== Time navigation (quick-range chips + pan) =====

    function currentStopMs() {
        const d = parseDateInput(document.getElementById('stop-time').value);
        return d ? d.getTime() : Date.now();
    }

    function currentStartMs() {
        const d = parseDateInput(document.getElementById('start-time').value);
        return d ? d.getTime() : currentStopMs() - DAY_MS;
    }

    // Set the window and re-plot fresh. Caches are reset so a new (possibly disjoint)
    // window fetches clean data instead of merging across a time gap.
    function replotOverRange(startMs, stopMs) {
        setTimeRange(startMs, stopMs);

        if (plotState.plots.length === 0) return;
        for (const sp of plotState.plots) {
            for (const prod of sp.products) sp.productData[prod.path] = createProductCache(prod.path);
        }
        updateURL();
        fetchAllAndRender();
    }

    // The one place the time window changes: state and the start/stop fields stay in step,
    // so chips, Now and arrow keys always work from what is on screen.
    function setTimeRange(startMs, stopMs) {
        plotState.time_range.start = new Date(startMs).toISOString();
        plotState.time_range.stop = new Date(stopMs).toISOString();
        setDateInput(document.getElementById('start-time'), new Date(startMs));
        setDateInput(document.getElementById('stop-time'), new Date(stopMs));
    }

    function applyRelativeRange(spanMs) {
        const stop = currentStopMs();
        replotOverRange(stop - spanMs, stop);
    }

    function panTime(dir) {
        const start = currentStartMs(), stop = currentStopMs();
        const width = (stop - start) || DAY_MS;
        replotOverRange(start + dir * width, stop + dir * width);
    }

    // The start/stop fields as Dates, or null (with a status message) when invalid.
    function typedRange() {
        const start = parseDateInput(document.getElementById('start-time').value);
        const stop = parseDateInput(document.getElementById('stop-time').value);
        if (start && stop && stop > start) return { start, stop };
        setStatus('Please set a valid UTC start and stop (DD-MM-YYYY HH:MM), stop after start.');
        return null;
    }

    function applyTypedRange() {
        const range = typedRange();
        if (range) replotOverRange(range.start.getTime(), range.stop.getTime());
    }

    async function fetchData(product, startTime, stopTime, signal, extraParams) {
        const startISO = new Date(startTime).toISOString();
        const stopISO = new Date(stopTime).toISOString();
        const chartWidth = document.getElementById('chart')?.clientWidth || 0;
        const maxPoints = resampleTarget(chartWidth, POINTS_PER_PIXEL, BUFFER_RATIO);
        return apiFetchData({
            baseUrl: API_BASE, path: product, startISO, stopISO, maxPoints, signal,
            coordinateSystem: extraParams?.coordinateSystem,
            productInputs: extraParams?.productInputs,
        });
    }

    // ISTP CDF variables carry a SCALETYP attribute ('linear'/'log') describing how
    // that variable's own values should be displayed. Normalizes it to a boolean, or
    // null when absent/unrecognized (AMDA rarely sets it; CDAWeb — real ISTP CDFs —
    // reliably does).
    function scaleTypToLog(meta) {
        const v = ((meta && meta.SCALETYP) || '').toString().toLowerCase();
        if (v === 'log') return true;
        if (v === 'linear') return false;
        return null;
    }

    // Seeds Log Z / Log Y from the first product's ISTP hints the moment its data
    // arrives — a spectrogram's energy axis is almost always log-spaced, and a linear
    // Y axis squashes it into a sliver near the bottom. Only while the user hasn't
    // already made an explicit choice for that axis (_yScaleAuto/_zScaleAuto) — a
    // click always sticks, hints never overwrite it.
    function applyScaleHints(subplot, data) {
        if (subplot._zScaleAuto) {
            const zHint = scaleTypToLog(data.values && data.values.meta);
            if (zHint !== null) subplot.logScale = zHint;
        }
        if (subplot._yScaleAuto) {
            const yMeta = subplot.plotType === 'heatmap' && data.axes.length >= 2
                ? data.axes[1].meta
                : (data.values && data.values.meta);
            const yHint = scaleTypToLog(yMeta) ?? (subplot.plotType === 'heatmap' && data.axes.length >= 2
                ? logHintFromRange(data.axes[1].values)
                : null);
            if (yHint !== null) subplot.y_axis.log = yHint;
        }
    }

    // AMDA fills CATDESC with the parameter id, which the hover text already shows.
    function istpDescription(meta, path) {
        const desc = cleanText(meta.CATDESC);
        return desc === path.split('/').pop() ? '' : desc;
    }

    function mergeProductData(cache, json, fetchStart, fetchStop) {
        const rawTimes = json.axes[0].values;
        const newTimes = rawTimes.map(t => t / 1e6);
        const columns = json.columns || [];
        const meta = json.values.meta || {};
        const unit = cleanText(meta.UNITS);

        const isHeatmap = detectPlotType(json) === 'heatmap';
        const hasYAxis = isHeatmap && json.axes.length >= 2;
        const { yAxis, rows: newValues } = hasYAxis
            ? ascendingSpectrogram(json.axes[1].values, json.values.values)
            : { yAxis: null, rows: json.values.values };

        if (cache.times.length === 0) {
            cache.times = newTimes;
            cache.unit = unit;
            cache.title = cleanText(meta.FIELDNAM || meta.LABLAXIS);
            cache.description = istpDescription(meta, cache.path);
            cache.intervals = [[fetchStart, fetchStop]];
            cache.fetchSpan = fetchStop - fetchStart;
            cache.displayType = meta.DISPLAY_TYPE || '';

            if (isHeatmap) {
                if (hasYAxis) {
                    cache.yAxis = yAxis;
                    const axisMeta = json.axes[1].meta || {};
                    cache.yAxisName = cleanText(axisMeta.LABLAXIS || axisMeta.FIELDNAM || json.axes[1].name);
                    cache.yAxisUnit = cleanText(axisMeta.UNITS);
                } else {
                    cache.yAxis = newValues[0] ? newValues[0].map((_, i) => i) : [];
                }
                cache.rows = newValues;
                cache.columnNames = columns;
                cache.valueRange = computeValueRange(newValues);
            } else {
                cache.columnNames = columns.length > 0 ? columns :
                    (newValues[0] ? newValues[0].map((_, i) => 'col_' + i) : ['value']);
                for (let c = 0; c < cache.columnNames.length; c++) {
                    cache.columns[cache.columnNames[c]] = newValues.map(row => row[c]);
                }
            }
        } else {
            if (isHeatmap) {
                const merged = spliceRows(cache.times, cache.rows, newTimes, newValues, fetchStart, fetchStop);
                cache.times = merged.times;
                cache.rows = merged.rows;
                cache.valueRange = mergeValueRange(cache.valueRange, cache.rows, newValues);
            } else {
                const merged = mergeSorted(cache.times, newTimes, cache.columns, newValues, cache.columnNames);
                cache.times = merged.times;
                cache.columns = merged.columns;
            }
            cache.intervals = mergeIntervals(cache.intervals.concat([[fetchStart, fetchStop]]));
            // Track the widest fetched span — max_points is spread across it, so it
            // governs resolution. Using Math.max prevents a small recent fetch from
            // masking that earlier data may be sparse (which would block zoom-in
            // refetches via resolutionSufficient).
            cache.fetchSpan = Math.max(cache.fetchSpan || 0, fetchStop - fetchStart);
        }
    }

    function renderAllSubplots(preserveView, dataOnly) {
        const n = plotState.plots.length;
        if (n === 0) return;
        if (!preserveView || currentView.start == null) currentView = initialView();

        // Data-only updates (pan/zoom refetch) swap data into the existing charts, so
        // nothing flashes. Structural changes (subplot count, plot type, log toggle,
        // products) rebuild them.
        if (dataOnly && lastStructureKey === structureKey(plotState.plots)) {
            plotView.update(plotState.plots);
        } else {
            plotView.render(plotState.plots, currentView, { intervals: plotState.intervals, loading: loadingSubplots });
            lastStructureKey = structureKey(plotState.plots);
        }

        syncBarActions();
        updateShareURL();
    }

    // The requested time range, or the first product's loaded span when there is none.
    function initialView() {
        const start = Date.parse(plotState.time_range.start);
        const stop = Date.parse(plotState.time_range.stop);
        if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) return { start, end: stop };
        const first = plotState.plots[0];
        const t = first.productData[first.products[0]?.path]?.times || [];
        return { start: t[0] || 0, end: t[t.length - 1] || 1 };
    }

    // Every user pan/zoom (wheel, drag, keys, events list) lands here; the refetch waits for the
    // gesture to settle.
    function onViewChange(view) {
        currentView = { start: view.start, end: view.end };
        if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
        zoomDebounceTimer = setTimeout(onMultiZoomPan, 200);
    }

    async function onMultiZoomPan() {
        if (plotState.plots.length === 0) return;

        const view = plotView.getView();
        if (view.start == null) return;
        currentView.start = view.start;
        currentView.end = view.end;

        setTimeRange(view.start, view.end);
        updateURL();

        const viewRange = view.end - view.start;
        const buffer = viewRange * BUFFER_RATIO;

        // Free panning: products whose cache already covers the visible range + buffer
        // at sufficient density keep their data — no refetch, no reset. Zooming in past
        // ZOOM_IN_REFETCH_RATIO still refetches so resolution follows the view.
        const reqStart = view.start - buffer;
        const reqStop = view.end + buffer;
        const toFetch = [];
        for (const subplot of plotState.plots) {
            for (const prod of subplot.products) {
                const cache = subplot.productData[prod.path];
                if (!cache || cache.times.length === 0) continue;
                if (isCovered(cache.intervals, reqStart, reqStop) &&
                    resolutionSufficient(cache.fetchSpan, reqStop - reqStart, ZOOM_IN_REFETCH_RATIO)) continue;
                toFetch.push({ path: prod.path, cache });
            }
        }

        // Everything buffered: the charts already hold this data (the view refreshes
        // spectrogram images itself once a gesture settles).
        if (toFetch.length === 0) return;

        // A pan/zoom fetch is already running. Pan/zoom gestures stream view changes faster
        // than upstream fetches complete; firing a parallel fetch per event produced a
        // request storm. Queue exactly one rerun with the latest view instead. Abort
        // the in-flight fetch only when it is mostly useless for the current request:
        // disjoint ranges are pure waste, and a young fetch with little overlap is
        // cheap to discard. Otherwise let it finish — aborting useful fetches starves
        // the cache (nothing ever completes, coverage never grows) and churns the server.
        if (inFlight) {
            const overlapMs = Math.max(0, Math.min(inFlight.stop, reqStop) - Math.max(inFlight.start, reqStart));
            const young = performance.now() - inFlight.t0 < YOUNG_FETCH_MS;
            if (overlapMs === 0 || (young && overlapMs < MIN_USEFUL_OVERLAP * (reqStop - reqStart))) {
                inFlight.controller.abort();
            }
            panFetchQueued = true;
            return;
        }
        const controller = new AbortController();
        const mine = { controller, start: reqStart, stop: reqStop, t0: performance.now() };
        inFlight = mine;
        showFetchBar(true);

        const fetchJobs = toFetch.map(({ path, cache }) =>
            fetchData(path, reqStart, reqStop, controller.signal)
                .then(data => ({ cache, data }))
                .catch(e => {
                    if (e.name !== 'AbortError') console.error('Fetch error for', path, e);
                    return null;
                })
        );

        try {
            const results = await Promise.all(fetchJobs);

            if (!controller.signal.aborted) {
                const valid = results.filter(r => r && r.data?.axes?.[0]?.values?.length);
                if (valid.length > 0) {
                    // Reset only caches disjoint from the new range (never draw a line
                    // across a time gap). Overlapping caches merge in place, so data
                    // stays on screen while the refetch is in flight instead of blanking.
                    for (const r of valid) {
                        if (!rangesOverlap(r.cache.intervals, reqStart, reqStop)) resetProductCache(r.cache);
                    }
                    for (const r of valid) mergeProductData(r.cache, r.data, reqStart, reqStop);

                    // Bound every cache to a rolling window around the live view:
                    // merged data accumulates otherwise, and re-zipping/re-parsing
                    // 100k+ points per series makes every pan/zoom render stutter.
                    const liveView = plotView.getView();
                    const curStart = liveView ? liveView.start : view.start;
                    const curEnd = liveView ? liveView.end : view.end;
                    const keepSpan = (curEnd - curStart) * TRIM_WINDOW_RATIO;
                    for (const subplot of plotState.plots) {
                        for (const prod of subplot.products) {
                            const cache = subplot.productData[prod.path];
                            trimCacheWindow(cache, curStart - keepSpan, curEnd + keepSpan);
                            evictProductCache(cache, MAX_CACHE_POINTS);
                        }
                    }
                    if (liveView) {
                        currentView.start = liveView.start;
                        currentView.end = liveView.end;
                    }
                    renderAllSubplots(true, true);
                }
            }
        } finally {
            if (inFlight === mine) {
                showFetchBar(false);
                inFlight = null;
            }
            if (panFetchQueued) {
                // At most one queued rerun per fetch; it re-reads the live view,
                // so a whole gesture stream collapses to the final state.
                panFetchQueued = false;
                await onMultiZoomPan();
            }
        }
    }

    function resetProductCache(cache) {
        cache.times = [];
        cache.intervals = [];
        cache.fetchSpan = 0;
        cache.rows = [];
        cache.valueRange = null;
        for (const cn of cache.columnNames) {
            cache.columns[cn] = [];
        }
    }


    // ===== URL State =====

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
            applyConfig({ version: 1, time_range: { start, stop }, plots: [{ products: [{ path }] }] });
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
        const startDate = config.time_range.start ? parseUtc(config.time_range.start) : null;
        let stopDate = config.time_range.stop ? parseUtc(config.time_range.stop) : null;
        // A bare "YYYY-MM-DD" (e.g. the legacy ?start=&stop= link format, both parsed as
        // UTC midnight) used for both start and stop is meant as "that whole day", not a
        // zero-width instant -- left alone it silently produces a request the backend
        // rejects as invalid every time this link is opened.
        if (startDate && stopDate && stopDate.getTime() <= startDate.getTime()) {
            stopDate = new Date(startDate.getTime() + DAY_MS);
        }
        plotState.time_range.start = startDate ? startDate.toISOString() : null;
        plotState.time_range.stop = stopDate ? stopDate.toISOString() : null;

        if (startDate) setDateInput(document.getElementById('start-time'), startDate);
        if (stopDate) setDateInput(document.getElementById('stop-time'), stopDate);

        plotState.intervals = (config.intervals || []).map(iv => ({
            start: iv.start,
            stop: iv.stop,
            color: iv.color || 'rgba(100, 140, 255, 0.12)',
            label: iv.label || ''
        }));

        plotState.plots = config.plots.map(subplotFromConfig);
        updateEventsPanel();

        // Selects the first product so loadInventory can restore its params panel.
        if (plotState.plots.length > 0 && plotState.plots[0].products.length > 0) {
            selectedProduct = plotState.plots[0].products[0].path;
            showProductPanel(selectedProduct);
        }

        // Presets land here too: the URL must describe what is now on screen.
        updateURL();
        fetchAllAndRender();
    }

    async function fetchAllAndRender() {
        if (!plotView) { setStatus('Chart not available — check network connection.'); return; }
        const startMs = Date.parse(plotState.time_range.start);
        const stopMs = Date.parse(plotState.time_range.stop);
        if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return;

        trackLoading(+1);
        setStatus('Fetching data...');
        const jobs = plotState.plots.flatMap(subplot => subplot.products.map(prod => {
            const job = { subplot, path: prod.path, cache: subplot.productData[prod.path] };
            return fetchData(prod.path, startMs, stopMs, undefined, prod)
                .then(data => ({ ...job, data }), error => ({ ...job, error }));
        }));
        const results = (await Promise.all(jobs)).filter(r => isLive(r.subplot, r.path, r.cache));
        trackLoading(-1);
        if (results.length === 0 && jobs.length > 0) return;  // superseded by a newer load

        const errors = [];
        for (const r of results) {
            if (r.error) {
                console.error('Fetch error for', r.path, r.error);
                errors.push(r.path + ' (' + r.error.message + ')');
            } else if (!hasData(r.data)) {
                errors.push(r.path + ' (no data returned)');
            } else {
                ingest(r.subplot, r.path, r.cache, r.data, startMs, stopMs);
            }
        }

        currentView = { start: startMs, end: stopMs };
        renderAllSubplots();
        const totalProducts = plotState.plots.reduce((n, sp) => n + sp.products.length, 0);
        const loaded = results.length - errors.length;
        setStatus('Loaded ' + loaded + '/' + totalProducts + ' product(s) across ' + plotState.plots.length + ' subplot(s)'
            + (errors.length > 0 ? '. Errors: ' + errors.join('; ') : ''));
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
                sidebar.style.width = newWidth + 'px';  // the chart's ResizeObserver follows
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

    // On a phone the sidebar is a drawer ('open'); on a wider screen it collapses in place.
    const phoneLayout = window.matchMedia('(max-width: 768px), (max-height: 500px)');

    function closeDrawer() {
        document.querySelector('.sidebar').classList.remove('open');
    }

    function initSidebarCollapse() {
        const sidebar = document.querySelector('.sidebar');
        const btn = document.getElementById('sidebar-collapse-btn');
        const handle = document.getElementById('resize-handle');

        function updateBtn() {
            if (phoneLayout.matches) {
                btn.innerHTML = '&#9776;';
                btn.style.left = '';
                return;
            }
            const collapsed = sidebar.classList.contains('collapsed');
            btn.innerHTML = collapsed ? '&#9654;' : '&#9664;';
            btn.style.left = collapsed ? '0' : sidebar.getBoundingClientRect().width + 'px';
            handle.style.display = collapsed ? 'none' : '';
        }

        btn.addEventListener('click', () => {
            sidebar.classList.toggle(phoneLayout.matches ? 'open' : 'collapsed');
            updateBtn();
        });
        document.getElementById('sidebar-backdrop').addEventListener('click', closeDrawer);

        sidebar.addEventListener('transitionend', () => updateBtn());
        phoneLayout.addEventListener('change', updateBtn);

        new ResizeObserver(() => updateBtn()).observe(sidebar);
        updateBtn();
        // A phone opening a bare /plot has nothing to show yet: start in the product list.
        if (phoneLayout.matches && !location.search) sidebar.classList.add('open');
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

            const list = document.getElementById('presets-list');
            for (const preset of presets) {
                const item = document.createElement('div');
                item.className = 'side-item';
                item.textContent = preset.name;
                item.title = preset.description || preset.name;
                item.addEventListener('click', () => { applyConfig(preset.config); closeDrawer(); });
                list.appendChild(item);
            }
            document.getElementById('presets-container').hidden = false;
        } catch (e) {
            console.error('Failed to load presets:', e);
        }
    }

    // ===== Events Panel =====

    const fmtEventDate = (d) => parseUtc(d).toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, '');

    function updateEventsPanel() {
        const list = document.getElementById('events-list');
        list.innerHTML = '';
        document.getElementById('events-container').hidden = plotState.intervals.length === 0;

        const sorted = [...plotState.intervals].sort((a, b) => parseUtc(a.start) - parseUtc(b.start));
        for (const iv of sorted) {
            const dateRange = fmtEventDate(iv.start) + ' — ' + fmtEventDate(iv.stop);
            const item = document.createElement('div');
            item.className = 'side-item';
            item.title = dateRange + (iv.label ? '\n' + iv.label : '');
            const swatch = document.createElement('span');
            swatch.className = 'side-swatch';
            swatch.style.background = iv.color;
            const text = document.createElement('span');
            text.textContent = dateRange;
            item.appendChild(swatch);
            item.appendChild(text);
            item.addEventListener('click', () => { centerOnInterval(iv); closeDrawer(); });
            list.appendChild(item);
        }
    }

    // The event fills the middle third of the view.
    function centerOnInterval(iv) {
        const start = parseUtc(iv.start).getTime();
        const end = parseUtc(iv.stop).getTime();
        const pad = end - start;
        const view = { start: start - pad, end: end + pad };
        plotView.setView(view);
        onViewChange(view);
    }

    // ===== Init =====

    document.addEventListener('DOMContentLoaded', () => {
        installErrorBoundary('status-bar');
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

    // Seam for the Vitest suite: the page glue above is not otherwise reachable from a
    // test, and asserting on source text instead of behaviour proved worthless.
    export const __test__ = {
        plotState, initChart, bindControls, renderAllSubplots, removeProductFromSubplot,
        updateShareURL, mergeProductData, applyScaleHints, applyConfig, getPlotView: () => plotView,
        renderProductParams, collectProductParams, selectProduct, onProductParamsChanged, loadInventory,
        subplotAction, setSelectedProduct: (path) => { selectedProduct = path; },
        replotOverRange, loadFromURLParams, base64ToConfig, onSearchInput, onMultiZoomPan,
        __resetCdpp3dviewFramesCache: () => { cdpp3dviewFramesPromise = null; frames3d = []; frames3dRequested = false; },
    };
