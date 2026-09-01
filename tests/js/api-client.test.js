import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDataUrl, decodeJson, fetchInventory } from '../../speasy_proxy/static/js/api-client.js';

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
  it('appends product_inputs as JSON when provided (AMDA templated parameters)', () => {
    const url = buildDataUrl({
      baseUrl: 'b/', path: 'amda/bepi_sixp_p', startISO: 'a', stopISO: 'b', maxPoints: 100,
      productInputs: { side: '1' },
    });
    expect(url).toContain('product_inputs=' + encodeURIComponent(JSON.stringify({ side: '1' })));
  });
});

describe('fetchInventory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to inventory version 1 (unchanged behavior)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchInventory('b/', 'amda');
    expect(fetchMock.mock.calls[0][0]).not.toContain('version=2');
  });

  it('requests version 2 when asked, for typed AMDA argument choices', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchInventory('b/', 'amda', 2);
    expect(fetchMock.mock.calls[0][0]).toContain('version=2');
  });
});

describe('decodeJson', () => {
  it('parses JSON with bare NaN tokens', () => {
    const d = decodeJson('{"axes":[{"values":[1]}],"values":{"values":[[NaN],[3]]}}');
    expect(d.values.values[0][0]).toBeNull();
    expect(d.values.values[1][0]).toBe(3);
  });

  it('parses JSON with bare Infinity and -Infinity tokens', () => {
    const d = decodeJson('{"values":[1.0, Infinity, -Infinity, NaN]}');
    expect(d.values).toEqual([1.0, null, null, null]);
  });
});
