import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(),
  fetchInventory: vi.fn(),
}));

function elStub() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(() => null),
    appendChild: vi.fn(),
    style: {},
    dataset: {},
    checked: false,
    value: '2',
    textContent: '',
    innerHTML: '',
    getAttribute: vi.fn(),
    setAttribute: vi.fn(),
    dispatchEvent: vi.fn(),
    contains: vi.fn(() => false),
    focus: vi.fn(),
    blur: vi.fn(),
  };
}

const elements = {};
function getById(id) {
  if (!elements[id]) elements[id] = elStub();
  elements[id].id = id;
  return elements[id];
}

let domInstalled = false;

function installDomMock() {
  if (domInstalled) return;
  domInstalled = true;

  class MockResizeObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  }

  class MockAbortController {
    constructor() { this.signal = { aborted: false, addEventListener: vi.fn() }; }
    abort() {}
  }

  class MockImage {
    set onload(v) { this._onload = v; }
    set onerror(v) {}
    set src(v) {
      // simulate loading: set dimensions then call onload
      this.naturalWidth = 360;
      this.naturalHeight = 180;
      if (this._onload) setTimeout(() => this._onload(), 5);
    }
  }

  class MockURL {
    static createObjectURL = vi.fn(() => 'blob:test');
    static revokeObjectURL = vi.fn();
    constructor(url) { this.href = url || ''; }
  }

  globalThis.ResizeObserver = MockResizeObserver;
  globalThis.AbortController = MockAbortController;
  globalThis.Image = MockImage;
  globalThis.URL = MockURL;
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
  globalThis.HTMLAnchorElement = class HTMLAnchorElement {};
  globalThis.Blob = class Blob {};

  globalThis.URLSearchParams = class URLSearchParams {
    get() { return null; }
    set() {}
    toString() { return ''; }
    keys() { return []; }
    entries() { return []; }
    [Symbol.iterator]() { return { next: () => ({ done: true }) }; }
    constructor() {}
  };

  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

  globalThis.document = {
    getElementById: getById,
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn(() => null),
    createElement: vi.fn((tag) => {
      const el = { ...elStub(), tagName: tag.toUpperCase() };
      if (tag === 'canvas') {
        el.width = 0;
        el.height = 0;
        el.getContext = vi.fn(() => ({
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
        }));
      }
      return el;
    }),
    createDocumentFragment: vi.fn(() => ({ appendChild: vi.fn() })),
    body: elStub(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    execCommand: vi.fn(),
  };

  globalThis.window = {
    SPEASY_BASE_URL: '',
    SPEASY_USE_CDF: false,
    location: { pathname: '/demo_3d', search: '', href: 'http://localhost/demo_3d' },
    flatpickr: vi.fn(() => ({ setDate: vi.fn(), destroy: vi.fn() })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: false, addEventListener: vi.fn() })),
    isSecureContext: true,
    navigator: { clipboard: { writeText: vi.fn(() => Promise.resolve()) } },
    history: { replaceState: vi.fn(), pushState: vi.fn() },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    performance: { now: vi.fn(() => 0) },
    requestAnimationFrame: vi.fn((cb) => setTimeout(cb, 0)),
  };
}

function mkEchartsInstance() {
  return {
    setOption: vi.fn(),
    getOption: vi.fn(() => ({})),
    getDataURL: vi.fn(() => 'data:image/png'),
    getDom: vi.fn(() => elStub()),
    getModel: vi.fn(() => ({
      getComponent: vi.fn(() => ({
        coordinateSystem: { getRect: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })) },
      })),
    })),
    getZr: vi.fn(() => ({ on: vi.fn() })),
    getWidth: vi.fn(() => 800),
    getHeight: vi.fn(() => 600),
    convertToPixel: vi.fn(() => 100),
    convertFromPixel: vi.fn(() => 100),
    on: vi.fn(),
    off: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
  };
}

installDomMock();
globalThis.echarts = { init: vi.fn(() => mkEchartsInstance()) };

const demo3d = await import('../../speasy_proxy/static/js/demo3d.js');

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  domInstalled = false;
});

describe('demo3d module loads', () => {
  it('exports an object', () => {
    expect(demo3d).toBeTruthy();
    expect(typeof demo3d).toBe('object');
  });
});
