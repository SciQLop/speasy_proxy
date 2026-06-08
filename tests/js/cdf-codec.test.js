import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cdfCodec } from '../../speasy_proxy/static/js/cdf-codec.js';

// Wrap a fixture .cdf as a minimal Response the codec can read.
function cdfResponse(name) {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return { async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
}

describe('cdfCodec.decode — line product (ACE BGSEc, 225x3 float32)', () => {
  it('maps to SpeasyData with time, values matrix and component labels', async () => {
    const d = await cdfCodec.decode(cdfResponse('line.cdf'));

    expect(d.axes[0].name).toBe('time');
    expect(d.axes[0].values).toHaveLength(225);
    // leap-second-correct unix-ns for 2016-06-01T00:00:15Z (page divides by 1e6 -> ms)
    expect(d.axes[0].values[0]).toBe(1464739215000000000);

    expect(d.values.values).toHaveLength(225);
    expect(d.values.values[0]).toHaveLength(3);
    expect(d.values.meta.UNITS).toBe('nT');
    expect(d.values.meta.DISPLAY_TYPE).toBe('time_series');

    expect(d.columns).toEqual(['Bx GSE', 'By GSE', 'Bz GSE']);
  });

  it('maps FILLVAL to NaN', async () => {
    const d = await cdfCodec.decode(cdfResponse('line.cdf'));
    const fill = -9.999999848243207e30;
    for (const row of d.values.values) for (const x of row) expect(x).not.toBe(fill);
  });
});

describe('cdfCodec.decode — spectrogram (THEMIS ESA, 31x32 float64, 2D y-axis)', () => {
  it('maps the time-varying DEPEND_1 to a 2D axis matching the values shape', async () => {
    const d = await cdfCodec.decode(cdfResponse('spectro.cdf'));

    expect(d.axes[0].values).toHaveLength(31);
    expect(d.values.values).toHaveLength(31);
    expect(d.values.values[0]).toHaveLength(32);
    expect(d.values.meta.DISPLAY_TYPE).toBe('spectrogram');

    // y-axis is the per-time energy table: 31 rows x 32 bins
    expect(d.axes[1].values).toHaveLength(31);
    expect(d.axes[1].values[0]).toHaveLength(32);
    expect(typeof d.axes[1].values[0][0]).toBe('number');
  });
});
