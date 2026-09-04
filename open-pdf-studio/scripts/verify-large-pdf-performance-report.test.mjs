import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateLargePdfPerformanceReport } from './verify-large-pdf-performance-report.mjs';

function passingReport() {
  return {
    contract: 'open-pdf-studio.large-pdf-performance',
    schemaVersion: 2,
    head: 'abc',
    packagedApp: { executablePath: '/tmp/Open PDF Studio' },
    fixture: {
      controlled: true,
      file: 'image-heavy-100.pdf',
      pageCount: 100,
      manifestSchemaVersion: 2,
      sha256: 'a'.repeat(64),
    },
    provenance: { execution: 'packaged-production-ui', realClock: true, stateSeeding: false },
    metrics: {
      largeDocument: true,
      scrollHandlerP95Ms: 3,
      ordinaryMainThreadTaskMaxMs: 40,
      cachedPreviewPaints: 1,
      cachedPreviewP95Ms: 80,
      visiblePagePreviewPublishes: 3,
      visiblePagePreviewP95Ms: 150,
      interactiveRasterPublishes: 3,
      interactiveRasterP95Ms: 150,
      rasterTransferP95Ms: 150,
      scrollFramesBelow20MsPercent: 95,
      visibleBlankWithSourceSamples: 1,
      visibleBlankWithSourceMaxMs: 100,
      fullQualityLatencyMaxMs: 400,
      fullQualityLatencyP95Ms: 500,
      visibleColdRenderSuppressedCount: 0,
      previewUsefulCancellationCount: 0,
      retiredNativeWorkPeak: 2,
      retiredNativeStalePublicationCount: 0,
      pageRenderFailureBlockedLaterPagesCount: 0,
      smallScrollPagesChecked: 3,
      smallScrollLaterPagesChecked: 2,
      smallScrollContinuityFailures: 0,
      smallScrollMaxPixelDifferencePercent: 0.1,
      mountedPageSurfacesPeak: 9,
      mountedThumbnailsPeak: 32,
      zoomInputToTransformP95Ms: 15,
      zoomFramesBelow20MsPercent: 95,
      zoomAnchorDriftMaxPx: 0.5,
      zoomStopsAfterGesture: true,
      crispRenderRevisions: 1,
      maximumSettledDensityError: 0.01,
      undersampledSettledSurfaces: 0,
      previewSurfacesAfter500Ms: 0,
      duplicateFinalPublications: 0,
      pixelDifferencePercent: 0.1,
      javascriptResourcePeakBytes: 100,
      javascriptResourceBudgetBytes: 100,
      nativePixmapPeakBytes: 100,
      nativePixmapBudgetBytes: 100,
      settledRssBytes: 100,
      rssCeilingBytes: 100,
      secondTraversalGrowthBytes: 32 * 1024 * 1024,
      freshPackagedProcessRuns: 2,
    },
  };
}

test('large-PDF performance evaluator passes exact boundary evidence', () => {
  const result = evaluateLargePdfPerformanceReport(passingReport());
  assert.equal(result.status, 'PASS');
  assert.equal(result.decision, 'LARGE PDF PERFORMANCE GO');
});

test('large-PDF performance evaluator fails an excess mount count', () => {
  const report = passingReport();
  report.metrics.mountedPageSurfacesPeak = 10;
  const result = evaluateLargePdfPerformanceReport(report);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.failures.includes('mountedPageSurfaces'));
});

test('large-PDF performance evaluator fails a slow first visible preview', () => {
  const report = passingReport();
  report.metrics.visiblePagePreviewP95Ms = 151;
  const result = evaluateLargePdfPerformanceReport(report);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.failures.includes('strictlyVisibleFirstPreview'));
});

test('large-PDF performance evaluator rejects a small-scroll raster discontinuity', () => {
  const report = passingReport();
  report.metrics.smallScrollContinuityFailures = 1;
  const result = evaluateLargePdfPerformanceReport(report);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.failures.includes('smallScrollSurfaceContinuity'));
});

test('large-PDF performance evaluator rejects the retired uploaded 108-page identity', () => {
  const report = passingReport();
  report.fixture = { pageCount: 108, sha256: 'a'.repeat(64) };
  const result = evaluateLargePdfPerformanceReport(report);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.failures.includes('fixtureIdentity'));
});
