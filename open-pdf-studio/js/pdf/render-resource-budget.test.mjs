import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRenderResourcesForDocument, unregisterRenderResource, touchRenderResource,
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

test('incremental accounting survives replacement, owner switches, touch and removal', () => {
  resetRenderResourceBudgetForTests();
  configureRenderResourceBudget({ globalBytes: 10000, javascriptBytes: 10000, nativePixmapBytes: 10000, metadataBytes: 10000, activeDocumentShare: 0.8 }, 'a');
  registerRenderResource({ key: 'one', documentId: 'a', bytes: 120 });
  registerRenderResource({ key: 'two', documentId: 'b', category: 'native', bytes: 200 });
  registerRenderResource({ key: 'one', documentId: 'b', category: 'metadata', bytes: 80 });
  touchRenderResource('two');
  let value = renderResourceBudgetSnapshot();
  assert.equal(value.usage.total, 280); assert.equal(value.usage.javascript, 0); assert.equal(value.usage.active.total, 0);
  setActiveRenderDocument('b'); value = renderResourceBudgetSnapshot();
  assert.equal(value.usage.active.total, 280); assert.equal(value.usage.inactive.total, 0);
  unregisterRenderResource('one'); clearRenderResourcesForDocument('b');
  assert.equal(renderResourceBudgetSnapshot().usage.total, 0);
});


test('closing or releasing oversized owners immediately restores background admission', () => {
  resetRenderResourceBudgetForTests();
  configureRenderResourceBudget({ globalBytes: 100, javascriptBytes: 60,
    nativePixmapBytes: 30, metadataBytes: 10, activeDocumentShare: 0.8 }, 'active');
  const add = () => registerRenderResource({ key: 'large', documentId: 'active',
    bytes: 100, protected: () => true });
  add(); assert.equal(renderResourceBudgetSnapshot().overBudget, true);
  unregisterRenderResource('large');
  assert.equal(renderResourceBudgetSnapshot().overBudget, false);
  add(); clearRenderResourcesForDocument('active');
  assert.equal(renderResourceBudgetSnapshot().overBudget, false);
});
