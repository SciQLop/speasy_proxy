// CDF codec — decodes the proxy's `format=cdf` (application/x-cdf) payload into the same
// SpeasyData the JSON codec produces, using the CDFpp WebAssembly build. Pages are
// agnostic: they only ever see SpeasyData (see api-client.js for the seam).
//
// The proxy resamples BEFORE encoding, so a CDF payload is already bandwidth-bounded.
// CDF preserves real dtypes (int64 epoch, float32/64) and is far faster to decode than
// parsing a large JSON string — but emits the same shape so plot.js/demo3d are unchanged.
//
// Assumes row-major CDF (the proxy always saves row-major).

import createCdfModule from './vendor/cdfpp.js';

// The WASM module is instantiated once and reused across all fetches.
let modulePromise = null;
const getModule = () => (modulePromise ??= createCdfModule());

export const cdfCodec = {
  format: 'cdf',
  async decode(resp) {
    const M = await getModule();
    const cdf = M.load(new Uint8Array(await resp.arrayBuffer()));
    try {
      if (!cdf.is_valid()) throw new Error('CDFpp: invalid CDF payload');
      return cdfToSpeasyData(cdf);
    } finally {
      cdf.delete();
    }
  },
};

function cdfToSpeasyData(cdf) {
  const dataName = cdf.variable_names().find(
    (n) => cdf.get_variable(n).attributes?.VAR_TYPE === 'data',
  );
  if (!dataName) throw new Error('CDFpp: no data variable (VAR_TYPE=data)');

  const dv = cdf.get_variable(dataName);
  const meta = dv.attributes || {};
  const ntime = dv.shape[0] ?? 0;
  const ncols = ntime ? dv.values.length / ntime : 0;
  const fillval = readFillval(meta.FILLVAL);

  const axes = [{ values: timeAxis(cdf, meta.DEPEND_0), name: 'time' }];
  if (meta.DEPEND_1) axes.push(dependAxis(cdf, meta.DEPEND_1));

  return {
    axes,
    values: { values: reshape(dv.values, ntime, ncols, fillval), meta },
    columns: meta.LABL_PTR_1 ? decodeCharRows(cdf.get_variable(meta.LABL_PTR_1)) : [],
  };
}

// Time axis as unix-ns Numbers — matches the JSON path, which plot.js divides by 1e6.
function timeAxis(cdf, name) {
  if (!name) return [];
  const ns = cdf.time_values_as_ns_since_1970(name);
  return ns ? Array.from(ns, Number) : [];
}

// DEPEND_1 axis: numeric (1D bins or 2D time-varying table) or CHAR component labels.
function dependAxis(cdf, name) {
  const a = cdf.get_variable(name);
  const node = { name: a.name, meta: a.attributes || {} };
  if (a.type_name === 'CDF_CHAR' || a.type_name === 'CDF_UCHAR') {
    node.values = decodeCharRows(a);
  } else {
    const n0 = a.shape[0] ?? 0;
    node.values =
      a.shape.length > 1
        ? reshape(a.values, n0, n0 ? a.values.length / n0 : 0, null)
        : Array.from(a.values, Number);
  }
  return node;
}

// Flat row-major typed array -> number[ntime][ncols], with FILLVAL mapped to NaN
// (the JSON path does replace_fillval_by_nan server-side).
function reshape(flat, ntime, ncols, fillval) {
  const rows = new Array(ntime);
  for (let t = 0; t < ntime; t++) {
    const row = new Array(ncols);
    const off = t * ncols;
    for (let c = 0; c < ncols; c++) {
      const x = Number(flat[off + c]);
      row[c] = fillval !== null && x === fillval ? NaN : x;
    }
    rows[t] = row;
  }
  return rows;
}

function readFillval(fv) {
  return fv && fv.length ? Number(fv[0]) : null;
}

// CHAR variable [n, strlen] of raw bytes -> n trimmed strings.
function decodeCharRows(a) {
  const strlen = a.shape[a.shape.length - 1];
  if (!strlen) return [];
  const n = a.values.length / strlen;
  const dec = new TextDecoder('utf-8');
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = dec.decode(a.values.subarray(i * strlen, (i + 1) * strlen)).replace(/\0/g, '').trim();
  }
  return out;
}
