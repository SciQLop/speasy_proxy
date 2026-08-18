import { describe, it, expect, vi, afterAll } from 'vitest';
import { fetchData } from '../../speasy_proxy/static/js/api-client.js';
import { installDemo3dDom } from './helpers/dom-mock.js';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(),
  fetchInventory: vi.fn(() => Promise.resolve({})),
}));

const dom = installDemo3dDom();
const demo3d = await import('../../speasy_proxy/static/js/demo3d.js');
const { onToggleSatellite } = demo3d.__test__;

afterAll(() => dom.restore());

function nodeStubs(uid) {
  return {
    cb: { checked: true, dataset: { uid } },
    span: { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } },
    swatch: { style: {} },
  };
}

describe('group checkbox sync on a failed leaf toggle', () => {
  it('resyncs the parent group checkbox when a leaf fails time-bounds validation', async () => {
    const { cb: leaf2 } = nodeStubs('ssc/leaf2');
    const leaf1 = { checked: true };
    const groupCb = { checked: true, indeterminate: false };
    const folder = { querySelectorAll: vi.fn(() => [leaf1, leaf2]) };
    groupCb.closest = vi.fn(() => folder);

    globalThis.document.querySelectorAll = vi.fn((sel) => (sel === '.group-checkbox' ? [groupCb] : []));

    const { span, swatch } = nodeStubs('ssc/leaf2');
    await onToggleSatellite(leaf2, span, swatch);

    expect(leaf2.checked).toBe(false);
    expect(groupCb.checked).toBe(false);
    expect(groupCb.indeterminate).toBe(true);
  });
});
