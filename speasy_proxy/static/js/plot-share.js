// A /plot view as it leaves or re-enters the page: preset stories, code snippets,
// recent views. Pure functions over the share config (plot.js stateToConfig).

// The config a preset opens with. The server keeps name and description beside the
// config; folding them in makes the story travel with the share URL.
export function presetConfig(preset) {
  return {
    ...preset.config,
    name: preset.name,
    ...(preset.description ? { description: preset.description } : {}),
  };
}

// { name, description } of a config that tells a story, else null.
export function configStory(config) {
  const name = (config.name || '').trim();
  return name ? { name, description: config.description || '' } : null;
}

// --- code for the current view ------------------------------------------------------

// Each product once, even when two subplots show it; the same path with other
// parameters (frame, AMDA arguments) is another product.
function distinctProducts(config) {
  const seen = new Map();
  for (const p of config.plots.flatMap((sp) => sp.products)) {
    const key = JSON.stringify([p.path, p.coordinate_system, p.product_inputs]);
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

// toISOString always writes milliseconds; ".000" is noise in a snippet.
const isoTime = (iso) => iso.replace(/\.000Z$/, 'Z');

const pyDict = (obj) => '{' + Object.entries(obj).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}';

// A Python identifier from the product's last path segment, unique within the snippet.
function pyNames(products) {
  const used = new Map();
  return products.map((p) => {
    const base = p.path.split('/').pop().replace(/\W/g, '_').replace(/^(?=\d)/, '_');
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : base + '_' + n;
  });
}

// One spz.get_data call per product, with the keyword arguments speasy takes
// (the same ones get_data.py forwards).
export function pythonSnippet(config) {
  const start = JSON.stringify(isoTime(config.time_range.start));
  const stop = JSON.stringify(isoTime(config.time_range.stop));
  const products = distinctProducts(config);
  const names = pyNames(products);
  const calls = products.map((p, i) => {
    const args = [JSON.stringify(p.path), start, stop];
    if (p.coordinate_system) args.push('coordinate_system=' + JSON.stringify(p.coordinate_system));
    if (p.product_inputs) args.push('product_inputs=' + pyDict(p.product_inputs));
    return names[i] + ' = spz.get_data(' + args.join(', ') + ')';
  });
  return ['import speasy as spz', '', ...calls, ''].join('\n');
}

// "/" and ":" are legal in a query string; keeping them makes the URL readable.
const queryValue = (s) => encodeURIComponent(s).replace(/%2F/g, '/').replace(/%3A/g, ':');

// One get_data URL per product, as CDF, for curl, IDL, Matlab or Julia.
// apiBase: the proxy's absolute base URL, ending with '/'.
export function dataUrls(config, apiBase) {
  const range = '&start_time=' + queryValue(isoTime(config.time_range.start))
    + '&stop_time=' + queryValue(isoTime(config.time_range.stop));
  return distinctProducts(config).map((p) =>
    apiBase + 'get_data?path=' + queryValue(p.path) + range + '&format=cdf'
    + (p.coordinate_system ? '&coordinate_system=' + queryValue(p.coordinate_system) : '')
    + (p.product_inputs ? '&product_inputs=' + encodeURIComponent(JSON.stringify(p.product_inputs)) : '')
  ).join('\n');
}
