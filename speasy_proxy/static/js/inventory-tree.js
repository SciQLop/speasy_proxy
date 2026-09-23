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
