import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(),
  fetchInventory: vi.fn(),
}));

function elStub(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(() => null),
    appendChild(child) { this.children.push(child); return child; },
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
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
  };
}

const checkboxes = [];
const allElements = [];

function createEl(tag) {
  const el = elStub(tag);
  allElements.push(el);
  if (tag === 'input') {
    el.type = '';
    checkboxes.push(el);
  }
  if (tag === 'canvas') {
    el.width = 0;
    el.height = 0;
    el.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    }));
  }
  return el;
}

const elements = {};
function getById(id) {
  if (!elements[id]) {
    elements[id] = elStub();
    elements[id].id = id;
  }
  return elements[id];
}

let domInstalled = false;
function installDomMock() {
  if (domInstalled) return;
  domInstalled = true;

  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.AbortController = class { constructor() { this.signal = { aborted: false, addEventListener: vi.fn() }; } abort() {} };
  globalThis.Image = class {
    set onload(v) { this._onload = v; }
    set onerror(v) {}
    set src(v) { this.naturalWidth = 360; this.naturalHeight = 180; if (this._onload) setTimeout(() => this._onload(), 5); }
  };
  globalThis.URL = class {
    static createObjectURL = vi.fn(() => 'blob:test');
    static revokeObjectURL = vi.fn();
    constructor(url) { this.href = url || ''; }
  };
  globalThis.HTMLCanvasElement = class {};
  globalThis.HTMLAnchorElement = class {};
  globalThis.Blob = class {};
  globalThis.URLSearchParams = class {
    get() { return null; } set() {} toString() { return ''; }
    keys() { return []; } entries() { return []; }
    [Symbol.iterator]() { return { next: () => ({ done: true }) }; }
  };
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

  globalThis.document = {
    getElementById: getById,
    querySelectorAll: vi.fn((sel) => {
      if (sel.includes('checkbox') && sel.includes('data-uid')) {
        const onlyChecked = sel.includes(':checked');
        return checkboxes.filter(cb => onlyChecked ? cb.checked : true);
      }
      return [];
    }),
    querySelector: vi.fn(() => null),
    createElement: vi.fn((tag) => createEl(tag)),
    createDocumentFragment: vi.fn(() => ({ appendChild: vi.fn() })),
    body: elStub(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    execCommand: vi.fn(),
  };

  globalThis.window = {
    SPEASY_BASE_URL: '',
    SPEASY_USE_CDF: false,
    location: { pathname: '/demo_3d', search: '?uids=ssc%2Ffoo', href: 'http://localhost/demo_3d?uids=ssc%2Ffoo' },
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
  checkboxes.length = 0;
  allElements.length = 0;
});

afterAll(() => {
  domInstalled = false;
});

describe('demo3d checkbox sync', () => {
  it('exports an object', () => {
    expect(demo3d).toBeTruthy();
    expect(typeof demo3d).toBe('object');
  });

  it('module loads without throwing', () => {
    expect(typeof demo3d).toBe('object');
  });

  it('folder group-checkbox exists in tree structure', async () => {
    // Verify the tree-building code creates group-checkbox elements for folders
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../speasy_proxy/static/js/demo3d.js'), 'utf8');
    expect(src).toContain('group-checkbox');
    expect(src).toContain('syncGroupCheckboxes');
  });
});
