import { describe, it, expect } from 'vitest';
import { presetConfig, configStory, pythonSnippet, dataUrls, historyMode, addRecent, recentsFrom, recentLabel } from '../../speasy_proxy/static/js/plot-share.js';

describe('presetConfig', () => {
  const preset = {
    name: 'THEMIS substorm', description: 'Dipolarization at 04:54 UT.', featured: true,
    config: { version: 1, time_range: { start: 'a', stop: 'b' }, plots: [] },
  };

  it('carries the preset story in the config, so a shared link keeps it', () => {
    const config = presetConfig(preset);
    expect(config.name).toBe('THEMIS substorm');
    expect(config.description).toBe('Dipolarization at 04:54 UT.');
    expect(config.plots).toEqual([]);
  });

  it('leaves the preset untouched', () => {
    presetConfig(preset);
    expect(preset.config.name).toBeUndefined();
  });

  it('omits an empty description', () => {
    expect(presetConfig({ ...preset, description: '' })).not.toHaveProperty('description');
  });
});

describe('configStory', () => {
  it('is the name and description of a config that has a name', () => {
    expect(configStory({ name: 'n', description: 'd', plots: [] })).toEqual({ name: 'n', description: 'd' });
    expect(configStory({ name: 'n' })).toEqual({ name: 'n', description: '' });
  });

  it('is null for a config without a name', () => {
    expect(configStory({ plots: [] })).toBeNull();
    expect(configStory({ name: '  ', description: 'd' })).toBeNull();
  });
});

const view = {
  version: 1,
  time_range: { start: '2008-02-26T04:30:00.000Z', stop: '2008-02-26T05:20:00.500Z' },
  plots: [
    { products: [{ path: 'cda/THB_L2_MOM/thb_peim_velocity_gsm' }, { path: 'ssc/ace', coordinate_system: 'gsm' }] },
    { products: [{ path: 'cda/THB_L2_MOM/thb_peim_velocity_gsm' }, { path: 'amda/bepi_sixp', product_inputs: { side: '1' } }] },
  ],
};

describe('pythonSnippet', () => {
  it('fetches each distinct product of the view with speasy', () => {
    expect(pythonSnippet(view)).toBe([
      'import speasy as spz',
      '',
      'thb_peim_velocity_gsm = spz.get_data("cda/THB_L2_MOM/thb_peim_velocity_gsm", "2008-02-26T04:30:00Z", "2008-02-26T05:20:00.500Z")',
      'ace = spz.get_data("ssc/ace", "2008-02-26T04:30:00Z", "2008-02-26T05:20:00.500Z", coordinate_system="gsm")',
      'bepi_sixp = spz.get_data("amda/bepi_sixp", "2008-02-26T04:30:00Z", "2008-02-26T05:20:00.500Z", product_inputs={"side": "1"})',
      '',
    ].join("\n"));
  });

  it('gives a product the same name twice only once, and never a name Python rejects', () => {
    const twice = { ...view, plots: [{ products: [{ path: 'ssc/ace', coordinate_system: 'gse' }, { path: 'ssc/ace', coordinate_system: 'gsm' }, { path: 'amda/1-min.b' }] }] };
    const names = pythonSnippet(twice).split("\n").slice(2, 5).map((l) => l.split(' = ')[0]);
    expect(names).toEqual(['ace', 'ace_2', '_1_min_b']);
  });
});

describe('historyMode', () => {
  const SETTLE = 1000;

  it('replaces the entry for a tweak (log scale, colormap, a product selected)', () => {
    expect(historyMode('tweak', null, 0, SETTLE)).toBe('replace');
    expect(historyMode('tweak', { kind: 'edit', at: 0 }, 5000, SETTLE)).toBe('replace');
  });

  it('adds an entry for every discrete edit, even a quick one', () => {
    expect(historyMode('edit', null, 0, SETTLE)).toBe('push');
    expect(historyMode('edit', { kind: 'edit', at: 0 }, 10, SETTLE)).toBe('push');
    expect(historyMode('edit', { kind: 'gesture', at: 0 }, 10, SETTLE)).toBe('push');
  });

  it('adds one entry per gesture: its later steps replace it until it settles', () => {
    expect(historyMode('gesture', null, 0, SETTLE)).toBe('push');
    expect(historyMode('gesture', { kind: 'gesture', at: 0 }, 300, SETTLE)).toBe('replace');
    expect(historyMode('gesture', { kind: 'gesture', at: 0 }, 1000, SETTLE)).toBe('push');
  });

  it('never folds a gesture into the edit before it', () => {
    expect(historyMode('gesture', { kind: 'edit', at: 0 }, 10, SETTLE)).toBe('push');
  });
});

describe('recent views', () => {
  const at = (path, start, stop = '2020-01-02T00:00:00.000Z') =>
    ({ version: 1, time_range: { start, stop }, plots: [{ products: [{ path }] }] });

  it('puts the newest view first and keeps at most five', () => {
    let recents = [];
    for (const p of ['a', 'b', 'c', 'd', 'e', 'f']) recents = addRecent(recents, at('cda/' + p, '2020-01-01T00:00:00.000Z'));
    expect(recents.map((c) => c.plots[0].products[0].path)).toEqual(['cda/f', 'cda/e', 'cda/d', 'cda/c', 'cda/b']);
  });

  it('keeps one entry per set of products: its latest window', () => {
    const first = addRecent([], at('cda/a', '2020-01-01T00:00:00.000Z'));
    const recents = addRecent(first, at('cda/a', '2020-01-01T12:00:00.000Z'));
    expect(recents).toHaveLength(1);
    expect(recents[0].time_range.start).toBe('2020-01-01T12:00:00.000Z');
  });

  it('reads back only well-formed views, and nothing from garbage', () => {
    expect(recentsFrom(JSON.stringify([at('cda/a', 'x'), { plots: 3 }, null]))).toEqual([at('cda/a', 'x')]);
    expect(recentsFrom('not json')).toEqual([]);
    expect(recentsFrom(null)).toEqual([]);
    expect(recentsFrom('{"a":1}')).toEqual([]);
  });

  it('labels a view by its story, else by its products, with its window', () => {
    const view = { ...at('cda/THB/thb_fgs', '2008-02-26T04:00:00.000Z', '2008-02-26T06:00:00.000Z'),
      plots: [{ products: [{ path: 'cda/THB/thb_fgs' }, { path: 'amda/imf' }] }, { products: [{ path: 'cda/THB/thb_fgs' }] }] };
    expect(recentLabel(view)).toEqual({ name: 'thb_fgs, imf', detail: '2008-02-26 04:00 UTC · 2h' });
    expect(recentLabel({ ...view, name: 'Substorm' }).name).toBe('Substorm');
  });
});

describe('dataUrls', () => {
  it('gives one CDF get_data URL per distinct product, with its parameters', () => {
    expect(dataUrls(view, 'https://host/cache/').split("\n")).toEqual([
      'https://host/cache/get_data?path=cda/THB_L2_MOM/thb_peim_velocity_gsm&start_time=2008-02-26T04:30:00Z&stop_time=2008-02-26T05:20:00.500Z&format=cdf',
      'https://host/cache/get_data?path=ssc/ace&start_time=2008-02-26T04:30:00Z&stop_time=2008-02-26T05:20:00.500Z&format=cdf&coordinate_system=gsm',
      'https://host/cache/get_data?path=amda/bepi_sixp&start_time=2008-02-26T04:30:00Z&stop_time=2008-02-26T05:20:00.500Z&format=cdf&product_inputs=%7B%22side%22%3A%221%22%7D',
    ]);
  });
});
