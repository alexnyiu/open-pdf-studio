import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArguments(argv) {
  const options = { inputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') options.inputPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.inputPath) throw new Error('--input is required');
  return options;
}

const finite = (value) => Number.isFinite(Number(value));

export function evaluateLargePdfPerformanceReport(report) {
  const metrics = report?.metrics || {};
  const threshold = (name, passes, measured, requirement) => ({
    name,
    status: passes ? 'PASS' : 'FAIL',
    measured: measured ?? null,
    requirement,
  });
  const criteria = [
    threshold('fixtureIdentity', report?.fixture?.controlled === true
      && report?.fixture?.file === 'image-heavy-100.pdf'
      && report?.fixture?.pageCount === 100
      && report?.fixture?.manifestSchemaVersion === 2
      && /^[0-9a-f]{64}$/u.test(report?.fixture?.sha256 || ''), report?.fixture,
    'controlled manifest-verified 100-page image-heavy PDF with SHA-256'),
    threshold('largeDocumentClassification', metrics.largeDocument === true, metrics.largeDocument, 'true'),
    threshold('scrollHandlerP95Ms', finite(metrics.scrollHandlerP95Ms) && metrics.scrollHandlerP95Ms < 4,
      metrics.scrollHandlerP95Ms, '< 4 ms'),
    threshold('ordinaryMainThreadTaskMaxMs', finite(metrics.ordinaryMainThreadTaskMaxMs)
      && metrics.ordinaryMainThreadTaskMaxMs < 50, metrics.ordinaryMainThreadTaskMaxMs, '< 50 ms'),
    threshold('cachedPreviewP95Ms', metrics.cachedPreviewPaints === 0
      || (finite(metrics.cachedPreviewP95Ms) && metrics.cachedPreviewP95Ms <= 100),
    metrics.cachedPreviewPaints === 0 ? 'not applicable; no cached preview encountered' : metrics.cachedPreviewP95Ms,
    '<= 100 ms when a cached preview exists'),
    threshold('strictlyVisibleFirstPreview', metrics.visiblePagePreviewPublishes > 0
      && finite(metrics.visiblePagePreviewP95Ms) && metrics.visiblePagePreviewP95Ms <= 150,
    {
      publishes: metrics.visiblePagePreviewPublishes,
      p95Ms: metrics.visiblePagePreviewP95Ms,
    }, 'at least one visible preview and p95 <= 150 ms'),
    threshold('interactiveRasterLatency', metrics.interactiveRasterPublishes > 0
      && finite(metrics.interactiveRasterP95Ms) && metrics.interactiveRasterP95Ms <= 150,
    {
      publishes: metrics.interactiveRasterPublishes,
      p95Ms: metrics.interactiveRasterP95Ms,
    }, 'at least one readable CSS-resolution raster and p95 <= 150 ms'),
    threshold('rasterTransferP95Ms', finite(metrics.rasterTransferP95Ms)
      && metrics.rasterTransferP95Ms <= 150,
    metrics.rasterTransferP95Ms, '<= 150 ms end-to-end raster transport and decode'),
    threshold('scrollFramesBelow20MsPercent', finite(metrics.scrollFramesBelow20MsPercent)
      && metrics.scrollFramesBelow20MsPercent >= 95,
    metrics.scrollFramesBelow20MsPercent, '>= 95%'),
    threshold('blankShellWithAvailablePreview', metrics.visibleBlankWithSourceSamples === 0
      || (finite(metrics.visibleBlankWithSourceMaxMs) && metrics.visibleBlankWithSourceMaxMs <= 100),
    metrics.visibleBlankWithSourceSamples === 0
      ? 'not applicable; no wrapper mounted with a cached source'
      : { samples: metrics.visibleBlankWithSourceSamples, maxMs: metrics.visibleBlankWithSourceMaxMs },
    '<= 100 ms when a preview source is available at mount'),
    threshold('fullQualityLatencyMaxMs', finite(metrics.fullQualityLatencyMaxMs)
      && metrics.fullQualityLatencyMaxMs <= 500, metrics.fullQualityLatencyMaxMs, '<= 500 ms after settling'),
    threshold('fullQualityLatencyP95Ms', finite(metrics.fullQualityLatencyP95Ms)
      && metrics.fullQualityLatencyP95Ms <= 500, metrics.fullQualityLatencyP95Ms, '<= 500 ms after settling'),
    threshold('visibleColdPageActivityAdmission', metrics.visibleColdRenderSuppressedCount === 0,
      metrics.visibleColdRenderSuppressedCount, 'zero strictly visible cold pages skipped for foreground activity'),
    threshold('usefulPreviewCancellation', metrics.previewUsefulCancellationCount === 0,
      metrics.previewUsefulCancellationCount, 'zero useful visible preview cancellations'),
    threshold('retiredNativeWorkCap', finite(metrics.retiredNativeWorkPeak)
      && metrics.retiredNativeWorkPeak <= 2, metrics.retiredNativeWorkPeak, '<= 2 per document'),
    threshold('retiredNativeStalePublication', metrics.retiredNativeStalePublicationCount === 0,
      metrics.retiredNativeStalePublicationCount, 'zero stale pixel publications'),
    threshold('pageFailureBlocksLaterPages', metrics.pageRenderFailureBlockedLaterPagesCount === 0,
      metrics.pageRenderFailureBlockedLaterPagesCount, 'zero later pages blocked by a page-local failure'),
    threshold('smallScrollSurfaceContinuity', metrics.smallScrollPagesChecked >= 3
      && metrics.smallScrollLaterPagesChecked >= 2
      && metrics.smallScrollContinuityFailures === 0
      && finite(metrics.smallScrollMaxPixelDifferencePercent)
      && metrics.smallScrollMaxPixelDifferencePercent <= 0.1,
    {
      pagesChecked: metrics.smallScrollPagesChecked,
      laterPagesChecked: metrics.smallScrollLaterPagesChecked,
      failures: metrics.smallScrollContinuityFailures,
      maxPixelDifferencePercent: metrics.smallScrollMaxPixelDifferencePercent,
    }, 'page 1 plus at least two later pages retain one final raster with <= 0.1% pixel difference'),
    threshold('mountedPageSurfaces', finite(metrics.mountedPageSurfacesPeak)
      && metrics.mountedPageSurfacesPeak <= 9, metrics.mountedPageSurfacesPeak, '<= 9'),
    threshold('mountedThumbnails', finite(metrics.mountedThumbnailsPeak)
      && metrics.mountedThumbnailsPeak <= 32, metrics.mountedThumbnailsPeak, '<= 32'),
    threshold('zoomInputToTransformP95Ms', finite(metrics.zoomInputToTransformP95Ms)
      && metrics.zoomInputToTransformP95Ms <= 16, metrics.zoomInputToTransformP95Ms, '<= 16 ms'),
    threshold('zoomFramesBelow20MsPercent', finite(metrics.zoomFramesBelow20MsPercent)
      && metrics.zoomFramesBelow20MsPercent >= 95, metrics.zoomFramesBelow20MsPercent, '>= 95%'),
    threshold('zoomAnchorDriftMaxPx', finite(metrics.zoomAnchorDriftMaxPx)
      && metrics.zoomAnchorDriftMaxPx <= 0.5, metrics.zoomAnchorDriftMaxPx, '<= 0.5 CSS px'),
    threshold('zoomStopsAfterGesture', metrics.zoomStopsAfterGesture === true,
      metrics.zoomStopsAfterGesture, 'true'),
    threshold('crispRenderRevisions', metrics.crispRenderRevisions === 1,
      metrics.crispRenderRevisions, 'exactly 1'),
    threshold('settledRasterDensity', finite(metrics.maximumSettledDensityError)
      && metrics.maximumSettledDensityError <= 0.01
      && metrics.undersampledSettledSurfaces === 0,
    {
      maximumError: metrics.maximumSettledDensityError,
      undersampledSurfaces: metrics.undersampledSettledSurfaces,
    }, 'density error <= 0.01 and zero undersampled settled surfaces'),
    threshold('settledPreviewSurfaces', metrics.previewSurfacesAfter500Ms === 0,
      metrics.previewSurfacesAfter500Ms, 'zero previews after 500 ms'),
    threshold('duplicateFinalPublications', metrics.duplicateFinalPublications === 0,
      metrics.duplicateFinalPublications, 'zero'),
    threshold('pdfiumPixelDifference', finite(metrics.pixelDifferencePercent)
      && metrics.pixelDifferencePercent <= 0.1,
    metrics.pixelDifferencePercent, '<= 0.1% of pixels differ by more than two channel levels'),
    threshold('javascriptRenderBudget', finite(metrics.javascriptResourcePeakBytes)
      && finite(metrics.javascriptResourceBudgetBytes)
      && metrics.javascriptResourcePeakBytes <= metrics.javascriptResourceBudgetBytes,
    { peak: metrics.javascriptResourcePeakBytes, budget: metrics.javascriptResourceBudgetBytes }, 'peak <= budget'),
    threshold('nativePixmapBudget', finite(metrics.nativePixmapPeakBytes)
      && finite(metrics.nativePixmapBudgetBytes)
      && metrics.nativePixmapPeakBytes <= metrics.nativePixmapBudgetBytes,
    { peak: metrics.nativePixmapPeakBytes, budget: metrics.nativePixmapBudgetBytes }, 'peak <= budget'),
    threshold('settledRss', finite(metrics.settledRssBytes) && finite(metrics.rssCeilingBytes)
      && metrics.settledRssBytes <= metrics.rssCeilingBytes,
    { settled: metrics.settledRssBytes, ceiling: metrics.rssCeilingBytes }, 'settled RSS <= baseline + budget + 128 MiB'),
    threshold('secondTraversalGrowth', finite(metrics.secondTraversalGrowthBytes)
      && metrics.secondTraversalGrowthBytes <= 32 * 1024 * 1024,
    metrics.secondTraversalGrowthBytes, '<= 32 MiB after the five-second settling period'),
    threshold('freshPackagedProcessRuns', metrics.freshPackagedProcessRuns === 2,
      metrics.freshPackagedProcessRuns, 'exactly two fresh packaged processes'),
  ];
  const evidenceIssues = [];
  if (report?.contract !== 'open-pdf-studio.large-pdf-performance') evidenceIssues.push('invalid contract');
  if (report?.schemaVersion !== 2) evidenceIssues.push('invalid schema version');
  if (report?.provenance?.execution !== 'packaged-production-ui'
      || report?.provenance?.realClock !== true
      || report?.provenance?.stateSeeding !== false) {
    evidenceIssues.push('performance evidence was not captured through the packaged production UI');
  }
  if (!report?.packagedApp?.executablePath || !report?.head) evidenceIssues.push('packaged app or HEAD identity is missing');
  const failures = criteria.filter((criterion) => criterion.status !== 'PASS').map(({ name }) => name);
  return {
    ...report,
    contract: 'open-pdf-studio.large-pdf-performance',
    schemaVersion: 2,
    status: failures.length === 0 && evidenceIssues.length === 0 ? 'PASS' : 'FAIL',
    decision: failures.length === 0 && evidenceIssues.length === 0
      ? 'LARGE PDF PERFORMANCE GO'
      : 'LARGE PDF PERFORMANCE NO-GO',
    criteria: Object.fromEntries(criteria.map(({ name, ...criterion }) => [name, criterion])),
    failures: [...failures, ...(evidenceIssues.length ? ['performanceEvidence'] : [])],
    evidenceIssues,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  access(options.inputPath)
    .then(() => readFile(options.inputPath, 'utf8'))
    .then((contents) => evaluateLargePdfPerformanceReport(JSON.parse(contents)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'PASS') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message || error}\n`);
      process.exitCode = 1;
    });
}
