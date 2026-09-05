import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureTextCacheRevision, textCacheRevisionIsCurrent,
  pageTextSignature, textCacheSnapshot, SEARCH_TEXT_CACHE_BYTE_LIMIT,
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

test('late extraction is rejected even when an unchanged page remains cache-compatible', () => {
  const doc = documentOwner();
  const oldProxy = doc.pdfDoc;
  const request = captureTextCacheRevision(doc, oldProxy, 1);
  doc.lifecycleGeneration++;
  doc.pdfDoc = { id: 'replacement' };
  assert.equal(textCacheRevisionIsCurrent(request, doc, oldProxy), false);
  writePageTextCache(doc, oldProxy, 1, { text: 'late result' });
  assert.equal(readPageTextCache(doc, doc.pdfDoc, 1), null);
});

test('cache pressure evicts least recently used disposable pages and releases owner accounting', () => {
  const doc = documentOwner();
  const text = 'x'.repeat(4 * 1024 * 1024);
  for (const page of [1, 2, 3]) writePageTextCache(doc, doc.pdfDoc, page, { text });
  assert.ok(readPageTextCache(doc, doc.pdfDoc, 1));
  writePageTextCache(doc, doc.pdfDoc, 4, { text });
  assert.equal(readPageTextCache(doc, doc.pdfDoc, 2), null);
  assert.ok(readPageTextCache(doc, doc.pdfDoc, 1));
  assert.ok(readPageTextCache(doc, doc.pdfDoc, 3));
  assert.ok(readPageTextCache(doc, doc.pdfDoc, 4));
  const inventory = textCacheSnapshot().find((entry) => entry.documentId === doc.id);
  assert.ok(inventory.estimatedBytes <= SEARCH_TEXT_CACHE_BYTE_LIMIT);
  invalidateTextCache(doc.id);
  assert.equal(textCacheSnapshot().find((entry) => entry.documentId === doc.id), undefined);
});

test('oversized pages remain available to their request without polluting the cache', () => {
  const doc = documentOwner();
  const normal = { text: 'small page' };
  writePageTextCache(doc, doc.pdfDoc, 1, normal);
  const huge = { text: 'x'.repeat(SEARCH_TEXT_CACHE_BYTE_LIMIT / 2) };
  assert.equal(writePageTextCache(doc, doc.pdfDoc, 2, huge), huge);
  assert.equal(readPageTextCache(doc, doc.pdfDoc, 2), null);
  assert.equal(readPageTextCache(doc, doc.pdfDoc, 1), normal);
});

test('committed page moves and same-length edits invalidate indexed signatures', () => {
  const doc = documentOwner();
  const edit = { id: 'edit', page: 1, originalText: '', newText: 'first', pdfX: 1, pdfY: 20, pdfWidth: 100, fontSize: 12 };
  doc.textEdits = [edit];
  const first = pageTextSignature(doc, 1);
  edit.newText = 'other';
  doc.revisionState.contentRevision++;
  assert.notEqual(pageTextSignature(doc, 1), first);
  edit.page = 2;
  doc.revisionState.contentRevision++;
  assert.equal(pageTextSignature(doc, 1).includes('other'), false);
  assert.equal(pageTextSignature(doc, 2).includes('other'), true);
});
