import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageNavigationGestureGate } from './page-navigation-gesture.js';

test('edge navigation is immediate, then repeats by accumulated distance without a timer', () => {
  const gate = createPageNavigationGestureGate({ threshold: 80 });
  assert.equal(gate.shouldNavigate(5), true);
  assert.equal(gate.shouldNavigate(40), false);
  assert.equal(gate.shouldNavigate(40), true);
  assert.equal(gate.shouldNavigate(80), true);
});

test('direction reversal is immediate and leaving the edge resets the gesture', () => {
  const gate = createPageNavigationGestureGate();
  assert.equal(gate.shouldNavigate(10), true);
  assert.equal(gate.shouldNavigate(-1), true);
  assert.equal(gate.shouldNavigate(-20, { atEdge: false }), false);
  assert.equal(gate.shouldNavigate(-1), true);
});
