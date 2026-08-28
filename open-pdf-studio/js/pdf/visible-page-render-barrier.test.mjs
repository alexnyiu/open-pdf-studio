import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitRequiredPageRenders } from './visible-page-render-barrier.js';
import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import { captureRenderPublicationToken } from './render-publication-token.js';
import {
  PAGE_EDIT_READY_LAYERS,
  markPageEditLayerReady,
  pageEditReadinessSatisfied,
} from './page-edit-readiness.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('visible-page synchronization does not resolve while one required child render is deferred', async () => {
  const secondPage = deferred();
  let settled = false;
  const barrier = awaitRequiredPageRenders([1, 2], async (pageNum) => {
    if (pageNum === 2) await secondPage.promise;
    return { status: 'complete', value: { ready: true } };
  }).then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  secondPage.resolve();
  const result = await barrier;
  assert.equal(result.ready, true);
  assert.deepEqual(result.completedPages, [1, 2]);
});

test('cancelled or semantically incomplete child render fails the required-page barrier', async () => {
  const result = await awaitRequiredPageRenders([1, 2], async (pageNum) => (
    pageNum === 1
      ? { status: 'complete', value: { ready: true } }
      : { status: 'cancelled', reason: 'stale' }
  ));
  assert.equal(result.ready, false);
  assert.deepEqual(result.completedPages, [1]);
});

test('all required pages settle only after current raster and semantic layers publish', async () => {
  const revisionState = createInitialDocumentRevisionState();
  Object.assign(revisionState, {
    contentRevision: 2,
    serializedRevision: 2,
    persistedRevision: 2,
    livePdfRevision: 2,
  });
  revisionState.pageContentRevisions = { 1: 2, 2: 2 };
  const documentState = {
    id: 'visible-layer-owner',
    lifecycleGeneration: 5,
    pdfDoc: {},
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
  };
  const result = await awaitRequiredPageRenders([1, 2], async (pageNum) => {
    const token = captureRenderPublicationToken(documentState, pageNum, 'visible-layer-test');
    for (const layer of PAGE_EDIT_READY_LAYERS) {
      markPageEditLayerReady(documentState, pageNum, layer, token);
    }
    return {
      status: 'complete',
      value: { ready: pageEditReadinessSatisfied(documentState, pageNum) },
    };
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.completedPages, [1, 2]);
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true);
  assert.equal(pageEditReadinessSatisfied(documentState, 2), true);
});
