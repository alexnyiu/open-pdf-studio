import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveContinuousHorizontalAnchor,
  resolveContinuousHorizontalQuantization,
  resolveContinuousHorizontalScrollSpace,
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

test('negative zoom residual receives leading scroll space so the left page edge stays reachable', () => {
  const result = resolveContinuousHorizontalScrollSpace({
    baseContentWidth: 1_000,
    viewportWidth: 800,
    pageOffsetX: -150,
    logicalScrollLeft: 200,
  });

  assert.deepEqual(result, {
    leadingPaddingPx: 150,
    trailingPaddingPx: 0,
    contentWidth: 1_150,
    scrollLeft: 350,
    pageTranslationX: 0,
    maximumScrollLeft: 350,
  });
  const pageLeft = 20 + result.pageTranslationX;
  const pageRight = pageLeft + 960;
  assert.ok(pageLeft >= 0);
  assert.ok(pageRight - result.maximumScrollLeft <= 800);
});

test('horizontal scroll space preserves the zoom anchor while making both edges reachable', () => {
  const basePageX = 20;
  const pageOffsetX = -150;
  const logicalScrollLeft = 120;
  const pdfPointX = 440;
  const scale = 1.5;
  const result = resolveContinuousHorizontalScrollSpace({
    baseContentWidth: 1_000,
    viewportWidth: 800,
    pageOffsetX,
    logicalScrollLeft,
  });
  const before = basePageX + pageOffsetX + pdfPointX * scale - logicalScrollLeft;
  const after = basePageX + result.pageTranslationX + pdfPointX * scale - result.scrollLeft;

  assert.equal(after, before);
  assert.equal(result.scrollLeft - result.leadingPaddingPx, logicalScrollLeft);
});

test('positive zoom residual receives trailing scroll space so the right page edge stays reachable', () => {
  const result = resolveContinuousHorizontalScrollSpace({
    baseContentWidth: 1_000,
    viewportWidth: 800,
    pageOffsetX: 150,
    logicalScrollLeft: 0,
  });

  assert.equal(result.leadingPaddingPx, 0);
  assert.equal(result.trailingPaddingPx, 150);
  assert.equal(result.contentWidth, 1_150);
  assert.equal(result.pageTranslationX, 150);
  const pageRight = 20 + result.pageTranslationX + 960;
  assert.ok(pageRight - result.maximumScrollLeft <= 800);
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

test('continuous zoom carries horizontal scroll quantization after padding materialization', () => {
  const anchor = resolveContinuousHorizontalAnchor({
    basePageX: 126.25,
    pdfX: 248.375,
    scale: 1.327,
    localX: 212.5,
    maximumScrollLeft: 500,
  });
  const space = resolveContinuousHorizontalScrollSpace({
    baseContentWidth: 1_200,
    viewportWidth: 700,
    pageOffsetX: anchor.pageOffsetX,
    logicalScrollLeft: anchor.scrollLeft,
  });
  const correction = resolveContinuousHorizontalQuantization({
    basePageX: 126.25,
    pageTranslationX: space.pageTranslationX,
    pdfX: 248.375,
    scale: 1.327,
    localX: 212.5,
    appliedScrollLeft: Math.round(space.scrollLeft),
  });

  assert.equal(correction.driftPx, 0);
  assert.ok(Math.abs(correction.pageQuantizationX) < 1);
});
