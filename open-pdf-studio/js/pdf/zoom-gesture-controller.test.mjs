import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeGestureIncrement } from './zoom-gesture-controller.js';

test('native gesture scale is converted to a bounded incremental factor', () => {
  assert.equal(nativeGestureIncrement(1, 1.2), 1.2);
  assert.equal(nativeGestureIncrement(1.2, 1.32), 1.1);
  assert.equal(nativeGestureIncrement(1, 5), 1.38);
  assert.equal(nativeGestureIncrement(1, 0.1), 0.72);
});
