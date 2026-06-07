// 3D magnetosphere physics for the orbit viewer.
// Region: 0 = magnetosphere, 1 = magnetosheath, 2 = solar wind.

export const EARTH_RADIUS_KM = 6371.0;
export const MAX_DISTANCE_RE = 500;

// Shue et al. 1998 magnetopause
export function shueParams(Dp, Bz) {
  const r0 = (10.22 + 1.29 * Math.tanh(0.184 * (Bz + 8.14))) * Math.pow(Dp, -1.0 / 6.6);
  const alpha = (0.58 - 0.007 * Bz) * (1 + 0.024 * Math.log(Dp));
  return { r0, alpha };
}

// Bow shock: scaled from magnetopause (Farris & Russell 1994 approx)
export function bowShockParams(mp) {
  return { r0: mp.r0 * 1.28, alpha: mp.alpha * 1.05 };
}

export function classifyPoint(x, y, z, mp, bs) {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-6) return 0;
  const cosTheta = x / r;
  const rMp = mp.r0 * Math.pow(2 / (1 + cosTheta), mp.alpha);
  if (r <= rMp) return 0;
  const rBs = bs.r0 * Math.pow(2 / (1 + cosTheta), bs.alpha);
  if (r <= rBs) return 1;
  return 2;
}

// values: array of [xKm, yKm, zKm]; returns array of [xRe, yRe, zRe, region]
export function toReData(values, mp, bs) {
  const result = [];
  for (const p of values) {
    const x = p[0] / EARTH_RADIUS_KM;
    const y = p[1] / EARTH_RADIUS_KM;
    const z = p[2] / EARTH_RADIUS_KM;
    if (x * x + y * y + z * z > MAX_DISTANCE_RE * MAX_DISTANCE_RE) continue;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    result.push([x, y, z, classifyPoint(x, y, z, mp, bs)]);
  }
  return result;
}

// pointSets: array of trajectories, each an array of [x, y, z, ...] points
export function computeAxisRange(pointSets) {
  let maxAbs = 2;
  for (const set of pointSets) {
    for (const p of set) {
      for (let i = 0; i < 3; i++) {
        const v = Math.abs(p[i]);
        if (v > maxAbs) maxAbs = v;
      }
    }
  }
  maxAbs = Math.ceil(maxAbs * 1.1);
  return { min: -maxAbs, max: maxAbs };
}
