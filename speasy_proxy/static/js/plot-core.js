// Pure data-processing for the plot viewer. No DOM, no ECharts.

export function createSubplotData() {
  return {
    products: [],
    y_axis: { log: false },
    logScale: true,
    plotType: 'line',
    lastHeatmapImg: null,
    productData: {},
  };
}

export function createProductCache(path) {
  return {
    path,
    intervals: [],
    times: [],
    columns: {},
    columnNames: [],
    unit: '',
    yAxis: null,
    yAxisName: '',
    yAxisUnit: '',
    rows: [],
    displayType: '',
  };
}

export function subplotToConfig(sp) {
  return {
    products: sp.products.map((p) => ({ path: p.path, label: p.label })),
    y_axis: { log: sp.y_axis.log },
    log_z: sp.logScale,
  };
}

export function subplotFromConfig(plotDef) {
  const subplot = createSubplotData();
  subplot.y_axis.log = plotDef.y_axis?.log || false;
  if (plotDef.log_z !== undefined) subplot.logScale = plotDef.log_z;
  for (const prod of plotDef.products) {
    subplot.products.push({ path: prod.path, label: prod.label || prod.path });
    subplot.productData[prod.path] = createProductCache(prod.path);
  }
  return subplot;
}

export function detectPlotType(json) {
  const meta = json.values.meta || {};
  const displayType = (meta.DISPLAY_TYPE || '').toLowerCase();
  const numCols = json.values.values.length > 0 ? json.values.values[0].length : 0;
  if (displayType === 'spectrogram' || (numCols > 10 && json.axes.length >= 2)) return 'heatmap';
  return 'line';
}

export function mergeSortedRows(oldTimes, newTimes, oldRows, newRows) {
  const resultTimes = [];
  const resultRows = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
    else if (oldTimes[i] > newTimes[j]) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
    else { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); i++; j++; }
  }
  while (i < oldTimes.length) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
  while (j < newTimes.length) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
  return { times: resultTimes, rows: resultRows };
}

export function mergeSorted(oldTimes, newTimes, oldColumns, newValues, columnNames) {
  const resultTimes = [];
  const resultColumns = {};
  for (const cn of columnNames) resultColumns[cn] = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) {
      resultTimes.push(oldTimes[i]);
      for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
      i++;
    } else if (oldTimes[i] > newTimes[j]) {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      j++;
    } else {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      i++; j++;
    }
  }
  while (i < oldTimes.length) {
    resultTimes.push(oldTimes[i]);
    for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
    i++;
  }
  while (j < newTimes.length) {
    resultTimes.push(newTimes[j]);
    for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
    j++;
  }
  return { times: resultTimes, columns: resultColumns };
}

export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [intervals[0].slice()];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
    else merged.push(intervals[i].slice());
  }
  return merged;
}

export function evictProductCache(cache, maxPoints) {
  if (cache.times.length <= maxPoints) return;
  const excess = cache.times.length - maxPoints;
  cache.times = cache.times.slice(excess);
  if (cache.rows.length > 0) {
    cache.rows = cache.rows.slice(excess);
  } else {
    for (const cn of cache.columnNames) cache.columns[cn] = cache.columns[cn].slice(excess);
  }
  if (cache.times.length > 0) {
    const newStart = cache.times[0];
    cache.intervals = cache.intervals
      .map((iv) => [Math.max(iv[0], newStart), iv[1]])
      .filter((iv) => iv[1] > iv[0]);
  }
}

export function buildSeriesData(times, values) {
  const data = new Array(times.length);
  for (let i = 0; i < times.length; i++) data[i] = [times[i], values[i]];
  return data;
}

export function configToBase64(config) {
  return btoa(JSON.stringify(config)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToConfig(b64) {
  return JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
}
