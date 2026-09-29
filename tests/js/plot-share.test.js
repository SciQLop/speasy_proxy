import { describe, it, expect } from 'vitest';
import { presetConfig, configStory } from '../../speasy_proxy/static/js/plot-share.js';

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
