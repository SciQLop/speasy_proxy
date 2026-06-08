// Proxy data-fetch client with a swappable decoder (codec) seam.
//
// @typedef {{ values: (number[]|number[][]), name?: string, meta?: object }} SpeasyAxis
// @typedef {{ values: number[][], meta?: object }} SpeasyValues
// @typedef {{ axes: SpeasyAxis[], values: SpeasyValues, columns?: string[] }} SpeasyData
//
// The codec seam lets a future CDF/WASM decoder slot in by reading
// resp.arrayBuffer() instead of resp.text(); pages only ever see SpeasyData.

// The proxy json format emits bare `NaN` tokens; sanitize before JSON.parse.
export function decodeJson(text) {
  return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
}

export const jsonCodec = {
  format: 'json',
  async decode(resp) {
    return decodeJson(await resp.text());
  },
};

// The codec used when a caller doesn't pass one. Defaults to JSON; opt into the CDF/WASM
// codec by setting `window.SPEASY_USE_CDF` before this module loads (see enableCdfCodec).
let preferredCodec = jsonCodec;

// Resolves once the preferred codec is settled, so the first fetchData waits for the
// (fast, same-origin) codec import instead of racing it with JSON. Resolved when not opted in.
let codecReady = Promise.resolve();

// Lazily load the CDF codec (pulls in the ~0.6 MB WASM glue) and make it the default.
export async function enableCdfCodec() {
  const { cdfCodec } = await import('./cdf-codec.js');
  preferredCodec = cdfCodec;
  return cdfCodec;
}
if (typeof globalThis !== 'undefined' && globalThis.SPEASY_USE_CDF) {
  codecReady = enableCdfCodec().catch(() => { /* stay on JSON if the WASM codec can't load */ });
}

// opts: { baseUrl (ends with '/'), path, startISO, stopISO, maxPoints, coordinateSystem?, signal? }
export function buildDataUrl(o, format = 'json') {
  let url =
    o.baseUrl + 'get_data?format=' + format + '&path=' + encodeURIComponent(o.path) +
    '&start_time=' + encodeURIComponent(o.startISO) +
    '&stop_time=' + encodeURIComponent(o.stopISO) +
    '&max_points=' + o.maxPoints;
  if (o.coordinateSystem) url += '&coordinate_system=' + encodeURIComponent(o.coordinateSystem);
  return url;
}

export async function fetchData(o, codec) {
  if (codec === undefined) {
    await codecReady;      // first call waits for the opted-in codec to load
    codec = preferredCodec;
  }
  try {
    const resp = await fetch(buildDataUrl(o, codec.format), o.signal ? { signal: o.signal } : undefined);
    if (!resp.ok) {
      let msg = `Server error ${resp.status}`;
      try { const err = await resp.json(); msg = err.error || err.detail || msg; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    return await codec.decode(resp);
  } catch (e) {
    // Graceful degrade: any CDF-path failure (server, decode, WASM) retries once as JSON.
    if (codec !== jsonCodec && !(o.signal && o.signal.aborted)) {
      return fetchData(o, jsonCodec);
    }
    throw e;
  }
}

export async function fetchInventory(baseUrl, provider) {
  const resp = await fetch(baseUrl + 'get_inventory?format=json&provider=' + provider);
  if (!resp.ok) throw new Error('Server returned ' + resp.status);
  return decodeJson(await resp.text());
}
