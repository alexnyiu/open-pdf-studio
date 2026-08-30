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
  tileCacheClearPages,
  tileCacheGet,
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

test('a prewarmed tile survives proxy-global revision but not a page revision', async () => {
  let contentRevision = 1;
  let pageRevision = 1;
  let closeCount = 0;
  globalThis.createImageBitmap = async (imageData) => ({
    width: imageData.width,
    height: imageData.height,
    close: () => { closeCount += 1; },
  });
  configureRenderResourceBudget({
    globalBytes: 1_000_000,
    javascriptBytes: 1_000_000,
    nativePixmapBytes: 1_000_000,
    metadataBytes: 1_000_000,
    activeDocumentShare: 0.8,
  }, 'tile-owner');
  registerTileCacheOwner('/same-path.pdf', 'tile-owner', 3,
    () => contentRevision, () => pageRevision);
  const region = { renderScale: 2 };
  await tileCacheSet('/same-path.pdf', 1, 2, 0, '0,0', { width: 10, height: 10 }, region);
  assert.ok(tileCacheGet('/same-path.pdf', 1, 2, 0, '0,0'));
  contentRevision = 2;
  assert.ok(tileCacheGet('/same-path.pdf', 1, 2, 0, '0,0'));
  pageRevision = 2;
  assert.equal(tileCacheGet('/same-path.pdf', 1, 2, 0, '0,0'), null);
  assert.equal(closeCount, 0);
  tileCacheClearAll();
  assert.equal(closeCount, 1);
});

test('page-scoped tile clear retains neighboring pages', async () => {
  globalThis.createImageBitmap = async (imageData) => ({
    width: imageData.width,
    height: imageData.height,
    close() {},
  });
  configureRenderResourceBudget({
    globalBytes: 1_000_000,
    javascriptBytes: 1_000_000,
    nativePixmapBytes: 1_000_000,
    metadataBytes: 1_000_000,
    activeDocumentShare: 0.8,
  }, 'tile-owner');
  registerTileCacheOwner('/scoped-tiles.pdf', 'tile-owner');
  for (const pageNum of [249, 250, 251]) {
    await tileCacheSet('/scoped-tiles.pdf', pageNum, 2, 0, '0,0',
      { width: 10, height: 10 }, { renderScale: 2 });
  }
  tileCacheClearPages('/scoped-tiles.pdf', [250]);
  assert.ok(tileCacheGet('/scoped-tiles.pdf', 249, 2, 0, '0,0'));
  assert.equal(tileCacheGet('/scoped-tiles.pdf', 250, 2, 0, '0,0'), null);
  assert.ok(tileCacheGet('/scoped-tiles.pdf', 251, 2, 0, '0,0'));
});
