import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
  richTextToPlainText,
} from './rich-text.js';
import { layoutExpandableNativeText } from './native-expandable-layout.js';

function documentFor(text, region = {}) {
  const baseline = region.baseline ?? 90;
  const { baseline: _baseline, ...safeRegion } = region;
  return createRichTextDocument([
    createTextLine([createTextRun(text, {
      faceId: 'liberation-sans-regular', size: 10,
    })], { baseline, baselineAdvance: 12, breakAfter: 'hard' }),
  ], { x: 10, y: 78, width: 80, height: 16, ...safeRegion });
}

test('exact native layout soft-wraps, grows down, and preserves the top anchor', async () => {
  const source = documentFor('one two three four five six');
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
  });
  assert.equal(result.valid, true);
  assert.ok(result.document.lines.length > 1);
  assert.equal(result.document.lines.some((line) => line.breakAfter === 'soft'), true);
  assert.equal(richTextToPlainText(result.document), 'one two three four five six');
  assert.ok(result.document.region.height > source.region.height);
  assert.equal(result.document.region.y + result.document.region.height,
    source.region.y + source.region.height);
});

test('overlap warns without rejecting while CropBox crossing rejects', async () => {
  const source = documentFor('one two three four five six', { y: 4, baseline: 10 });
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    minimumHeight: source.region.height,
    anchorTop: 20,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
    existingBounds: [{ id: 'neighbor', x: 10, y: 2, width: 45, height: 12 }],
  });
  assert.deepEqual(result.overlapWarnings, ['neighbor']);
  assert.equal(result.pageEdgeValid, false);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReasons.join('; '), /CropBox/);
});

test('deletion shrinkage respects the immutable original height', async () => {
  const expanded = documentFor('short', { y: 20, height: 60, width: 45 });
  const result = await layoutExpandableNativeText(expanded, {
    width: 45,
    minimumHeight: 16,
    anchorTop: 80,
  });
  assert.equal(result.document.region.height, 16);
  assert.equal(result.document.region.y, 64);
});

test('exact native layout rejects glyphs or regions that cross the inferred column', async () => {
  const source = documentFor('one two three', { x: 60, width: 45 });
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    columnBounds: { left: 10, right: 90 },
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
  });
  assert.equal(result.columnValid, false);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReasons.join('; '), /native column boundary/);
});
