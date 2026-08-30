import assert from 'node:assert/strict';
import test from 'node:test';

import { publishPendingOcrReadiness } from './pending-ocr-readiness-publication.js';

const completeLayers = new Set(['raster', 'annotations', 'text', 'links', 'forms']);

function owner() {
  return {
    id: 'pending-ocr-document',
    lifecycleGeneration: 2,
    pdfDoc: {},
    revisionState: {
      contentRevision: 3,
      livePdfRevision: 2,
      pageContentRevisions: { 1: 3 },
      saveState: 'modified',
    },
  };
}

function publicationToken(documentState) {
  return {
    documentId: documentState.id,
    lifecycleGeneration: documentState.lifecycleGeneration,
    contentRevision: 3,
    livePdfRevision: 2,
    pageRevision: 3,
    publishedPageRevision: 2,
    pageNum: 1,
  };
}

test('pending OCR publishes the complete installed proxy surface at the model revision', async () => {
  const documentState = owner();
  let input = null;
  const outcome = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: completeLayers,
    pendingItemsForPage: () => [{ text: 'searchable text' }],
    tokenIsCurrent: () => true,
    publishModelRevision: async (value) => {
      input = value;
      return { status: 'published', pageRevision: 3 };
    },
  });

  assert.equal(outcome.status, 'published');
  assert.equal(outcome.terminalFailure, false);
  assert.equal(input.expectedPageRevision, 3);
  assert.equal(input.publicationSource, 'pending-ocr-page');
  assert.equal(input.expectedVisible, true);
});

test('pending OCR waits until every renderer-owned layer has actually published', async () => {
  const documentState = owner();
  let publications = 0;
  const outcome = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: new Set(['annotations', 'text', 'links', 'forms']),
    pendingItemsForPage: () => [{ text: 'searchable text' }],
    tokenIsCurrent: () => true,
    publishModelRevision: async () => { publications += 1; },
  });

  assert.equal(outcome.status, 'incomplete');
  assert.equal(publications, 0);
});

test('ordinary persistence debt is never promoted without pending OCR ownership', async () => {
  const documentState = owner();
  let publications = 0;
  const outcome = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: completeLayers,
    pendingItemsForPage: () => [],
    tokenIsCurrent: () => true,
    publishModelRevision: async () => { publications += 1; },
  });

  assert.equal(outcome.status, 'not-required');
  assert.equal(publications, 0);
});

test('superseded pending OCR work unwinds without becoming a current terminal failure', async () => {
  const documentState = owner();
  const outcome = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: completeLayers,
    pendingItemsForPage: () => [{ text: 'searchable text' }],
    tokenIsCurrent: () => true,
    publishModelRevision: async () => ({ status: 'superseded' }),
  });

  assert.equal(outcome.status, 'superseded');
  assert.equal(outcome.terminalFailure, false);
});

test('only a failed current pending OCR publication is terminal', async () => {
  const documentState = owner();
  const currentFailure = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: completeLayers,
    pendingItemsForPage: () => [{ text: 'searchable text' }],
    tokenIsCurrent: () => true,
    publishModelRevision: async () => ({ status: 'failed', error: 'surface missing' }),
  });
  assert.equal(currentFailure.status, 'failed');
  assert.equal(currentFailure.terminalFailure, true);

  let current = true;
  const supersededFailure = await publishPendingOcrReadiness({
    documentState,
    pageNum: 1,
    publicationToken: publicationToken(documentState),
    completedLayers: completeLayers,
    pendingItemsForPage: () => [{ text: 'searchable text' }],
    tokenIsCurrent: () => current,
    publishModelRevision: async () => {
      current = false;
      throw new Error('late failure');
    },
  });
  assert.equal(supersededFailure.status, 'superseded');
  assert.equal(supersededFailure.terminalFailure, false);
});

