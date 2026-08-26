import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRichTextDocument, createTextLine, createTextRun, richTextToPlainText,
} from './rich-text.js';
import {
  buildMergedTextEditSelection, marqueeContainsSelectionItem,
  reflowRichTextToWidth, sortTextEditSelectionItems,
} from './text-edit-selection.js';

const doc = (text, x, y, style = {}) => createRichTextDocument([
  createTextLine([createTextRun(text, { size: 10, ...style })], { baseline: y + 9 }),
], { x, y, width: 80, height: 12, rotation: 0 });
const item = (key, text, left, top, extra = {}) => ({
  key, kind: 'native', page: 1, rotation: 0, eligible: true,
  geometry: { left, top, width: 80, height: 12 },
  viewRect: { left, top, width: 80, height: 12 },
  richText: doc(text, left, top), sourceProvenance: [{ markerId: key }], ...extra,
});

test('marquee selects centers and reading order is baseline aware', () => {
  const a = item('a', 'A', 100, 10);
  const b = item('b', 'B', 10, 11);
  assert.equal(marqueeContainsSelectionItem({ left: 0, top: 0, width: 70, height: 30 }, b), true);
  assert.deepEqual(sortTextEditSelectionItems([a, b]).map((entry) => entry.key), ['b', 'a']);
});

test('merge preserves formatting, hard paragraph breaks, provenance, union, and primary id', () => {
  const firstRecord = { id: 'stable', revision: 4 };
  const a = item('a', 'Alpha', 10, 10, { sourceRecord: firstRecord, kind: 'record' });
  const b = item('b', 'Beta', 10, 40, { richText: doc('Beta', 10, 40, { bold: true }) });
  const plan = buildMergedTextEditSelection([b, a]);
  assert.equal(plan.primaryId, 'stable');
  assert.equal(plan.revision, 5);
  assert.equal(richTextToPlainText(plan.richText), 'Alpha\nBeta');
  assert.equal(plan.richText.lines[1].runs[0].bold, true);
  assert.deepEqual(plan.sourceProvenance.map((source) => source.markerId), ['a', 'b']);
  assert.deepEqual(plan.geometry, { left: 10, top: 10, width: 80, height: 42 });
});

test('merge rejects cross-page, rotation, scanned, and unowned selections', () => {
  const base = item('a', 'A', 0, 0);
  assert.throws(() => buildMergedTextEditSelection([base, { ...item('b','B',0,20), page: 2 }]), /same page/);
  assert.throws(() => buildMergedTextEditSelection([base, { ...item('b','B',0,20), rotation: 90 }]), /rotation/);
  assert.throws(() => buildMergedTextEditSelection([base, { ...item('b','B',0,20), kind: 'scannedText' }]), /Scanned/);
  assert.throws(() => buildMergedTextEditSelection([base, { ...item('b','B',0,20), eligible: false }]), /validated/);
});

test('reflow distinguishes generated soft wraps from authored hard breaks and grows down', () => {
  const source = createRichTextDocument([
    createTextLine([createTextRun('one two three', { size: 10 })], { baseline: 90, breakAfter: 'hard' }),
    createTextLine([createTextRun('four', { size: 10, italic: true })], { baseline: 78, breakAfter: 'hard' }),
  ], { x: 10, y: 20, width: 100, height: 20 });
  const flowed = reflowRichTextToWidth(source, 30);
  assert.ok(flowed.lines.length > 2);
  assert.equal(richTextToPlainText(flowed), 'one two three\nfour');
  assert.equal(flowed.lines.some((line) => line.breakAfter === 'soft'), true);
  assert.ok(flowed.region.height > source.region.height);
  assert.equal(flowed.region.y + flowed.region.height, source.region.y + source.region.height);
});

test('reflow shrinks after deletion without crossing the immutable minimum height', () => {
  const expanded = createRichTextDocument([
    createTextLine([createTextRun('short', { size: 10 })], { baseline: 90, breakAfter: 'hard' }),
  ], { x: 10, y: -20, width: 30, height: 60 });
  const flowed = reflowRichTextToWidth(expanded, 30, undefined, {
    minimumHeight: 20,
    anchorTop: 40,
  });
  assert.equal(flowed.region.height, 20);
  assert.equal(flowed.region.y, 20);
});
