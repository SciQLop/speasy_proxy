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
