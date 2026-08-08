import { describe, it, expect, vi, afterAll } from 'vitest';

const toReData = vi.fn((v) => v.map((r) => [r[0], r[1], r[2], 0]));

async function fetchTrajectoryData(apiFetchData, uid, coordSys, startISO, stopISO) {
  const data = await apiFetchData({
    baseUrl: '/', path: uid, startISO, stopISO,
    maxPoints: 10000, coordinateSystem: coordSys,
  });
  return { reData: toReData(data.values.values) };
}

function fetchSatellite(apiFetchData, uid, cb, span, swatch, coordSys, startISO, stopISO) {
  const name = uid.split('/').pop();
  return fetchTrajectoryData(apiFetchData, uid, coordSys, startISO, stopISO)
    .then(({ reData }) => ({
      uid,
      name,
      reData,
      length: reData.length,
    }))
    .catch(err => {
      if (cb) cb.checked = false;
      throw err;
    })
    .finally(() => {
      if (span) span.classList.remove('loading');
    });
}

describe('fetchTrajectoryData refactoring', () => {
  const mockFetch = vi.fn().mockResolvedValue({
    values: { values: [[1, 2, 3], [4, 5, 6]] },
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it('transforms api response to { reData } via async function', async () => {
    const result = await fetchTrajectoryData(mockFetch, 'ssc/foo', 'GSE', '2024-01-01', '2024-01-02');

    expect(mockFetch).toHaveBeenCalledWith({
      baseUrl: '/', path: 'ssc/foo', startISO: '2024-01-01',
      stopISO: '2024-01-02', maxPoints: 10000, coordinateSystem: 'GSE',
    });
    expect(toReData).toHaveBeenCalledWith([[1, 2, 3], [4, 5, 6]]);
    expect(result).toEqual({ reData: [[1, 2, 3, 0], [4, 5, 6, 0]] });
  });

  it('propagates fetch errors through async function', async () => {
    const badFetch = vi.fn().mockRejectedValue(new Error('Network down'));
    await expect(fetchTrajectoryData(badFetch, 'x', 'GSE', 'a', 'b')).rejects.toThrow('Network down');
  });

  it('fetchSatellite .then(({ reData }) => ...) destructures correctly', async () => {
    const span = { classList: { remove: vi.fn() } };
    const result = await fetchSatellite(mockFetch, 'ssc/bar', null, span, null, 'GSE', 'a', 'b');

    expect(result.name).toBe('bar');
    expect(result.reData).toEqual([[1, 2, 3, 0], [4, 5, 6, 0]]);
    expect(result.length).toBe(2);
    expect(span.classList.remove).toHaveBeenCalledWith('loading');
  });

  it('fetchSatellite .catch unchecks checkbox on error', async () => {
    const badFetch = vi.fn().mockRejectedValue(new Error('fail'));
    const cb = { checked: true };

    await expect(fetchSatellite(badFetch, 'x', cb, null, null, 'GSE', 'a', 'b')).rejects.toThrow('fail');
    expect(cb.checked).toBe(false);
  });

  it('fetchSatellite .finally cleans up span', async () => {
    const span = { classList: { remove: vi.fn() } };
    await fetchSatellite(mockFetch, 'ssc/bar', null, span, null, 'GSE', 'a', 'b');
    expect(span.classList.remove).toHaveBeenCalledWith('loading');
  });

  it('fetchSatellite .finally cleans up span even on error', async () => {
    const badFetch = vi.fn().mockRejectedValue(new Error('fail'));
    const span = { classList: { remove: vi.fn() } };
    await expect(
      fetchSatellite(badFetch, 'x', null, span, null, 'GSE', 'a', 'b')
    ).rejects.toThrow('fail');
    expect(span.classList.remove).toHaveBeenCalledWith('loading');
  });
});
