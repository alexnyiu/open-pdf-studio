import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyZoomWheel,
  normalizedWheelDelta,
  smoothWheelZoomFactor,
  zoomFactorForInput,
} from './zoom-gesture.js';

test('wheel delta normalization handles pixels, lines, and pages', () => {
  assert.equal(normalizedWheelDelta(10, 0), 10);
  assert.equal(normalizedWheelDelta(2, 1), 32);
  assert.equal(normalizedWheelDelta(1, 2, 700), 700);
});

test('precision pinch uses the faster macOS trackpad curve without changing coarse wheels', () => {
  assert.equal(classifyZoomWheel({ deltaMode: 0, ctrlKey: true }), 'trackpad');
  assert.equal(classifyZoomWheel({ deltaMode: 1, ctrlKey: true }), 'wheel');
  // The underlying curve is ~1.5x per 120 px, with the specified pathological
  // single-frame clamp applied before publication.
  assert.equal(zoomFactorForInput(-120, 'trackpad'), 1.38);
  assert.equal(zoomFactorForInput(-10000, 'trackpad'), 1.38);
  assert.equal(zoomFactorForInput(10000, 'trackpad'), 0.72);
  assert.equal(zoomFactorForInput(-10000, 'wheel'), 1.28);
});

test('smooth wheel zoom is continuous, directional, and bounded', () => {
  assert.ok(smoothWheelZoomFactor(-2) > 1);
  assert.ok(smoothWheelZoomFactor(2) < 1);
  assert.equal(smoothWheelZoomFactor(0), 1);
  assert.equal(smoothWheelZoomFactor(-10000), 1.28);
  assert.equal(smoothWheelZoomFactor(10000), 0.78);
  assert.ok(smoothWheelZoomFactor(-20) < smoothWheelZoomFactor(-40));
});
