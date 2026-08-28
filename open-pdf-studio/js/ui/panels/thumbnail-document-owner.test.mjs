import assert from 'node:assert/strict';
import test from 'node:test';

import { updateThumbnailDocumentOwner } from './thumbnail-document-owner.js';

test('thumbnail state replaces its stored PDF proxy after save and restarts visible-first traversal', () => {
  const documentState = { id: 'thumbnail-document' };
  const oldProxy = { numPages: 3 };
  const newProxy = { numPages: 4 };
  const updated = updateThumbnailDocumentOwner({
    pdfDoc: oldProxy,
    doc: documentState,
    numPages: 3,
    nextPage: 3,
    startPage: 2,
    wrapped: true,
  }, documentState, newProxy);
  assert.equal(updated.pdfDoc, newProxy);
  assert.equal(updated.doc, documentState);
  assert.equal(updated.numPages, 4);
  assert.equal(updated.nextPage, 1);
  assert.equal(updated.startPage, 1);
  assert.equal(updated.wrapped, false);
});
