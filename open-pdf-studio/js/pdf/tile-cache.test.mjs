import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureRenderResourceBudget,
  renderResourceBudgetSnapshot,
  resetRenderResourceBudgetForTests,
} from './render-resource-budget.js';
import {
  registerTileCacheOwner,
  tileCacheClearAll,
  tileCacheSet,
  tileCacheSnapshotForTests,
} from './tile-cache.js';

test.afterEach(() => {
  tileCacheClearAll();
  resetRenderResourceBudgetForTests();
  delete globalThis.createImageBitmap;
});

test('tiles are byte-accounted and closed when the shared budget evicts them', async () => {
  let closeCount = 0;
  globalThis.createImageBitmap = async (imageData) => ({
    width: imageData.width,
    height: imageData.height,
    close: () => { closeCount += 1; },
  });
  configureRenderResourceBudget({
    globalBytes: 1_000,
    javascriptBytes: 500,
    nativePixmapBytes: 300,
    metadataBytes: 200,
    activeDocumentShare: 0.8,
  }, 'active');
  registerTileCacheOwner('/tile.pdf', 'inactive');
  await tileCacheSet('/tile.pdf', 1, 2, 0, '0,0', { width: 10, height: 10 }, {
    renderScale: 2, regionXpt: 0, regionYpt: 0, regionWpt: 5, regionHpt: 5,
  });
  assert.equal(tileCacheSnapshotForTests().entries, 0);
  assert.equal(renderResourceBudgetSnapshot().usage.javascript, 0);
  assert.equal(closeCount, 1);
});
