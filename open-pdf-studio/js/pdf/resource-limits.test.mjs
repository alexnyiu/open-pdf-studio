import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PDF_DOCUMENT_PAGES,
  assertPdfDocumentResourceLimits,
} from './resource-limits.js';

test('PDF page-count preflight accepts the boundary and rejects one page beyond it', () => {
  const boundary = { numPages: MAX_PDF_DOCUMENT_PAGES };
  assert.equal(assertPdfDocumentResourceLimits(boundary), boundary);
  assert.throws(
    () => assertPdfDocumentResourceLimits({ numPages: MAX_PDF_DOCUMENT_PAGES + 1 }),
    (error) => error?.code === 'PDF_PAGE_COUNT_LIMIT'
      && error.pageCount === 100_001
      && error.maximumPages === 100_000,
  );
});

test('PDF page-count preflight rejects missing, empty, and unsafe counts', () => {
  for (const numPages of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertPdfDocumentResourceLimits({ numPages }),
      (error) => error?.code === 'PDF_PAGE_COUNT_INVALID'
        || error?.code === 'PDF_PAGE_COUNT_LIMIT',
    );
  }
});
