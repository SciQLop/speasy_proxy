import { describe, it, expect } from 'vitest';
import {
  SKIP_KEYS, getDisplayName, getProductPath, shouldSkipNode,
  isSpzMetaKey, hasVisibleChildren, isParameterIndex,
} from '../../speasy_proxy/static/js/inventory-tree.js';

describe('inventory primitives', () => {
  it('detects __spz_ meta keys', () => {
    expect(isSpzMetaKey('__spz_uid__')).toBe(true);
    expect(isSpzMetaKey('Cluster')).toBe(false);
  });
  it('resolves display name with fallbacks', () => {
    expect(getDisplayName({ __spz_name__: 'B GSM' }, 'k')).toBe('B GSM');
    expect(getDisplayName({ name: 'fallback' }, 'k')).toBe('fallback');
    expect(getDisplayName(null, 'key-fallback')).toBe('key-fallback');
  });
  it('builds product path, honoring a default provider', () => {
    expect(getProductPath({ __spz_provider__: 'amda', __spz_uid__: 'x' })).toBe('amda/x');
    expect(getProductPath({ __spz_uid__: 'ace' }, 'ssc')).toBe('ssc/ace');
  });
  it('skips non-objects and Catalog/TimeTable nodes', () => {
    expect(shouldSkipNode(null)).toBe(true);
    expect(shouldSkipNode('str')).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'CatalogIndex' })).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'TimeTableIndex' })).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'ParameterIndex' })).toBe(false);
  });
  it('detects visible children and ParameterIndex leaves', () => {
    expect(hasVisibleChildren({ __spz_uid__: 'x', child: {} })).toBe(true);
    expect(hasVisibleChildren({ __spz_uid__: 'x' })).toBe(false);
    expect(isParameterIndex({ __spz_type__: 'ParameterIndex' })).toBe(true);
    expect(isParameterIndex({ __spz_type__: 'DatasetIndex' })).toBe(false);
  });
  it('SKIP_KEYS contains expected metadata keys', () => {
    expect(SKIP_KEYS.has('__spz_name__')).toBe(true);
    expect(SKIP_KEYS.has('description')).toBe(true);
    expect(SKIP_KEYS.has('UNITS')).toBe(true);
  });
});
