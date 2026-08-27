import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureTextLayerOwner,
  createTextLayerRequestRegistry,
  findTextLayerForOwner,
  stampTextLayerOwner,
  textLayerElementMatchesOwner,
  textLayerOwnerMatchesDocument,
} from './text-layer-lifecycle.js';

function documentState(overrides = {}) {
  return {
    id: 'doc-a',
    lifecycleGeneration: 4,
    currentPage: 2,
    viewMode: 'single',
    ...overrides,
  };
}

test('text-layer ownership rejects stale documents, generations, pages, and view modes', () => {
  const owner = captureTextLayerOwner(documentState(), 2);
  assert.equal(textLayerOwnerMatchesDocument(owner, documentState()), true);
  assert.equal(textLayerOwnerMatchesDocument(owner, documentState({ id: 'doc-b' })), false);
  assert.equal(textLayerOwnerMatchesDocument(owner, documentState({ lifecycleGeneration: 5 })), false);
  assert.equal(textLayerOwnerMatchesDocument(owner, documentState({ currentPage: 1 })), false);
  assert.equal(textLayerOwnerMatchesDocument(owner, documentState({ viewMode: 'continuous' })), false);

  const continuousOwner = captureTextLayerOwner(
    documentState({ viewMode: 'continuous' }),
    7,
  );
  assert.equal(textLayerOwnerMatchesDocument(
    continuousOwner,
    documentState({ viewMode: 'continuous', currentPage: 19 }),
  ), true, 'continuous page layers must survive ordinary current-page tracking');
});

test('text-layer elements retain immutable owner identity', () => {
  const owner = captureTextLayerOwner(documentState(), 2);
  const element = { dataset: {} };
  assert.equal(stampTextLayerOwner(element, owner, 11), true);
  assert.equal(textLayerElementMatchesOwner(element, owner), true);
  assert.equal(element.dataset.textLayerRequest, '11');
  element.dataset.documentGeneration = '3';
  assert.equal(textLayerElementMatchesOwner(element, owner), false);
});

test('owner lookup ignores stale or hidden-view layers outside the active identity', () => {
  const owner = captureTextLayerOwner(documentState(), 2);
  const staleView = { dataset: {} };
  const staleDocument = { dataset: {} };
  const current = { dataset: {} };
  stampTextLayerOwner(staleView, { ...owner, viewMode: 'continuous' }, 8);
  stampTextLayerOwner(staleDocument, { ...owner, documentId: 'doc-b' }, 9);
  stampTextLayerOwner(current, owner, 10);
  const container = {
    querySelectorAll(selector) {
      assert.equal(selector, '.textLayer');
      return [staleView, staleDocument, current];
    },
  };
  assert.equal(findTextLayerForOwner(container, owner), current);
  assert.equal(findTextLayerForOwner({ querySelectorAll: () => [staleView] }, owner), null);
});

test('new requests suppress older work in the same page container', () => {
  const registry = createTextLayerRequestRegistry();
  const container = {};
  const owner = captureTextLayerOwner(documentState(), 2);
  const first = registry.begin(container, owner);
  assert.equal(registry.isCurrent(first, documentState()), true);
  const second = registry.begin(container, owner);
  assert.equal(registry.isCurrent(first, documentState()), false);
  assert.equal(registry.isCurrent(second, documentState()), true);
});

test('container and global invalidation prevent late publication after teardown', () => {
  const registry = createTextLayerRequestRegistry();
  const owner = captureTextLayerOwner(documentState(), 2);
  const firstContainer = {};
  const secondContainer = {};
  const first = registry.begin(firstContainer, owner);
  const second = registry.begin(secondContainer, owner);
  registry.invalidateContainer(firstContainer);
  assert.equal(registry.isCurrent(first, documentState()), false);
  assert.equal(registry.isCurrent(second, documentState()), true);
  registry.invalidateAll();
  assert.equal(registry.isCurrent(second, documentState()), false);
});
