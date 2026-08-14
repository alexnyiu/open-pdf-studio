import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPageNavigationGestureGate,
  getPageNavigationDirection,
} from './page-navigation-gesture.mjs';

test('continued same-direction scrolling unlocks one page turn per threshold', () => {
  const gate = createPageNavigationGestureGate({ threshold: 80 });

  assert.equal(gate.isBlocked(1), false);
  gate.block(1);
  gate.noteWheel(20);
  gate.noteWheel(20);
  gate.noteWheel(20);
  assert.equal(gate.isBlocked(1), true);

  gate.noteWheel(20);
  assert.equal(gate.isBlocked(1), false);

  // The next page turn can be blocked again without a quiet gap.
  gate.block(1);
  gate.noteWheel(80);
  assert.equal(gate.isBlocked(1), false);
});

test('reversing direction immediately opens the opposite page turn', () => {
  const gate = createPageNavigationGestureGate({ threshold: 80 });
  gate.block(1);
  gate.noteWheel(-1);
  assert.equal(gate.isBlocked(-1), false);
  assert.equal(gate.isBlocked(1), false);
});

test('wheel movement from a consumed tool event can be ignored by the caller', () => {
  const gate = createPageNavigationGestureGate({ threshold: 80 });
  gate.block(1);
  // The navigation handler calls noteWheel only after a tool declines the
  // event, so a consumed event does not advance this gate.
  assert.equal(gate.isBlocked(1), true);
});

test('page navigation direction advances one page and respects mode, edges, and boundaries', () => {
  const base = {
    dx: 0,
    dy: 100,
    atTop: false,
    atBottom: true,
    currentPage: 2,
    pageCount: 5,
  };

  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single' }), 1);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single', gestureLocked: true }), 0);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'continuous' }), 0);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single', currentPage: 5 }), 0);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single', dy: -100, atTop: true, atBottom: false }), -1);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single', dy: -100, atTop: true, atBottom: false, currentPage: 1 }), 0);
  assert.equal(getPageNavigationDirection({ ...base, viewMode: 'single', dx: 120, dy: 100 }), 0);
});
