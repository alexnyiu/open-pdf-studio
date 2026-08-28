import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIB,
  calculateRenderResourceBudget,
  createPdfPerformanceProfile,
  recordForegroundRenderSample,
  shouldFullyPrewarmAdaptiveDocument,
} from './render-performance.js';

test('render resource budget is four percent of RAM with deterministic clamps and partitions', () => {
  const low = calculateRenderResourceBudget(2 * 1024 * MIB);
  assert.equal(low.globalBytes, 192 * MIB);
  const normal = calculateRenderResourceBudget(8 * 1024 * MIB);
  assert.equal(normal.globalBytes, Math.round(8 * 1024 * MIB * 0.04));
  const high = calculateRenderResourceBudget(64 * 1024 * MIB);
  assert.equal(high.globalBytes, 512 * MIB);
  assert.equal(high.javascriptBytes + high.nativePixmapBytes + high.metadataBytes, high.globalBytes);
});

test('large-document classification is sticky across static and measured thresholds', () => {
  const pages = createPdfPerformanceProfile({ pageCount: 50, fileBytes: 1 });
  assert.equal(pages.largeDocument, true);
  assert.deepEqual(pages.largeDocumentReasons, ['page-count']);

  const measured = createPdfPerformanceProfile({ pageCount: 2, fileBytes: 1 });
  recordForegroundRenderSample(measured, { elapsedMs: 151 });
  assert.equal(measured.largeDocument, false);
  recordForegroundRenderSample(measured, { elapsedMs: 180 });
  assert.equal(measured.largeDocument, true);
  assert.ok(measured.largeDocumentReasons.includes('foreground-render-time'));
});

test('adaptive full prewarm is limited to small documents with bounded retained work', () => {
  const small = createPdfPerformanceProfile({
    pageCount: 12,
    fileBytes: 4 * MIB,
    pageDimensions: [{ widthPt: 612, heightPt: 792 }],
  });
  assert.equal(shouldFullyPrewarmAdaptiveDocument(small), true);
  assert.equal(shouldFullyPrewarmAdaptiveDocument(createPdfPerformanceProfile({ pageCount: 108 })), false);
});
