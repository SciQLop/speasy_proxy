// Spectrogram rendering: viridis colormap + offscreen-canvas image.

const VIRIDIS = [
  [0.0, [68, 1, 84]], [0.1, [72, 40, 120]], [0.2, [62, 73, 137]],
  [0.3, [49, 104, 142]], [0.4, [38, 130, 142]], [0.5, [31, 158, 137]],
  [0.6, [53, 183, 121]], [0.7, [110, 206, 88]], [0.8, [181, 222, 43]],
  [0.9, [229, 228, 32]], [1.0, [253, 231, 37]],
];

export const VIRIDIS_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    for (; j < VIRIDIS.length - 1; j++) { if (t <= VIRIDIS[j + 1][0]) break; }
    const f = (t - VIRIDIS[j][0]) / (VIRIDIS[j + 1][0] - VIRIDIS[j][0]);
    const a = VIRIDIS[j][1], c = VIRIDIS[j + 1][1];
    lut[i * 3] = Math.round(a[0] + f * (c[0] - a[0]));
    lut[i * 3 + 1] = Math.round(a[1] + f * (c[1] - a[1]));
    lut[i * 3 + 2] = Math.round(a[2] + f * (c[2] - a[2]));
  }
  return lut;
})();

export function computeYEdges(yBinsFlat) {
  const yEdges = new Array(yBinsFlat.length + 1);
  for (let i = 1; i < yBinsFlat.length; i++) yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
  yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
  yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
    (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length - 1] - yBinsFlat[yBinsFlat.length - 2]) / 2 : 0.5);
  return yEdges;
}

// view: { start, end } in ms (nullable); returns { canvas, tStart, tEnd, yMin, yMax } or null
export function renderSpectrogramImage(times, rows, yBinsFlat, vMin, vMax, logScaleParam, view) {
  const v = (view && view.start != null && view.end != null)
    ? { start: view.start, end: view.end }
    : { start: times[0], end: times[times.length - 1] };

  const viewRange = v.end - v.start;
  const renderStart = v.start - viewRange * 0.5;
  const renderEnd = v.end + viewRange * 0.5;

  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < renderStart) lo = mid + 1; else hi = mid; }
  const iStart = lo;
  lo = iStart; hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= renderEnd) lo = mid + 1; else hi = mid; }
  const iEnd = lo;

  const nTime = iEnd - iStart;
  const nY = yBinsFlat.length;
  if (nTime <= 0 || nY <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = nTime;
  canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(nTime, nY);
  const pixels = imgData.data;

  const logVMin = Math.log10(Math.max(vMin, 1e-30));
  const logVMax = Math.log10(vMax);

  for (let t = 0; t < nTime; t++) {
    const row = rows[iStart + t];
    if (!row) continue;
    for (let y = 0; y < nY; y++) {
      const val = row[y];
      if (val == null || isNaN(val) || val <= 0) continue;
      const norm = logScaleParam
        ? (Math.log10(val) - logVMin) / (logVMax - logVMin)
        : (val - vMin) / (vMax - vMin);
      const li = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      const py = (nY - 1 - y);
      const idx = (py * nTime + t) * 4;
      pixels[idx] = VIRIDIS_LUT[li];
      pixels[idx + 1] = VIRIDIS_LUT[li + 1];
      pixels[idx + 2] = VIRIDIS_LUT[li + 2];
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return {
    canvas,
    tStart: times[iStart],
    tEnd: times[Math.min(iEnd, times.length) - 1],
    yMin: yBinsFlat[0],
    yMax: yBinsFlat[nY - 1],
  };
}
