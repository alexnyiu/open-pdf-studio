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
import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import { captureRenderPublicationToken } from './render-publication-token.js';

function publicationOwner() {
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = 1;
  revisionState.pageContentRevisions[1] = 1;
  return {
    id: 'tile-owner',
    lifecycleGeneration: 1,
    pdfDoc: {},
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
  };
}

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

test('a tile decoded for an old page revision is closed instead of inserted', async () => {
  let resolveDecode;
  let closeCount = 0;
  globalThis.createImageBitmap = () => new Promise((resolve) => {
    resolveDecode = () => resolve({ width: 10, height: 10, close: () => { closeCount += 1; } });
  });
  const documentState = publicationOwner();
  const token = captureRenderPublicationToken(documentState, 1, 'tile-cache-test');
  const insertion = tileCacheSet(
    '/tile-race.pdf',
    1,
    2,
    0,
    '0,0',
    { width: 10, height: 10 },
    { renderScale: 2 },
    { token, documentState },
  );
  documentState.revisionState.pageContentRevisions[1] = 2;
  resolveDecode();
  assert.equal(await insertion, null);
  assert.equal(tileCacheSnapshotForTests().entries, 0);
  assert.equal(closeCount, 1);
});
