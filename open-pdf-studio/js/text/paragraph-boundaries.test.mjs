import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PARAGRAPH_BOUNDARY_AMBIGUOUS,
  PARAGRAPH_BOUNDARY_JOIN,
  PARAGRAPH_BOUNDARY_SPLIT,
  scoreParagraphBoundary,
  segmentParagraphLines,
} from './paragraph-boundaries.js';

function line(id, text, overrides = {}) {
  return {
    id, text, columnId: 'column-1', geometryValid: true, direction: 'ltr',
    left: 20, top: 0, bottom: 12, width: 180, height: 12, angle: 0,
    ...overrides,
  };
}

const compact = { medianHeight: 12, medianGap: 4, medianWidth: 180, gap: 4 };

test('shared scorer joins only when multiple compatible continuation signals agree', () => {
  const result = scoreParagraphBoundary(
    line('a', 'This sentence continues'),
    line('b', 'onto the next line.', { top: 16, bottom: 28 }),
    compact,
  );
  assert.equal(result.decision, PARAGRAPH_BOUNDARY_JOIN);
  assert.ok(result.evidence.filter((entry) => entry.weight > 0).length >= 3);
});

test('forced column, heading/list, geometry, direction, and large-gap changes split', () => {
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', 'Text', { columnId: 'column-2' }), compact).decision,
    PARAGRAPH_BOUNDARY_SPLIT);
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', '• New item'), compact).decision,
    PARAGRAPH_BOUNDARY_SPLIT);
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', 'Text', { geometryValid: false }), compact).decision,
    PARAGRAPH_BOUNDARY_SPLIT);
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', 'Text', { direction: 'rtl' }), compact).decision,
    PARAGRAPH_BOUNDARY_SPLIT);
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', 'Text'), { ...compact, gap: 40 }).decision,
    PARAGRAPH_BOUNDARY_SPLIT);
});

test('ambiguous defaults to a split and a merge override cannot cross a forced boundary', () => {
  const ambiguous = scoreParagraphBoundary(
    line('a', 'Short.', { width: 70 }),
    line('b', 'Next', { top: 16, bottom: 28, width: 70 }),
    compact,
  );
  assert.equal(ambiguous.decision, PARAGRAPH_BOUNDARY_AMBIGUOUS);

  const segmented = segmentParagraphLines([
    line('a', 'Short.', { width: 70 }),
    line('b', 'Next', { top: 16, bottom: 28, width: 70 }),
  ], { contextForBoundary: () => compact });
  assert.equal(segmented.groups.length, 2);

  const forced = scoreParagraphBoundary(line('a', 'Text'), line('b', 'Text', { columnId: 'column-2' }), {
    ...compact, override: 'merge',
  });
  assert.equal(forced.decision, PARAGRAPH_BOUNDARY_SPLIT);
});

test('explicit split wins and same-column merge is accepted only after hard safety checks', () => {
  assert.equal(scoreParagraphBoundary(line('a', 'Text'), line('b', 'text'), {
    ...compact, override: 'split',
  }).decision, PARAGRAPH_BOUNDARY_SPLIT);
  assert.equal(scoreParagraphBoundary(line('a', 'Short.', { width: 70 }), line('b', 'Next', { width: 70 }), {
    ...compact, override: 'merge',
  }).decision, PARAGRAPH_BOUNDARY_JOIN);
});
