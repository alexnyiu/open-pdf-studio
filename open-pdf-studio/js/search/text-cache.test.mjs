import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentSearchTextRevisionAvailable,
  invalidateTextCache,
  readPageTextCache,
  writePageTextCache,
} from './text-cache.js';

function documentOwner() {
  const pdfDoc = { id: 'proxy-one' };
  return {
    id: 'search-cache-owner',
    lifecycleGeneration: 1,
    pdfDoc,
    revisionState: {
      contentRevision: 1,
      persistedRevision: 1,
      livePdfRevision: 1,
      saveState: 'saved',
      pageContentRevisions: { 1: 1 },
    },
    pageRenderRevisions: { 1: 1 },
    textEdits: [],
  };
}

test.afterEach(() => invalidateTextCache('search-cache-owner'));

test('search text cache reuses only an identity-compatible revision', () => {
  const documentState = documentOwner();
  const oldValue = { text: 'old revision' };
  writePageTextCache(documentState, documentState.pdfDoc, 1, oldValue);
  assert.equal(readPageTextCache(documentState, documentState.pdfDoc, 1), oldValue);

  const oldPdfDocument = documentState.pdfDoc;
  documentState.pdfDoc = { id: 'proxy-two' };
  documentState.lifecycleGeneration = 2;
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.persistedRevision = 2;
  documentState.revisionState.livePdfRevision = 2;
  documentState.revisionState.pageContentRevisions[1] = 2;
  documentState.pageRenderRevisions[1] = 2;
  assert.equal(readPageTextCache(documentState, oldPdfDocument, 1), null);
  assert.equal(readPageTextCache(documentState, documentState.pdfDoc, 1), null);

  const newValue = { text: 'new revision' };
  writePageTextCache(documentState, documentState.pdfDoc, 1, newValue);
  assert.equal(readPageTextCache(documentState, documentState.pdfDoc, 1), newValue);
});

test('proxy adoption preserves search text for an unchanged page only', () => {
  const documentState = documentOwner();
  documentState.revisionState.pageContentRevisions[2] = 1;
  documentState.pageRenderRevisions[2] = 1;
  const first = { text: 'warm first page' };
  const second = { text: 'changed second page' };
  writePageTextCache(documentState, documentState.pdfDoc, 1, first);
  writePageTextCache(documentState, documentState.pdfDoc, 2, second);
  documentState.pdfDoc = { id: 'proxy-two' };
  documentState.lifecycleGeneration = 2;
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.persistedRevision = 2;
  documentState.revisionState.livePdfRevision = 2;
  documentState.revisionState.pageContentRevisions[2] = 2;
  documentState.pageRenderRevisions[2] = 2;
  assert.equal(readPageTextCache(documentState, documentState.pdfDoc, 1), first);
  assert.equal(readPageTextCache(documentState, documentState.pdfDoc, 2), null);
});

test('search extraction is unavailable while persisted bytes are newer than the live proxy', () => {
  const documentState = documentOwner();
  documentState.revisionState.persistedRevision = 2;
  documentState.revisionState.saveState = 'persisted';
  assert.equal(documentSearchTextRevisionAvailable(documentState), false);
  documentState.revisionState.livePdfRevision = 2;
  documentState.revisionState.saveState = 'saved';
  assert.equal(documentSearchTextRevisionAvailable(documentState), true);
  documentState.revisionState.saveState = 'saved-refresh-failed';
  assert.equal(documentSearchTextRevisionAvailable(documentState), false);
});
