import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTINUOUS_RENDER_LANES,
  continuousRenderJobKey,
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
