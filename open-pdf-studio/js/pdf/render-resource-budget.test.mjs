import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureRenderResourceBudget,
  registerRenderResource,
  renderResourceBudgetSnapshot,
  resetRenderResourceBudgetForTests,
  setActiveRenderDocument,
} from './render-resource-budget.js';

test('byte budget evicts inactive LRU entries before active visible resources', () => {
  resetRenderResourceBudgetForTests();
  const released = [];
  configureRenderResourceBudget({
    globalBytes: 100, javascriptBytes: 60, nativePixmapBytes: 30,
    metadataBytes: 10, activeDocumentShare: 0.8,
  }, 'active');
  registerRenderResource({ key: 'old', documentId: 'inactive', bytes: 35, release: () => released.push('old') });
  registerRenderResource({ key: 'visible', documentId: 'active', bytes: 35, protected: () => true });
  assert.deepEqual(released, ['old']);
  const snapshot = renderResourceBudgetSnapshot();
  assert.equal(snapshot.usage.javascript, 35);
  assert.equal(snapshot.usage.active.javascript, 35);
  assert.equal(snapshot.usage.inactive.javascript, 0);
  setActiveRenderDocument('other');
});

test('a protected visible surface may exceed its share but closes background admission', () => {
  resetRenderResourceBudgetForTests();
  configureRenderResourceBudget({
    globalBytes: 100, javascriptBytes: 60, nativePixmapBytes: 30,
    metadataBytes: 10, activeDocumentShare: 0.8,
  }, 'active');
  registerRenderResource({
    key: 'oversized-visible', documentId: 'active', bytes: 55, protected: () => true,
  });
  assert.equal(renderResourceBudgetSnapshot().overBudget, true);
});

test('in-flight native raster bytes participate in admission pressure', () => {
  resetRenderResourceBudgetForTests();
  configureRenderResourceBudget({
    globalBytes: 100, javascriptBytes: 60, nativePixmapBytes: 30,
    metadataBytes: 10, activeDocumentShare: 0.8,
  }, 'active');
  registerRenderResource({
    key: 'native-visible', category: 'native', documentId: 'active',
    bytes: 25, protected: () => true,
  });
  const snapshot = renderResourceBudgetSnapshot();
  assert.equal(snapshot.usage.native, 25);
  assert.equal(snapshot.overBudget, true, '25 bytes exceed the 24-byte active native share');
});
