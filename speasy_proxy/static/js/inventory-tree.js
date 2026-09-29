// Shared speasy inventory (__spz_*) schema primitives.
// Page-specific skip-sets and DOM tree builders stay in the pages.

export const SKIP_KEYS = new Set([
  '__spz_name__', '__spz_provider__', '__spz_type__', '__spz_uid__',
  'build_date', 'Catalogs', 'TimeTables',
  'start_date', 'stop_date', 'dt', 'sampling_time',
  'is_public', 'description', 'units', 'display_type',
  'n_components', 'dataset', 'process_id',
  'FIELDNAM', 'CATDESC', 'LABLAXIS', 'UNITS', 'VALIDMIN', 'VALIDMAX',
  'SCALEMIN', 'SCALEMAX', 'SCALETYP', 'FILLVAL', 'SI_CONVERSION',
  'COORDINATE_SYSTEM', 'TENSOR_ORDER', 'SIZES', 'DEPEND_1',
  'LABL_PTR_1', 'LABL_PTR_2', 'COMPONENT_0', 'COMPONENT_1',
  'COMPONENT_2', 'QUALITY', 'spaseId', 'dataSource',
  // Rendered explicitly by the AMDA template-parameter form (see plot.js
  // renderProductParams), not as a browsable tree branch.
  '__spz_arguments__',
]);

// SSC trajectory-catalog keys. Kept out of SKIP_KEYS because they are ordinary
// attribute names elsewhere ('Id', 'Resolution', 'Geometry'), and hiding them
// globally would drop real parameters from the /plot tree and metadata panel.
export const SSC_METADATA_KEYS = new Set([
  'maxDate', 'minDate', 'Id', 'Resolution', 'Geometry',
  'TrajectoryGeometry', 'ResourceId', 'GroupId',
]);

export function isSpzMetaKey(key) {
  return key.startsWith('__spz_');
}

export function getDisplayName(node, key) {
  return (node && (node.__spz_name__ || node.name)) || key;
}

export function getProductPath(node, defaultProvider) {
  const provider = node.__spz_provider__ || defaultProvider;
  return provider + '/' + node.__spz_uid__;
}

export function shouldSkipNode(node) {
  if (!node || typeof node !== 'object') return true;
  const t = node.__spz_type__ || '';
  return t.indexOf('Catalog') !== -1 || t.indexOf('TimeTable') !== -1;
}

export function hasVisibleChildren(node, isMeta = isSpzMetaKey) {
  if (typeof node !== 'object' || node === null) return false;
  return Object.keys(node).some((k) => !isMeta(k));
}

export function isParameterIndex(node) {
  return node.__spz_type__ === 'ParameterIndex';
}

// A TemplatedParameterIndex (AMDA's parametrized products, e.g. "proton flux,
// side ##key##") is selectable exactly like a plain ParameterIndex -- it just
// also needs a product_inputs form (see plot.js renderProductParams).
export function isSelectableProduct(node) {
  return node.__spz_type__ === 'ParameterIndex' || node.__spz_type__ === 'TemplatedParameterIndex';
}

// Child entries a tree shows for a node: object-valued, not metadata, not a catalog.
export function browsableChildKeys(node) {
  return Object.keys(node).filter((k) => !SKIP_KEYS.has(k) && node[k] !== null
    && typeof node[k] === 'object' && !shouldSkipNode(node[k]));
}

// Whether a branch would show anything: some descendant is a selectable product.
// Memoized per node, so deciding it for a whole ~100k-node inventory is one walk.
const selectableBelow = new WeakMap();
export function hasSelectableDescendant(node) {
  if (!node || typeof node !== 'object') return false;
  if (!selectableBelow.has(node)) {
    selectableBelow.set(node, browsableChildKeys(node).some((k) =>
      isSelectableProduct(node[k]) || hasSelectableDescendant(node[k])));
  }
  return selectableBelow.get(node);
}

// SSCWeb trajectories accept a fixed coordinate_system, same choices for every product
// (see get_data.py's Query enum): unlike AMDA's arguments, not inventory metadata.
const SSC_COORDINATE_SYSTEMS = ['geo', 'gm', 'gse', 'gsm', 'sm', 'geitod', 'geij2000'];

const pairs = (values) => values.map((v) => [v, v]);

// The extra /get_data parameters a product takes, one dropdown each:
// [{ key, label, choices: [[label, value], ...], default }]. key is 'coordinate_system'
// or an AMDA template argument (sent in product_inputs). frames3d: the 3DView frame
// list once fetched (get_3dview_frames); J2000 until then.
export function paramSpecs(node, frames3d = []) {
  if (node?.__spz_type__ === 'TemplatedParameterIndex' && node.__spz_arguments__) {
    return templateArgSpecs(node.__spz_arguments__);
  }
  if (node?.__spz_provider__ === 'ssc') {
    return [{ key: 'coordinate_system', label: 'Coord.', choices: pairs(SSC_COORDINATE_SYSTEMS), default: 'gse' }];
  }
  if (node?.__spz_provider__ === 'cdpp3dview') {
    const frames = frames3d.length > 0 ? frames3d : ['J2000'];
    return [{ key: 'coordinate_system', label: 'Frame', choices: pairs(frames), default: frames.includes('J2000') ? 'J2000' : frames[0] }];
  }
  return [];
}

// AMDA's __spz_arguments__ is an ArgumentListIndex of ArgumentIndex nodes
// (key/name/default/choices); needs inventory version 2 for `choices` to be real JSON.
function templateArgSpecs(args) {
  return Object.entries(args)
    .filter(([name, arg]) => !isSpzMetaKey(name) && name !== 'name' && name !== 'is_public' && arg && typeof arg === 'object')
    .map(([name, arg]) => ({
      key: arg.key || name,
      label: arg.name || arg.key || name,
      choices: Array.isArray(arg.choices) && arg.choices.length > 0 ? arg.choices : [[arg.default, arg.default]],
      default: arg.default,
    }));
}

// Hover text for a tree node: its description, then the fields a user looks for first
// (units, coverage, cadence), then every other plain field. Providers name these
// differently (AMDA description/desc/units, CDA ISTP CATDESC/UNITS).
const DESCRIPTION_KEYS = ['description', 'CATDESC', 'desc'];
const LEADING_KEYS = ['units', 'UNITS', 'start_date', 'stop_date', 'Time_resolution', 'sampling', 'DISPLAY_TYPE'];
const HIDDEN_KEYS = new Set(['is_public', 'user_product', 'name']);
const MAX_VALUE_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_LINES = 20;

export function nodeTooltip(node) {
  const fields = Object.entries(node || {}).filter(([key, value]) => isShownField(key, value));
  const descriptionKey = DESCRIPTION_KEYS.find((key) => fields.some(([k]) => k === key));
  const byKey = Object.fromEntries(fields);
  const ordered = [
    ...LEADING_KEYS.filter((key) => key in byKey),
    ...fields.map(([key]) => key).filter((key) => key !== descriptionKey && !LEADING_KEYS.includes(key)),
  ];
  const description = descriptionKey ? [truncate(plainText(byKey[descriptionKey]), MAX_DESCRIPTION_CHARS)] : [];
  return [...description, ...ordered.map((key) => truncate(key + ': ' + plainText(byKey[key]), MAX_VALUE_CHARS))]
    .slice(0, MAX_LINES)
    .join('\n');
}

function isShownField(key, value) {
  if (isSpzMetaKey(key) || HIDDEN_KEYS.has(key)) return false;
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  return String(value).trim() !== '';
}

// AMDA descriptions carry HTML (<br/>, <b>): keep the line breaks, drop the tags.
function plainText(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
