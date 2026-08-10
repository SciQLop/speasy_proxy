import { describe, it, expect, vi, afterAll } from 'vitest';
import { fetchData } from '../../speasy_proxy/static/js/api-client.js';
import { installDemo3dDom } from './helpers/dom-mock.js';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(),
  fetchInventory: vi.fn(() => Promise.resolve({})),
}));

const dom = installDemo3dDom();
const demo3d = await import('../../speasy_proxy/static/js/demo3d.js');
const { trajectories, fetchSatellite, clearAllTrajectories } = demo3d.__test__;

afterAll(() => dom.restore());

function nodeStubs() {
  return {
    cb: { checked: true },
    span: { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } },
    swatch: { style: {} },
  };
}

describe('clearing trajectories while a fetch is in flight', () => {
  it('drops the late result instead of resurrecting the orbit', async () => {
    let resolveFetch;
    fetchData.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));
    const { cb, span, swatch } = nodeStubs();

    const inFlight = fetchSatellite('ssc/ace', cb, span, swatch, 'gse', 'a', 'b');
    clearAllTrajectories();
    resolveFetch({ values: { values: [[1, 2, 3], [4, 5, 6]] } });
    await inFlight;

    expect(trajectories.size).toBe(0);
    expect(span.classList.add).not.toHaveBeenCalledWith('plotted');
    expect(swatch.style.display).toBeUndefined();
  });

  it('still plots a fetch that started after the clear', async () => {
    fetchData.mockResolvedValueOnce({ values: { values: [[1, 2, 3]] } });
    const { cb, span, swatch } = nodeStubs();

    clearAllTrajectories();
    await fetchSatellite('ssc/ace', cb, span, swatch, 'gse', 'a', 'b');

    expect(trajectories.size).toBe(1);
    expect(trajectories.get('ssc/ace').name).toBe('ace');
    clearAllTrajectories();
  });
});
