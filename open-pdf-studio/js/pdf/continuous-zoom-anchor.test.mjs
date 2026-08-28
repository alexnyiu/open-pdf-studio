import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveContinuousHorizontalAnchor,
  resolveContinuousVerticalAnchor,
} from './continuous-zoom-anchor.js';

test('continuous zoom preserves a cursor anchor while the page still fits', () => {
  const result = resolveContinuousHorizontalAnchor({
    basePageX: 180,
    currentPageOffsetX: 0,
    pdfX: 420,
    scale: 1.08,
    localX: 620,
    maximumScrollLeft: 0,
  });
  assert.equal(result.scrollLeft, 0);
  assert.ok(result.pageOffsetX < 0);
  assert.ok(result.driftPx <= Number.EPSILON);
});

test('continuous zoom uses native scroll range before adding a residual offset', () => {
  const result = resolveContinuousHorizontalAnchor({
    basePageX: 20,
    currentPageOffsetX: -12,
    pdfX: 700,
    scale: 2,
    localX: 500,
    maximumScrollLeft: 1_200,
  });
  assert.equal(result.scrollLeft, 908);
  assert.equal(result.pageOffsetX, -12);
  assert.equal(result.driftPx, 0);
});

test('continuous zoom carries WebKit scroll quantization in page-layout space', () => {
  const requested = resolveContinuousVerticalAnchor({
    basePageY: 41_000.25,
    pdfY: 248.375,
    scale: 1.327,
    localY: 380.5,
    maximumScrollTop: 90_000,
  });
  const applied = resolveContinuousVerticalAnchor({
    basePageY: 41_000.25,
    pdfY: 248.375,
    scale: 1.327,
    localY: 380.5,
    maximumScrollTop: 90_000,
    appliedScrollTop: Math.round(requested.requestedScrollTop),
  });

  assert.equal(applied.driftPx, 0);
  assert.ok(Math.abs(applied.pageOffsetY) < 1);
});
