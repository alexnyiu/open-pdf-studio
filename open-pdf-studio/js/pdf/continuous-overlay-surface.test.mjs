import assert from 'node:assert/strict';
import test from 'node:test';

import {
  continuousOverlayBackingPlan,
  continuousOverlayBackingRequired,
} from './continuous-overlay-surface.js';

test('blank passive continuous page keeps only a one-pixel overlay backing store', () => {
  const doc = {
    currentPage: 3,
    annotations: [],
    textEdits: [],
    watermarks: [],
    selectedAnnotations: [],
  };
  const required = continuousOverlayBackingRequired(doc, 3, { currentTool: 'select' });
  assert.equal(required, false);
  assert.deepEqual(continuousOverlayBackingPlan({
    logicalWidth: 612,
    logicalHeight: 792,
    devicePixelRatio: 2,
    required,
  }), {
    cssWidth: 612,
    cssHeight: 792,
    backingWidth: 1,
    backingHeight: 1,
    compact: true,
  });
});

test('persistent and interactive overlay content restores a full-DPR backing store', () => {
  const base = {
    currentPage: 3,
    annotations: [],
    textEdits: [],
    watermarks: [],
    selectedAnnotations: [],
  };
  assert.equal(continuousOverlayBackingRequired({
    ...base,
    annotations: [{ page: 3 }],
  }, 3, { currentTool: 'select' }), true);
  assert.equal(continuousOverlayBackingRequired(base, 3, {
    currentTool: 'rectangle',
  }), true);
  assert.equal(continuousOverlayBackingRequired(base, 3, {
    currentTool: 'select',
    isRubberBanding: true,
    rubberBandPage: 3,
  }), true);
  assert.deepEqual(continuousOverlayBackingPlan({
    logicalWidth: 612,
    logicalHeight: 792,
    devicePixelRatio: 2,
    required: true,
  }), {
    cssWidth: 612,
    cssHeight: 792,
    backingWidth: 1224,
    backingHeight: 1584,
    compact: false,
  });
});
