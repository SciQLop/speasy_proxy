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
  async decode(resp) {
    return decodeJson(await resp.text());
  },
};

// opts: { baseUrl (ends with '/'), path, startISO, stopISO, maxPoints, coordinateSystem?, signal? }
export function buildDataUrl(o) {
  let url =
    o.baseUrl + 'get_data?format=json&path=' + encodeURIComponent(o.path) +
    '&start_time=' + encodeURIComponent(o.startISO) +
    '&stop_time=' + encodeURIComponent(o.stopISO) +
    '&max_points=' + o.maxPoints;
  if (o.coordinateSystem) url += '&coordinate_system=' + encodeURIComponent(o.coordinateSystem);
  return url;
}

export async function fetchData(o, codec = jsonCodec) {
  const resp = await fetch(buildDataUrl(o), o.signal ? { signal: o.signal } : undefined);
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`;
    try { const err = await resp.json(); msg = err.error || err.detail || msg; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  return codec.decode(resp);
}

export async function fetchInventory(baseUrl, provider) {
  const resp = await fetch(baseUrl + 'get_inventory?format=json&provider=' + provider);
  if (!resp.ok) throw new Error('Server returned ' + resp.status);
  return decodeJson(await resp.text());
}
