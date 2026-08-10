// Earth albedo lookup for the 3D globe. Sampling the equirectangular texture per
// vertex is far too slow at PI/180 steps, so the texture is resampled once into a
// coarse lat/lon grid and every vertex does an array lookup.

const FALLBACK_COLOR = '#2255aa';
const COLS = 360;  // one cell per degree — finer than the surface's PI/180 steps
const ROWS = 180;

// pixels: RGBA bytes of a w×h equirectangular image (row 0 = north pole,
// column 0 = 180°W). Returns { lut, cols, rows } indexed by [ry * cols + cx].
export function buildEarthColorLUT(pixels, w, h) {
  const lut = new Array(COLS * ROWS);
  for (let ry = 0; ry < ROWS; ry++) {
    const py = Math.floor((ry / (ROWS - 1)) * (h - 1));
    for (let cx = 0; cx < COLS; cx++) {
      const px = Math.floor((cx / (COLS - 1)) * (w - 1));
      const i = (py * w + px) * 4;
      lut[ry * COLS + cx] = `rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})`;
    }
  }
  return { lut, cols: COLS, rows: ROWS };
}

// Color of the globe surface at cartesian (x, y, z); lat +90° maps to row 0.
export function sampleEarthColor(lutObj, x, y, z) {
  if (!lutObj) return FALLBACK_COLOR;
  const r = Math.sqrt(x * x + y * y + z * z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, z / r)));
  const lon = Math.atan2(y, x);
  const cx = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * lutObj.cols);
  const ry = Math.floor(((Math.PI / 2 - lat) / Math.PI) * lutObj.rows);
  const clampedCx = Math.max(0, Math.min(lutObj.cols - 1, cx));
  const clampedRy = Math.max(0, Math.min(lutObj.rows - 1, ry));
  return lutObj.lut[clampedRy * lutObj.cols + clampedCx];
}
