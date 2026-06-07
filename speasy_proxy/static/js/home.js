import { formatBytes, formatNumber, formatDuration, formatDateTime } from './format.js';
import { configToBase64 } from './plot-core.js';

const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');

    function setValue(id, text) {
        const el = document.getElementById(id);
        el.textContent = text;
        el.classList.remove('loading');
    }

    async function updateStatus() {
        try {
            const resp = await fetch(BASE_URL + '/get_server_status');
            if (!resp.ok) return;
            const data = await resp.json();

            setValue('cache-size', formatBytes(data.cache_disk_size));
            setValue('cache-entries', formatNumber(data.entries));
            setValue('inventory-size', data.inventory_size + ' products');
            setValue('uptime', formatDuration(data.up_duration));
            setValue('up-since', formatDateTime(data.up_since));
            setValue('last-inventory-update', formatDateTime(data.last_inventory_update));
            setValue('update-interval', data.inventory_update_interval);
            setValue('proxy-version', data.version);
            setValue('speasy-version', data.speasy_version);
        } catch (e) {
            console.error('Failed to fetch status:', e);
        }
    }

    async function loadPresets() {
        try {
            const baseUrl = BASE_URL;
            const resp = await fetch(baseUrl + '/get_presets');
            if (!resp.ok) return;
            const presets = await resp.json();
            const featured = presets.filter(p => p.featured);
            if (featured.length === 0) return;

            const grid = document.getElementById('presets-grid');
            for (const preset of featured) {
                const encoded = configToBase64(preset.config);
                const plotUrl = baseUrl + '/plot?config=' + encoded;
                const card = document.createElement('a');
                card.href = plotUrl;
                card.className = 'preset-card';
                card.innerHTML =
                    '<div class="preset-name">' + preset.name + '</div>' +
                    (preset.description ? '<div class="preset-desc">' + preset.description + '</div>' : '');
                grid.appendChild(card);
            }
            document.getElementById('presets-section').style.display = '';
        } catch (e) {
            console.error('Failed to load presets:', e);
        }
    }

    updateStatus();
    setInterval(updateStatus, 10000);
    loadPresets();
