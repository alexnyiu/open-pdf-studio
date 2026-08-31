import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTINUOUS_RENDER_LANES,
  continuousModelReadinessReconciliationRequired,
  continuousMountedRasterCanReuse,
  continuousMountedRenderCanReuse,
  continuousRenderedSurfaceRevisionUpdate,
  continuousScrollRenderRetentionPages,
  continuousRenderJobKey,
  planContinuousMountRetention,
  planContinuousRenderOverscan,
} from './continuous-render-lanes.js';

test('directional look-ahead keeps one page ahead and only a small trailing window', () => {
  const forward = planContinuousRenderOverscan({
    direction: 1,
    viewportHeight: 800,
    pageExtentPx: 900,
    scrollVelocityPxPerMs: 0,
  });
  assert.equal(forward.lookAheadPx, 900);
  assert.equal(forward.overscanAfterPx, 900);
  assert.equal(forward.overscanBeforePx, 200);

  const reverse = planContinuousRenderOverscan({
    direction: -1,
    viewportHeight: 800,
    pageExtentPx: 900,
    scrollVelocityPxPerMs: 4,
    recentPreviewLatencyMs: 300,
  });
  assert.equal(reverse.lookAheadPx, 1_200);
  assert.equal(reverse.overscanBeforePx, 1_200);
  assert.equal(reverse.overscanAfterPx, 200);
});

test('memory pressure removes overscan without changing strict visibility planning', () => {
  assert.deepEqual(planContinuousRenderOverscan({
    direction: 1,
    viewportHeight: 800,
    pageExtentPx: 900,
    budgetAllowsOverscan: false,
  }), {
    direction: 1,
    lookAheadPx: 0,
    trailingPx: 0,
    overscanBeforePx: 0,
    overscanAfterPx: 0,
  });
});

test('render work keys isolate page revision, scale, and quality lanes', () => {
  const preview = continuousRenderJobKey({
    documentId: 'doc-a', lifecycleGeneration: 2, pageNum: 5,
    pageRevision: 7, quality: CONTINUOUS_RENDER_LANES.VISIBLE_PREVIEW,
  });
  const full = continuousRenderJobKey({
    documentId: 'doc-a', lifecycleGeneration: 2, pageNum: 5,
    pageRevision: 7, quality: CONTINUOUS_RENDER_LANES.VISIBLE_FULL,
    scaleRevision: 15000,
  });
  assert.notEqual(preview, full);
  assert.match(preview, /doc-a:2:5:7:visible-preview/u);
});

test('mount retention reuses the nearest settled pages without exceeding the surface cap', () => {
  assert.deepEqual(planContinuousMountRetention({
    wantedPages: [10, 11, 12],
    mountedPages: [6, 7, 8, 9, 10, 11, 12, 13, 20],
    centerPage: 11,
    maxPages: 6,
  }), [10, 11, 12, 9, 13, 8]);

  assert.deepEqual(planContinuousMountRetention({
    wantedPages: [10, 11],
    mountedPages: [8, 9, 10, 11, 12],
    centerPage: 10,
    maxPages: 9,
    retainMounted: false,
  }), [10, 11]);
});

test('scroll interaction preserves visible work and one mounted page in the travel direction', () => {
  assert.deepEqual(continuousScrollRenderRetentionPages({
    strictlyVisiblePages: [4, 5],
    mountedPages: [2, 3, 4, 5, 6, 7],
    direction: 1,
  }), [4, 5, 6]);
  assert.deepEqual(continuousScrollRenderRetentionPages({
    strictlyVisiblePages: [4, 5],
    mountedPages: [2, 3, 4, 5, 6, 7],
    direction: -1,
  }), [4, 5, 3]);
});

test('a small same-page scroll reuses an exact mounted final surface', () => {
  const current = {
    documentId: 'doc-a',
    ownerDocumentId: 'doc-a',
    lifecycleGeneration: 4,
    ownerLifecycleGeneration: 4,
    rasterSourceRevision: 7,
    expectedSourceRevision: 7,
    rasterRotation: 90,
    expectedRotation: 90,
    renderState: 'ready',
    rasterQuality: 'final',
    targetRasterScale: 2.7,
    expectedRasterScale: 2.7,
    semanticLayoutKey: 'doc-a:8:3:13500:0',
    expectedSemanticLayoutKey: 'doc-a:8:3:13500:0',
    readinessSatisfied: true,
    hasRasterSurface: true,
  };
  assert.equal(continuousMountedRenderCanReuse(current), true);
  assert.equal(continuousMountedRasterCanReuse({
    ...current,
    semanticLayoutKey: '',
    expectedSemanticLayoutKey: 'stale',
    readinessSatisfied: false,
  }), true, 'a current final raster remains visually reusable while semantics refresh');
  for (const stale of [
    { ownerDocumentId: 'doc-b' },
    { ownerLifecycleGeneration: 5 },
    { rasterSourceRevision: 6 },
    { rasterRotation: 0 },
    { renderState: 'loading' },
    { rasterQuality: 'preview' },
    { targetRasterScale: 2.6 },
    { expectedSemanticLayoutKey: 'doc-a:9:3:13500:0' },
    { readinessSatisfied: false },
    { hasRasterSurface: false },
  ]) {
    assert.equal(continuousMountedRenderCanReuse({ ...current, ...stale }), false);
  }
  assert.equal(continuousMountedRasterCanReuse({ ...current, hasRasterSurface: false }), false);
});

test('a mounted proxy surface reconciles a newer model revision only after every layer succeeds', () => {
  const requiredLayers = ['raster', 'annotations', 'text', 'links', 'forms'];
  assert.equal(continuousModelReadinessReconciliationRequired({
    pageRevision: 9,
    livePdfRevision: 7,
    completedLayers: requiredLayers,
    requiredLayers,
  }), true);
  assert.equal(continuousModelReadinessReconciliationRequired({
    pageRevision: 9,
    livePdfRevision: 7,
    completedLayers: requiredLayers.filter((layer) => layer !== 'links'),
    requiredLayers,
  }), false, 'a failed semantic layer cannot be hidden by model publication');
  assert.equal(continuousModelReadinessReconciliationRequired({
    pageRevision: 7,
    livePdfRevision: 7,
    completedLayers: requiredLayers,
    requiredLayers,
  }), false);
  assert.equal(continuousModelReadinessReconciliationRequired({
    pageRevision: 9,
    livePdfRevision: 7,
    readinessSatisfied: true,
    completedLayers: requiredLayers,
    requiredLayers,
  }), false);
});

test('retained raster metadata advances without claiming a new raster publication', () => {
  const surfaceState = {
    documentId: 'doc-a',
    ownerGeneration: 4,
    pageNum: 3,
    contentRevision: 7,
    livePdfRevision: 7,
    pageRevision: 7,
    publicationRevision: 21,
    publishedAt: 1234,
  };
  assert.deepEqual(continuousRenderedSurfaceRevisionUpdate({
    surfaceState,
    documentId: 'doc-a',
    lifecycleGeneration: 4,
    pageNum: 3,
    contentRevision: 9,
    livePdfRevision: 7,
    pageRevision: 9,
    registryPageRevision: 9,
    basePublishedRevision: 9,
    semanticPublishedRevision: 9,
    readinessSatisfied: true,
  }), {
    contentRevision: 9,
    livePdfRevision: 7,
    pageRevision: 9,
  });
  for (const incomplete of [
    { readinessSatisfied: false },
    { registryPageRevision: null },
    { basePublishedRevision: null },
    { semanticPublishedRevision: null },
    { registryPageRevision: 8 },
    { basePublishedRevision: 8 },
    { semanticPublishedRevision: 8 },
    { documentId: 'doc-b' },
    { lifecycleGeneration: 5 },
    { pageNum: 4 },
  ]) {
    assert.equal(continuousRenderedSurfaceRevisionUpdate({
      surfaceState,
      documentId: 'doc-a',
      lifecycleGeneration: 4,
      pageNum: 3,
      contentRevision: 9,
      livePdfRevision: 7,
      pageRevision: 9,
      registryPageRevision: 9,
      basePublishedRevision: 9,
      semanticPublishedRevision: 9,
      readinessSatisfied: true,
      ...incomplete,
    }), null);
  }
  assert.equal(surfaceState.publicationRevision, 21);
  assert.equal(surfaceState.publishedAt, 1234);
});

test('continuous renderer applies mount hysteresis and promotes directional work on scroll', async () => {
  const source = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');
  const retentionAt = source.indexOf('const retainedMountPages = planContinuousMountRetention({');
  const releaseAt = source.indexOf('for (const [pageNum, wrapper] of mounted)', retentionAt);
  const scrollRetentionAt = source.indexOf(
    'const retainedRenderPages = new Set(continuousScrollRenderRetentionPages({',
  );
  const schedulerAt = source.indexOf(
    '_continuousRenderScheduler.noteInteraction(250, { preserve: preserveUsefulRender });',
    scrollRetentionAt,
  );
  assert.ok(retentionAt >= 0 && retentionAt < releaseAt);
  assert.ok(scrollRetentionAt >= 0 && scrollRetentionAt < schedulerAt);
  assert.match(source, /if \(_continuousMountedPageCanReuse\(doc, pageNum\)\)/u);
  assert.match(source, /reuseMountedRaster/u);
  assert.match(source, /CONTINUOUS_RENDER_LANES\.SEMANTIC/u);
  assert.doesNotMatch(source, /protectedPages\.length \+ 9/u);
});
