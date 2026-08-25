// Minimal browser globals for exercising the page entry modules (plot.js, demo3d.js)
// under Vitest's node environment. Only what those modules actually touch.
import { vi } from 'vitest';

export function elStub(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(() => null),
    appendChild(child) { this.children.push(child); return child; },
    removeChild: vi.fn(),
    insertBefore: vi.fn(),
    style: {},
    dataset: {},
    checked: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    clientWidth: 800,
    clientHeight: 600,
    offsetWidth: 800,
    offsetHeight: 600,
    getAttribute: vi.fn(),
    setAttribute: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    click: vi.fn(),
  };
}

// The real chart only has a model (grids, axes, coordinate systems) once setOption has
// run — code that reads geometry before the first setOption crashes in the browser, so
// the mock reproduces that instead of always handing back a model.
export function mkEchartsInstance() {
  const calls = [];
  let hasOption = false;
  // A real zrender instance is one object for the chart's lifetime — elements
  // added via getZr().add() must still be found by a later getZr().remove().
  const zr = { on: vi.fn(), off: vi.fn(), add: vi.fn(), remove: vi.fn() };
  return {
    calls,
    setOption: vi.fn((opt, mode) => { hasOption = true; calls.push({ opt, mode }); }),
    getOption: vi.fn(() => ({ xAxis: [{}], dataZoom: [{}] })),
    getDataURL: vi.fn(() => 'data:image/png'),
    getDom: vi.fn(() => elStub()),
    getModel: vi.fn(() => (hasOption ? {
      getComponent: vi.fn(() => ({
        coordinateSystem: { getRect: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })) },
      })),
    } : undefined)),
    getZr: vi.fn(() => zr),
    getWidth: vi.fn(() => 800),
    getHeight: vi.fn(() => 600),
    convertToPixel: vi.fn(() => 100),
    convertFromPixel: vi.fn(() => 100),
    dispatchAction: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
  };
}

export function installDom({ pathname = '/', search = '', origin = 'http://localhost', baseUrl = '' } = {}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    echarts: globalThis.echarts,
  };

  const elements = {};
  const created = [];
  const getById = (id) => {
    if (!elements[id]) {
      elements[id] = elStub();
      elements[id].id = id;
    }
    return elements[id];
  };

  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.AbortController = globalThis.AbortController || class {
    constructor() { this.signal = { aborted: false, addEventListener: vi.fn() }; }
    abort() {}
  };
  globalThis.Image = class {
    set onload(v) { this._onload = v; }
    set onerror(v) {}
    set src(v) { this.naturalWidth = 256; this.naturalHeight = 180; if (this._onload) setTimeout(() => this._onload(), 0); }
  };
  globalThis.Blob = globalThis.Blob || class {};
  globalThis.HTMLCanvasElement = globalThis.HTMLCanvasElement || class {};
  globalThis.HTMLAnchorElement = globalThis.HTMLAnchorElement || class {};
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
  globalThis.atob = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));

  const listeners = {};
  globalThis.document = {
    getElementById: getById,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    createElement: vi.fn((tag) => {
      const el = elStub(tag);
      if (tag === 'canvas') {
        el.width = 0;
        el.height = 0;
        el.imageData = null;
        el.getContext = () => ({
          drawImage: vi.fn(),
          getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: (img) => { el.imageData = img; },
        });
      }
      created.push(el);
      return el;
    }),
    createDocumentFragment: vi.fn(() => ({ appendChild: vi.fn() })),
    body: elStub(),
    documentElement: elStub(),
    addEventListener: vi.fn((type, fn) => { (listeners[type] ||= []).push(fn); }),
    removeEventListener: vi.fn(),
    execCommand: vi.fn(),
    listeners,
  };

  globalThis.window = {
    SPEASY_BASE_URL: baseUrl,
    SPEASY_USE_CDF: false,
    location: { pathname, search, origin, href: origin + pathname + search },
    history: { replaceState: vi.fn(), pushState: vi.fn() },
    flatpickr: vi.fn(() => ({ setDate: vi.fn(), destroy: vi.fn() })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: false, addEventListener: vi.fn() })),
    isSecureContext: true,
    navigator: { clipboard: { writeText: vi.fn(() => Promise.resolve()) } },
    devicePixelRatio: 1,
    innerWidth: 1200,
    innerHeight: 900,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    performance: { now: () => 0 },
  };
  globalThis.history = globalThis.window.history;

  // Minimal stand-ins for the zrender element classes plot.js uses to position
  // heatmap images directly (bypassing chart.setOption for per-frame repositioning).
  class ZrElStub {
    constructor(opts = {}) { Object.assign(this, opts); }
    setStyle(style) { this.style = { ...(this.style || {}), ...style }; }
  }
  class GroupStub extends ZrElStub {
    constructor(opts) { super(opts); this.children = []; }
    add(child) { this.children.push(child); }
    setClipPath(shape) { this.clipPath = shape; }
  }
  class RectStub extends ZrElStub {}

  globalThis.echarts = {
    init: vi.fn(() => mkEchartsInstance()),
    graphic: { Image: ZrElStub, Group: GroupStub, Rect: RectStub },
  };

  return {
    elements,
    created,
    getById,
    // Fire a listener registered with document.addEventListener(type, fn).
    fireDocument(type, event) { for (const fn of listeners[type] || []) fn(event); },
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.echarts = saved.echarts;
    },
  };
}

export const installDemo3dDom = (opts) => installDom({ pathname: '/demo_3d', ...opts });
export const installPlotDom = (opts) => installDom({ pathname: '/plot', ...opts });
