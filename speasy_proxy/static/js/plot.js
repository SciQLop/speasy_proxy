import {
  attachDatePicker, setDateInput, parseDateInput,
  setStatus, showLoading, showFetchBar, fallbackCopy,
  installErrorBoundary,
} from './common.js';
import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS, isSpzMetaKey, isSelectableProduct, browsableChildKeys, hasSelectableDescendant } from './inventory-tree.js';
import {
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  detectPlotType, mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache,
  configToBase64, base64ToConfig, isCovered, resolutionSufficient, rangesOverlap, trimCacheWindow, cacheToCsv,
  structureKey, resampleTarget, plotTypeFromCache, computeValueRange, mergeValueRange, cleanText,
} from './plot-core.js';
import { ascendingSpectrogram } from './spectrogram.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
import { createPlotView } from './plot-view.js';

    const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');
    const API_BASE = BASE_URL + '/';
    const MAX_CACHE_POINTS = 500000;

    // State
    let plotView = null;
    let inventory = null;
    let selectedProduct = null;  // currently selected in the tree (not yet plotted)
    let leafIndex = [];
    let zoomDebounceTimer = null;

    // Multi-plot state — single source of truth
    const plotState = {
        version: 1,
        time_range: { start: null, stop: null },
        plots: [],  // array of subplot objects
        intervals: []  // [{start, stop, color?, label?}] — vertical spans across all subplots
    };

    let currentView = { start: null, end: null };
    let fetchController = null;
    let panFetchQueued = false;  // a pan/zoom arrived while a fetch was in flight — rerun once after it
    let lastStructureKey = null;  // structure of the last full chart build; used to pick merge vs rebuild
    const loadingSubplots = new Set();  // subplot indices currently fetching data (for the spinner)

    // ===== Task 4: Inventory Tree =====

    async function loadInventory() {
        const container = document.getElementById('tree-container');
        container.innerHTML = '<div class="loading-text">Loading inventory...</div>';
        try {
            // version 2: keeps AMDA template-argument `choices` as real JSON
            // (see renderProductParams) instead of version 1's stringified repr.
            inventory = await fetchInventory(API_BASE, 'all', 2);
            renderTree(inventory);
            setupSearch();
            // Restore the params box for a product already selected by the time this
            // resolves (a ?config=/?path= URL applies before the inventory fetch
            // finishes) -- otherwise a page refresh with e.g. a chosen coordinate_system
            // silently loses the visible box, even though the data itself round-trips.
            const activeProduct = document.getElementById('product-path').value;
            if (activeProduct) {
                const leaf = leafIndex.find(l => l.path === activeProduct);
                if (leaf) {
                    const prod = plotState.plots.flatMap(sp => sp.products).find(p => p.path === activeProduct);
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
        if (isSelectableProduct(data)) {
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

        // Branch node: its children are only built the first time it is opened. Building the
        // whole ~100k-node inventory up front froze the page for ~0.6 s on every load.
        if (!hasSelectableDescendant(data)) return null;

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
        let built = false;

        header.addEventListener('click', () => {
            if (!built) {
                for (const ck of browsableChildKeys(data).sort()) {
                    const child = buildTreeNode(data[ck], ck);
                    if (child) childContainer.appendChild(child);
                }
                built = true;
            }
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

        // Pre-fill date inputs only if they're empty — clicking a product to
        // inspect it shouldn't clobber a time window the user already set.
        const stopEl = document.getElementById('stop-time');
        const startEl = document.getElementById('start-time');
        if (!stopEl.value && !startEl.value && node.stop_date) {
            const stopDate = new Date(node.stop_date);
            const startDate = new Date(stopDate.getTime() - 7 * 86400000);
            setDateInput(stopEl, stopDate);
            setDateInput(startEl, startDate);
        }

        renderProductParams(node);
        updateURL();
    }

    // ===== Per-product extra parameters (AMDA template args, SSC/3DView frames) =====

    // SSCWeb trajectories accept a fixed coordinate_system, same choices for every
    // product (see get_data.py's Query enum) -- unlike AMDA's arguments, this isn't
    // per-product inventory metadata.
    const SSC_COORDINATE_SYSTEMS = ['geo', 'gm', 'gse', 'gsm', 'sm', 'geitod', 'geij2000'];

    let productParamSelects = {};   // key -> <select> currently shown in #product-params
    let productParamsKind = null;   // null | 'product_inputs' (AMDA) | 'coordinate_system' (SSC/3DView)
    let paramsGeneration = 0;       // guards a stale async frame-list fetch from clobbering a later selection

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
    // once collectProductParams() is read again -- which otherwise only happens at
    // the next Plot/Add-to-plot click. If the product is already plotted, changing
    // a dropdown must re-fetch it live instead of silently doing nothing. The old
    // cache is dropped, not just refreshed: merging e.g. a GSE fetch into a cache
    // that already holds J2000 samples for the same product would silently mix
    // two coordinate frames in one series.
    function onProductParamsChanged() {
        const product = document.getElementById('product-path').value;
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

    // AMDA's TemplatedParameterIndex carries __spz_arguments__ (an ArgumentListIndex
    // of ArgumentIndex nodes: key/name/type/default/choices) -- render one <select>
    // per argument. Requires inventory version 2 (see loadInventory) so `choices`
    // survives as a real [[label, value], ...] array instead of a stringified repr.
    //
    // presetValues (optional): { coordinateSystem?, productInputs? } to select instead
    // of the usual defaults -- used to restore a page-refresh/shared config's actual
    // choice (see loadInventory) rather than silently resetting it.
    function renderProductParams(node, presetValues) {
        const container = document.getElementById('product-params');
        container.innerHTML = '';
        productParamSelects = {};
        productParamsKind = null;
        const myGeneration = ++paramsGeneration;

        const applyPreset = () => {
            if (!presetValues) return;
            if (presetValues.coordinateSystem && productParamSelects['coordinate_system']) {
                productParamSelects['coordinate_system'].value = presetValues.coordinateSystem;
            }
            if (presetValues.productInputs) {
                for (const key of Object.keys(presetValues.productInputs)) {
                    if (productParamSelects[key]) productParamSelects[key].value = presetValues.productInputs[key];
                }
            }
        };

        if (node.__spz_type__ === 'TemplatedParameterIndex' && node.__spz_arguments__) {
            productParamsKind = 'product_inputs';
            const args = node.__spz_arguments__;
            for (const key of Object.keys(args)) {
                if (isSpzMetaKey(key) || key === 'name' || key === 'is_public') continue;
                const arg = args[key];
                if (!arg || typeof arg !== 'object') continue;
                const choices = Array.isArray(arg.choices) && arg.choices.length > 0
                    ? arg.choices : [[arg.default, arg.default]];
                addParamSelect(container, arg.key || key, arg.name || arg.key || key, choices, arg.default);
            }
            applyPreset();
            return;
        }

        if (node.__spz_provider__ === 'ssc') {
            productParamsKind = 'coordinate_system';
            addParamSelect(container, 'coordinate_system', 'Coord.',
                SSC_COORDINATE_SYSTEMS.map(c => [c, c]), 'gse');
            applyPreset();
            return;
        }

        if (node.__spz_provider__ === 'cdpp3dview') {
            productParamsKind = 'coordinate_system';
            addParamSelect(container, 'coordinate_system', 'Frame', [['J2000', 'J2000']], 'J2000');
            applyPreset();  // in case the live frame list never arrives
            get3dViewFrames().then(frames => {
                if (myGeneration !== paramsGeneration || frames.length === 0) return;
                const select = productParamSelects['coordinate_system'];
                if (!select) return;
                select.innerHTML = '';
                for (const f of frames) {
                    const opt = document.createElement('option');
                    opt.value = f;
                    opt.textContent = f;
                    select.appendChild(opt);
                }
                select.value = frames.includes('J2000') ? 'J2000' : frames[0];
                applyPreset();  // re-apply now that the real options exist
            });
        }
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

        if (isSelectableProduct(node)) {
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

    // ===== Task 6: Data Fetch and Plot =====

    function initChart() {
        const el = document.getElementById('chart');
        plotView = createPlotView(el, { onViewChange });
        let resizeRaf = 0;
        new ResizeObserver(() => {
            if (resizeRaf) return;
            resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; plotView.resize(); });
        }).observe(el);
    }

    function bindControls() {
        attachDatePicker(document.getElementById('start-time'));
        attachDatePicker(document.getElementById('stop-time'));

        document.getElementById('btn-plot').addEventListener('click', doPlot);
        // Plain Enter replots; Shift+Enter is the add-to-plot shortcut below, so it must
        // not fall through to doPlot() — that would wipe the other subplots first.
        document.getElementById('start-time').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) doPlot();
        });
        document.getElementById('stop-time').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) doPlot();
        });
        // Shift+Enter adds to plot instead of replacing, when a product is selected.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !e.shiftKey) return;
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag !== 'input' && tag !== 'textarea') return;
            if (!document.getElementById('btn-add').disabled) {
                e.preventDefault();
                document.getElementById('btn-add').click();
            }
        });

        document.getElementById('range-chips').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.pan) panTime(Number(btn.dataset.pan));
            else if (btn.dataset.ms) applyRelativeRange(Number(btn.dataset.ms));
        });
        document.getElementById('btn-now').addEventListener('click', () => {
            const start = parseDateInput(document.getElementById('start-time').value);
            const width = (currentStopMs() - currentStartMs()) || 86400000;
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
        document.getElementById('btn-log-scale').addEventListener('click', () => {
            const heatmapPlots = plotState.plots.filter(sp => sp.plotType === 'heatmap');
            if (heatmapPlots.length === 0) return;
            for (const sp of heatmapPlots) { sp.logScale = !sp.logScale; sp._zScaleAuto = false; }
            document.getElementById('btn-log-scale').textContent = heatmapPlots[0].logScale ? 'Log Z' : 'Linear Z';
            renderAllSubplots(true);
        });
        document.getElementById('btn-log-y').addEventListener('click', () => {
            if (plotState.plots.length === 0) return;
            for (const sp of plotState.plots) { sp.y_axis.log = !sp.y_axis.log; sp._yScaleAuto = false; }
            document.getElementById('btn-log-y').textContent = plotState.plots[0].y_axis.log ? 'Log Y' : 'Linear Y';
            renderAllSubplots(true);
        });
        document.getElementById('btn-clear').addEventListener('click', clearAllPlots);

        document.getElementById('btn-export-png').addEventListener('click', () => {
            if (!plotView || plotState.plots.length === 0) return;
            const url = plotView.toDataURL(2, '#0b0e17');
            const a = document.createElement('a');
            a.href = url;
            a.download = 'speasy-plot.png';
            a.click();
        });

        document.getElementById('btn-export-csv').addEventListener('click', () => {
            if (plotState.plots.length === 0) return;
            const startMs = currentView.start != null ? currentView.start : -Infinity;
            const stopMs = currentView.end != null ? currentView.end : Infinity;
            const parts = [];
            let heatmapCount = 0;
            for (const sp of plotState.plots) {
                for (const prod of sp.products) {
                    const cache = sp.productData[prod.path];
                    if (!cache || cache.times.length === 0) continue;
                    if (Object.keys(cache.columns || {}).length === 0) { heatmapCount++; continue; }
                    parts.push(cacheToCsv(cache, startMs, stopMs));
                }
            }
            if (parts.length === 0) { setStatus('No line data to export.'); return; }
            const blob = new Blob([parts.join('\n\n') + '\n'], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'speasy-export.csv';
            a.click();
            URL.revokeObjectURL(a.href);
            let msg = 'Exported ' + parts.length + ' product(s) to CSV.';
            if (heatmapCount > 0) msg += ' (' + heatmapCount + ' spectrogram(s) skipped — CSV is for line data.)';
            setStatus(msg);
        });

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

            const header = document.createElement('div');
            header.className = 'add-dropdown-item';
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;color:#8892b0;';

            const textSpan = document.createElement('span');
            textSpan.textContent = 'Subplot ' + (i + 1);
            textSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
            header.appendChild(textSpan);

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
            header.appendChild(removeBtn);

            header.addEventListener('click', () => {
                addProductToPlot(idx);
                dropdown.style.display = 'none';
            });
            dropdown.appendChild(header);

            for (const prod of sp.products) {
                const prodItem = document.createElement('div');
                prodItem.className = 'add-dropdown-item';
                prodItem.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding-left:16px;';

                const prodLabel = document.createElement('span');
                prodLabel.textContent = '  ' + (prod.label || prod.path.split('/').pop());
                prodLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
                prodItem.appendChild(prodLabel);

                const prodRemove = document.createElement('span');
                prodRemove.textContent = '✕';
                prodRemove.title = 'Remove product';
                prodRemove.style.cssText = 'margin-left:8px;color:#ee6666;cursor:pointer;padding:0 4px;';
                const prodPath = prod.path;
                prodRemove.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeProductFromSubplot(idx, prodPath);
                    dropdown.style.display = 'none';
                });
                prodItem.appendChild(prodRemove);

                prodItem.addEventListener('click', () => {
                    addProductToPlot(idx);
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(prodItem);
            }
        }
    }

    function addProductToPlot(subplotIndex) {
        if (!plotView) { setStatus('Chart not available — check network connection.'); return; }
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

        subplot.products.push({ path: product, label: product, ...collectProductParams() });
        subplot.productData[product] = createProductCache(product);

        updateURL();
        fetchProductAndRender(plotState.plots.indexOf(subplot), product);
    }

    function removeSubplot(index) {
        plotState.plots.splice(index, 1);
        if (plotState.plots.length === 0) {
            plotView.clear();
            document.getElementById('btn-clear').style.display = 'none';
            document.getElementById('btn-export-png').style.display = 'none';
            document.getElementById('btn-export-csv').style.display = 'none';
            document.getElementById('btn-log-scale').style.display = 'none';
            document.getElementById('btn-log-y').style.display = 'none';
            document.getElementById('btn-share').disabled = true;
            setStatus('Ready');
        } else {
            renderAllSubplots();
        }
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
            // First product drives plot type — re-detect if we removed it
            if (subplot.products[0]) {
                subplot.plotType = plotTypeFromCache(subplot.productData[subplot.products[0].path]);
            }
            renderAllSubplots();
            updateURL();
        }
    }

    function clearAllPlots() {
        plotState.plots = [];
        plotView.clear();
        document.getElementById('btn-clear').style.display = 'none';
        document.getElementById('btn-log-scale').style.display = 'none';
        document.getElementById('btn-log-y').style.display = 'none';
        document.getElementById('btn-export-png').style.display = 'none';
        document.getElementById('btn-export-csv').style.display = 'none';
        document.getElementById('btn-share').disabled = true;
        history.replaceState(null, '', window.location.pathname);
        setStatus('Ready');
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

    async function fetchProductAndRender(subplotIndex, productPath) {
        showLoading(true);
        loadingSubplots.add(subplotIndex);
        setStatus('Fetching ' + productPath + '...');

        const startTime = plotState.time_range.start;
        const stopTime = plotState.time_range.stop;
        const startISO = new Date(startTime).toISOString();
        const stopISO = new Date(stopTime).toISOString();
        const fetchStartMs = new Date(startTime).getTime();
        const fetchStopMs = new Date(stopTime).getTime();

        try {
            const subplotForFetch = plotState.plots[subplotIndex];
            const prodForFetch = subplotForFetch?.products.find(p => p.path === productPath);
            const data = await fetchData(productPath, startISO, stopISO, undefined, prodForFetch);
            if (!data || !data.values || !data.axes || data.axes.length === 0) {
                loadingSubplots.delete(subplotIndex);
                setStatus('No data returned for ' + productPath);
                return;
            }

            const subplot = plotState.plots[subplotIndex];
            const cache = subplot.productData[productPath];
            mergeProductData(cache, data, fetchStartMs, fetchStopMs);

            if (subplot.products[0].path === productPath) {
                subplot.plotType = detectPlotType(data);
                applyScaleHints(subplot, data);
            }

            renderAllSubplots();
            setStatus('Added ' + productPath);
        } catch (e) {
            setStatus('Error fetching ' + productPath + ': ' + e.message);
            console.error(e);
        } finally {
            showLoading(false);
            loadingSubplots.delete(subplotIndex);
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
        if (!plotView) { setStatus('Chart not available — check network connection.'); return; }
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
        subplot.products.push({ path: product, label: product, ...collectProductParams() });
        subplot.productData[product] = createProductCache(product);
        plotState.plots.push(subplot);

        updateURL();
        await fetchAllAndRender();
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
            const yHint = scaleTypToLog(yMeta);
            if (yHint !== null) subplot.y_axis.log = yHint;
        }
    }

    function mergeProductData(cache, json, fetchStart, fetchStop) {
        const rawTimes = json.axes[0].values;
        const newTimes = rawTimes.map(t => t / 1e6);
        const columns = json.columns || [];
        const unit = cleanText(json.values.meta && json.values.meta.UNITS);

        const isHeatmap = detectPlotType(json) === 'heatmap';
        const hasYAxis = isHeatmap && json.axes.length >= 2;
        const { yAxis, rows: newValues } = hasYAxis
            ? ascendingSpectrogram(json.axes[1].values, json.values.values)
            : { yAxis: null, rows: json.values.values };

        if (cache.times.length === 0) {
            cache.times = newTimes;
            cache.unit = unit;
            cache.intervals = [[fetchStart, fetchStop]];
            cache.fetchSpan = fetchStop - fetchStart;
            cache.displayType = (json.values.meta || {}).DISPLAY_TYPE || '';

            if (isHeatmap) {
                if (hasYAxis) {
                    cache.yAxis = yAxis;
                    cache.yAxisName = cleanText(json.axes[1].name);
                    cache.yAxisUnit = cleanText(json.axes[1].meta && json.axes[1].meta.UNITS);
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
                const merged = mergeSortedRows(cache.times, newTimes, cache.rows, newValues);
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

        const hasHeatmap = plotState.plots.some(sp => sp.plotType === 'heatmap');
        document.getElementById('btn-log-scale').style.display = hasHeatmap ? '' : 'none';
        document.getElementById('btn-log-y').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-clear').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-export-png').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-export-csv').style.display = n > 0 ? '' : 'none';
        document.getElementById('btn-share').disabled = n === 0;
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

    // Every user pan/zoom (wheel, drag, slider) lands here; the refetch waits for the
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

        plotState.time_range.start = new Date(view.start).toISOString();
        plotState.time_range.stop = new Date(view.end).toISOString();
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
        if (fetchController) {
            const r = fetchController._range;
            const reqSpan = reqStop - reqStart;
            const overlapMs = r ? Math.max(0, Math.min(r.stop, reqStop) - Math.max(r.start, reqStart)) : 0;
            const young = performance.now() - (fetchController._t0 || 0) < 700;
            if (overlapMs === 0 || (young && overlapMs < 0.5 * reqSpan)) fetchController.abort();
            panFetchQueued = true;
            return;
        }
        const controller = new AbortController();
        controller._range = { start: reqStart, stop: reqStop };
        controller._t0 = performance.now();
        fetchController = controller;
        showFetchBar(true);

        const fetchStart = new Date(view.start - buffer).toISOString();
        const fetchStop = new Date(view.end + buffer).toISOString();

        const fetchJobs = toFetch.map(({ path, cache }) =>
            fetchData(path, fetchStart, fetchStop, controller.signal)
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
                        if (!rangesOverlap(r.cache.intervals, view.start - buffer, view.end + buffer)) {
                            resetProductCache(r.cache);
                        }
                    }
                    for (const r of valid) mergeProductData(r.cache, r.data, view.start - buffer, view.end + buffer);

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
            if (fetchController === controller) {
                showFetchBar(false);
                fetchController = null;
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

    // ===== Continuous Pan/Zoom =====
    //
    // Pan/zoom refetches the visible range + buffer for products whose cache doesn't
    // already cover it densely enough. Server-side resampling (max_points) keeps
    // payloads bounded regardless of time range.

    const BUFFER_RATIO = 1.0;      // pre-fetch 1x view width on each side
    const POINTS_PER_PIXEL = 2.0;  // target density of the *visible* window (server resample target)
    const ZOOM_IN_REFETCH_RATIO = 0.5; // zooming into < half the fetched span triggers a denser refetch
    const TRIM_WINDOW_RATIO = 2.0;     // keep cached data within view ± 2x view span; older data is dropped

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
        const startDate = config.time_range.start ? new Date(config.time_range.start) : null;
        let stopDate = config.time_range.stop ? new Date(config.time_range.stop) : null;
        // A bare "YYYY-MM-DD" (e.g. the legacy ?start=&stop= link format, both parsed as
        // UTC midnight) used for both start and stop is meant as "that whole day", not a
        // zero-width instant -- left alone it silently produces a request the backend
        // rejects as invalid every time this link is opened.
        if (startDate && stopDate && stopDate.getTime() <= startDate.getTime()) {
            stopDate = new Date(startDate.getTime() + 86400000);
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

        if (plotState.plots.length > 0 && plotState.plots[0].products.length > 0) {
            document.getElementById('product-path').value = plotState.plots[0].products[0].path;
            document.getElementById('btn-plot').disabled = false;
        }

        // initChart() runs synchronously earlier in the DOMContentLoaded handler, so
        // the chart already exists here — no need to defer the first fetch.
        fetchAllAndRender();
    }

    async function fetchAllAndRender() {
        if (!plotView) { setStatus('Chart not available — check network connection.'); return; }
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
                    fetchData(prod.path, startISO, stopISO, undefined, prod)
                        .then(data => ({ subplot, path: prod.path, data }))
                        .catch(e => ({ subplot, path: prod.path, error: e }))
                );
            }
        }

        const results = await Promise.all(fetchPromises);

        const errors = [];
        let loadedCount = 0;
        for (const result of results) {
            if (result.error) {
                console.error('Fetch error for', result.path, result.error);
                errors.push(result.path + ' (' + result.error.message + ')');
                continue;
            }
            const { subplot, path, data } = result;
            if (!data || !data.values || !data.axes || data.axes.length === 0) {
                errors.push(path + ' (no data returned)');
                continue;
            }

            const cache = subplot.productData[path];
            mergeProductData(cache, data, fetchStartMs, fetchStopMs);
            loadedCount++;

            // Detect plot type from first product
            if (subplot.products[0].path === path) {
                subplot.plotType = detectPlotType(data);
                applyScaleHints(subplot, data);
            }
        }

        currentView = { start: fetchStartMs, end: fetchStopMs };
        renderAllSubplots();

        const totalProducts = plotState.plots.reduce((n, sp) => n + sp.products.length, 0);
        let msg = 'Loaded ' + loadedCount + '/' + totalProducts + ' product(s) across ' + plotState.plots.length + ' subplot(s)';
        if (errors.length > 0) msg += '. Errors: ' + errors.join('; ');
        setStatus(msg);
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
        const view = { start: start - padding, end: end + padding };
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
        __resetCdpp3dviewFramesCache: () => { cdpp3dviewFramesPromise = null; },
    };
