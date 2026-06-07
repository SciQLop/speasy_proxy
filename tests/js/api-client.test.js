import { describe, it, expect } from 'vitest';
import { buildDataUrl, decodeJson } from '../../speasy_proxy/static/js/api-client.js';

describe('buildDataUrl', () => {
  it('builds a JSON get_data URL with required params', () => {
    const url = buildDataUrl({
      baseUrl: 'https://h/cache/', path: 'amda/b gsm',
      startISO: '2018-01-01T00:00:00.000Z', stopISO: '2018-01-02T00:00:00.000Z',
      maxPoints: 5000,
    });
    expect(url).toContain('format=json');
    expect(url).toContain('path=amda%2Fb%20gsm');
    expect(url).toContain('max_points=5000');
    expect(url).not.toContain('coordinate_system');
  });
  it('appends coordinate_system when provided', () => {
    const url = buildDataUrl({ baseUrl: 'b/', path: 'ssc/ace', startISO: 'a', stopISO: 'b', maxPoints: 100, coordinateSystem: 'GSE' });
    expect(url).toContain('coordinate_system=GSE');
  });
});

describe('decodeJson', () => {
  it('parses JSON with bare NaN tokens', () => {
    const d = decodeJson('{"axes":[{"values":[1]}],"values":{"values":[[NaN],[3]]}}');
    expect(d.values.values[0][0]).toBeNull();
    expect(d.values.values[1][0]).toBe(3);
  });
});
