import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_OCR_CORRECTION_CODE_UNITS,
  acceptOcrLineCorrection,
  applyOcrPageResult,
  beginOcrPageAttempt,
  createDocumentOcrState,
  getOwnedOcrTextItems,
  getPendingOcrTextItems,
  validateOcrCorrectionText,
} from './document-state.js';
import {
  getLowConfidenceOcrReviewItems,
  getNextOcrReviewItem,
  getOcrReviewPage,
  getOcrReviewWarningItems,
  getOwnedOcrReviewPageNumbers,
} from './review-model.js';
import {
  fakePdfDocument,
  makeOcrFixture,
} from './searchable-layer.test-fixtures.mjs';

function makeDocument(id, pageCount = 1) {
  return {
    id,
    filePath: `/test/${id}.pdf`,
    fileName: `${id}.pdf`,
    pdfDoc: fakePdfDocument(Array.from({ length: pageCount }, () => [])),
    currentPage: 1,
    viewMode: 'continuous',
    textEdits: [],
    pageRotations: {},
    undoStack: [],
    redoStack: [],
    savedUndoStackLength: 0,
    modified: false,
    ocr: createDocumentOcrState(id),
  };
}

async function applyReviewFixture(document, pageNumber, lines, options = {}) {
  const attempt = await beginOcrPageAttempt(document, pageNumber);
  assert.equal(attempt.skipped, false);
  const fixture = makeOcrFixture({
    documentId: document.id,
    documentGeneration: attempt.token.documentGeneration,
    pageId: attempt.token.pageId,
    pageRevision: attempt.token.pageRevision,
    pageIndex: pageNumber - 1,
    pageCount: document.pdfDoc.numPages,
    lines,
  });
  const result = structuredClone(fixture.result);
  result.page.status = options.status ?? 'completed';
  result.warnings = structuredClone(options.warnings ?? []);
  result.unsupportedContentReasons = structuredClone(options.unsupportedContentReasons ?? []);
  if (options.alternatives) {
    result.engine.engineId = 'review-test-engine';
    result.engine.capabilities.alternatives = true;
    result.lines[0].alternatives = structuredClone(options.alternatives);
  }
  const update = applyOcrPageResult(document, {
    result,
    pageGeometry: fixture.pageGeometry,
    token: attempt.token,
  });
  assert.deepEqual(update, { applied: true, reason: null });
  return document.ocr.pages[pageNumber];
}

test('review projection preserves engine order, effective corrections, confidence, and capability-gated alternatives', async () => {
  const document = makeDocument('review-projection', 2);
  const firstPage = await applyReviewFixture(document, 1, [
    { id: 'line-high', text: 'Engine first', confidence: 0.97, x: 20, y: 30, width: 120, height: 14 },
    { id: 'line-low', text: 'Engine second', confidence: 0.54, x: 20, y: 55, width: 130, height: 14 },
  ], {
    warnings: [{
      code: 'review-low-confidence',
      message: 'Review the second line.',
      severity: 'warning',
      entityIds: ['line-low'],
    }],
  });
  const immutableResult = firstPage.recognition.result;
  acceptOcrLineCorrection(document, 1, 'line-low', 'Accepted second line');

  const review = getOcrReviewPage(document, 1);
  assert.deepEqual(review.lines.map((line) => line.id), ['line-high', 'line-low']);
  assert.deepEqual(review.lines.map((line) => line.effectiveText), ['Engine first', 'Accepted second line']);
  assert.equal(review.lines[1].lowConfidence, true);
  assert.equal(review.lines[1].confidencePercent, 54);
  assert.equal(review.lines[1].confidenceLabel, 'Low confidence');
  assert.equal(review.lines[0].alternatives, null);
  assert.equal(review.warnings[0].lineId, 'line-low');
  assert.equal(immutableResult.lines[1].text, 'Engine second');
  assert.equal(Object.isFrozen(immutableResult), true);

  await applyReviewFixture(document, 2, [
    { id: 'line-alternative', text: 'Main reading', confidence: 0.84, x: 20, y: 30, width: 120, height: 14 },
  ], {
    alternatives: [{ text: 'Alternate reading', confidence: 0.72 }],
  });
  const alternativeReview = getOcrReviewPage(document, 2);
  assert.equal(alternativeReview.alternativesCapable, true);
  assert.deepEqual(alternativeReview.lines[0].alternatives, [
    { text: 'Alternate reading', confidence: 0.72 },
  ]);
});

test('correction acceptance rejects invalid Unicode, controls, and oversized text before state changes', async () => {
  const document = makeDocument('review-validation');
  const page = await applyReviewFixture(document, 1, [
    { id: 'line-1', text: 'Original', confidence: 0.9, x: 20, y: 30, width: 100, height: 14 },
  ]);
  const revision = page.review.revision;
  const invalidValues = [
    'line\nseparator',
    `nul\u0000control`,
    `unpaired-${String.fromCharCode(0xd800)}`,
    'x'.repeat(MAX_OCR_CORRECTION_CODE_UNITS + 1),
  ];
  for (const value of invalidValues) {
    assert.equal(validateOcrCorrectionText(value).ok, false);
    assert.throws(
      () => acceptOcrLineCorrection(document, 1, 'line-1', value),
      (error) => error.code === 'OCR_CORRECTION_INVALID',
    );
  }
  assert.equal(page.review.revision, revision);
  assert.deepEqual(page.review.corrections, {});

  const valid = 'Straße café 👩‍💻 مرحبا';
  assert.deepEqual(validateOcrCorrectionText(valid), { ok: true, issues: [] });
  acceptOcrLineCorrection(document, 1, 'line-1', valid);
  assert.equal(page.review.corrections['line-1'].correctedText, valid);
});

test('unsupported results remain reviewable but never enter search or PDF-writer projections', async () => {
  const document = makeDocument('review-unsupported');
  await applyReviewFixture(document, 1, [
    { id: 'unsupported-line', text: 'Unsafe table reading', confidence: 0.31, x: 20, y: 30, width: 140, height: 14 },
  ], {
    status: 'unsupported',
    unsupportedContentReasons: [{
      id: 'unsupported-table-1',
      code: 'table',
      message: 'Table reading order is unsupported.',
      polygon: {
        coordinateSpace: 'source-raster-pixels',
        points: [[10, 10], [200, 10], [200, 100], [10, 100]],
      },
    }],
  });

  const review = getOcrReviewPage(document, 1);
  assert.equal(review.hasResult, true);
  assert.equal(review.resultStatus, 'unsupported');
  assert.equal(review.lines[0].effectiveText, 'Unsafe table reading');
  assert.equal(review.unsupportedReasons[0].code, 'table');
  assert.equal(review.searchableEligible, false);
  assert.deepEqual(getPendingOcrTextItems(document, 1), []);
  assert.deepEqual(getOwnedOcrTextItems(document, 1), []);
});

test('review navigation cycles warnings and low-confidence lines across pages and reports ownership state', async () => {
  const document = makeDocument('review-navigation', 3);
  await applyReviewFixture(document, 1, [
    { id: 'page-1-low', text: 'First low', confidence: 0.5, x: 20, y: 30, width: 100, height: 14 },
  ], {
    warnings: [{
      code: 'warning-one', message: 'First warning.', severity: 'warning', entityIds: ['page-1-low'],
    }],
  });
  const savedPage = await applyReviewFixture(document, 2, [
    { id: 'page-2-high', text: 'Saved line', confidence: 0.98, x: 20, y: 30, width: 100, height: 14 },
  ]);
  savedPage.recognition.ownership = {
    ...savedPage.recognition.ownership,
    stream: 'pdf-owned-invisible-text',
    persisted: true,
  };
  savedPage.review.dirty = false;
  await applyReviewFixture(document, 3, [
    { id: 'page-3-low', text: 'Second low', confidence: 0.65, x: 20, y: 30, width: 100, height: 14 },
  ], {
    status: 'unsupported',
    unsupportedContentReasons: [{
      id: 'unsupported-complex-1', code: 'complex-layout', message: 'Complex reading order.',
    }],
  });

  assert.equal(getOcrReviewPage(document, 1).ownershipState, 'pending');
  assert.equal(getOcrReviewPage(document, 2).ownershipState, 'saved');
  acceptOcrLineCorrection(document, 2, 'page-2-high', 'Saved line corrected');
  assert.equal(getOcrReviewPage(document, 2).ownershipState, 'saved-with-pending-changes');
  assert.deepEqual(getOwnedOcrReviewPageNumbers(document), [1, 2, 3]);

  const lowItems = getLowConfidenceOcrReviewItems(document);
  assert.deepEqual(lowItems.map((item) => [item.pageNumber, item.lineId]), [
    [1, 'page-1-low'],
    [3, 'page-3-low'],
  ]);
  assert.equal(getNextOcrReviewItem(lowItems, null).key, lowItems[0].key);
  assert.equal(getNextOcrReviewItem(lowItems, lowItems[0].key).key, lowItems[1].key);
  assert.equal(getNextOcrReviewItem(lowItems, lowItems[1].key).key, lowItems[0].key);

  const warnings = getOcrReviewWarningItems(document);
  assert.deepEqual(warnings.map((item) => [item.pageNumber, item.kind]), [
    [1, 'warning'],
    [3, 'unsupported'],
  ]);
});
