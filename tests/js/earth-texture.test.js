import { describe, it, expect } from 'vitest';
import { buildEarthColorLUT, sampleEarthColor } from '../../speasy_proxy/static/js/earth-texture.js';

// Synthetic equirectangular texture: the red channel encodes the texture row, so a
// sampled color tells us exactly which latitude band of the image was read.
function latitudeStripeTexture(w, h) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      pixels[i] = py;         // row marker
      pixels[i + 1] = px;     // column marker
      pixels[i + 2] = 0;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function red(color) {
  return Number(color.match(/rgb\((\d+),/)[1]);
}

function green(color) {
  return Number(color.match(/rgb\(\d+,(\d+),/)[1]);
}

describe('earth texture LUT', () => {
  const W = 256, H = 180;  // both marker channels must fit in a byte
  const lut = buildEarthColorLUT(latitudeStripeTexture(W, H), W, H);

  it('samples the top texture row at the north pole', () => {
    expect(red(sampleEarthColor(lut, 0, 0, 1))).toBeLessThan(3);
  });

  it('samples the bottom texture row at the south pole', () => {
    expect(red(sampleEarthColor(lut, 0, 0, -1))).toBeGreaterThan(H - 4);
  });

  it('samples the middle texture row at the equator', () => {
    const r = red(sampleEarthColor(lut, 1, 0, 0));
    expect(r).toBeGreaterThan(H / 2 - 4);
    expect(r).toBeLessThan(H / 2 + 4);
  });

  it('covers the full latitude range monotonically', () => {
    const rows = [1, 0.5, 0, -0.5, -1].map((z) => red(sampleEarthColor(lut, Math.sqrt(1 - z * z), 0, z)));
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
  });

  it('maps longitude across the full texture width', () => {
    const west = green(sampleEarthColor(lut, -1, -0.001, 0)); // lon ≈ -180°
    const east = green(sampleEarthColor(lut, -1, 0.001, 0));  // lon ≈ +180°
    expect(west).toBeLessThan(4);
    expect(east).toBeGreaterThan(W - 5);
  });

  it('falls back to a flat color without a LUT', () => {
    expect(sampleEarthColor(null, 1, 0, 0)).toBe('#2255aa');
  });
});
