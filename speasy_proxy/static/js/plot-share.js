// A /plot view as it leaves or re-enters the page: preset stories, code snippets,
// recent views. Pure functions over the share config (plot.js stateToConfig).

// The config a preset opens with. The server keeps name and description beside the
// config; folding them in makes the story travel with the share URL.
export function presetConfig(preset) {
  return {
    ...preset.config,
    name: preset.name,
    ...(preset.description ? { description: preset.description } : {}),
  };
}

// { name, description } of a config that tells a story, else null.
export function configStory(config) {
  const name = (config.name || '').trim();
  return name ? { name, description: config.description || '' } : null;
}
