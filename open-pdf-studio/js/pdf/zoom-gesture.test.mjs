import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedWheelDelta, smoothWheelZoomFactor } from './zoom-gesture.js';

test('wheel delta normalization handles pixels, lines, and pages', () => {
  assert.equal(normalizedWheelDelta(10, 0), 10);
  assert.equal(normalizedWheelDelta(2, 1), 32);
  assert.equal(normalizedWheelDelta(1, 2, 700), 700);
});

test('smooth wheel zoom is continuous, directional, and bounded', () => {
  assert.ok(smoothWheelZoomFactor(-2) > 1);
  assert.ok(smoothWheelZoomFactor(2) < 1);
  assert.equal(smoothWheelZoomFactor(0), 1);
  assert.equal(smoothWheelZoomFactor(-10000), 1.28);
  assert.equal(smoothWheelZoomFactor(10000), 0.78);
  assert.ok(smoothWheelZoomFactor(-20) < smoothWheelZoomFactor(-40));
});
