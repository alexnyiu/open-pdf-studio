import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canvasBackingDimensions,
  overlayCanvasTransform,
  overlayVisibleBounds,
  singlePageOverlaySurfaceDimensions,
} from './canvas-dpr.js';

test('overlay backing stores preserve CSS dimensions at DPR 1, 2, and fractional DPR', () => {
  assert.deepEqual(canvasBackingDimensions(800, 600, 1), {
    width: 800, height: 600, cssWidth: 800, cssHeight: 600, dpr: 1,
  });
  assert.deepEqual(canvasBackingDimensions(800, 600, 2), {
    width: 1600, height: 1200, cssWidth: 800, cssHeight: 600, dpr: 2,
  });
  assert.deepEqual(canvasBackingDimensions(333, 222, 1.25), {
    width: 416, height: 278, cssWidth: 333, cssHeight: 222, dpr: 1.25,
  });
});

test('viewport transform applies DPR exactly once and retains CSS-space culling', () => {
  const transform = overlayCanvasTransform({
    viewportActive: true,
    zoom: 1.5,
    offsetX: 24,
    offsetY: -12,
    legacyScale: 3,
    dpr: 2,
  });
  assert.deepEqual(transform, { a: 3, b: 0, c: 0, d: 3, e: 48, f: -24 });
  assert.deepEqual(overlayVisibleBounds({
    backingWidth: 1800,
    backingHeight: 1200,
    viewportActive: true,
    zoom: 1.5,
    offsetX: 24,
    offsetY: -12,
    legacyScale: 3,
    dpr: 2,
  }), {
    x: -16,
    y: 8,
    width: 600,
    height: 400,
  });
});

test('single-page viewport keeps overlays on the complete visible host surface', () => {
  assert.deepEqual(singlePageOverlaySurfaceDimensions({
    viewportActive: true,
    viewportWidth: 775,
    viewportHeight: 697,
    pageWidth: 538,
    pageHeight: 697,
  }), { width: 775, height: 697 });
  assert.deepEqual(singlePageOverlaySurfaceDimensions({
    viewportActive: false,
    viewportWidth: 775,
    viewportHeight: 697,
    pageWidth: 538,
    pageHeight: 697,
  }), { width: 538, height: 697 });
});
