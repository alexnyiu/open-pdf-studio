import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PATHOLOGICAL_PASTE_GRAPHEME_LIMIT,
  PATHOLOGICAL_PASTE_LINE_LIMIT,
  displayArrowDelta,
  exactExpansionCandidate,
  orderedRichTextSelectionStart,
  pathologicalPasteDetails,
  semanticRichTextSignature,
} from './pdf-text-edit-interactions.js';
import { richTextFromPlainText } from './rich-text.js';

test('ordered selection start uses the visual start for backward selections', () => {
  assert.deepEqual(orderedRichTextSelectionStart({
    anchor: { line: 3, offset: 8 },
    focus: { line: 1, offset: 4 },
  }), { line: 1, offset: 4 });
  assert.deepEqual(orderedRichTextSelectionStart({
    anchor: { line: 2, offset: 3 },
    focus: { line: 2, offset: 9 },
  }), { line: 2, offset: 3 });
});

test('pathological paste thresholds are strict and preserve normalized full text', () => {
  assert.equal(pathologicalPasteDetails('a'.repeat(PATHOLOGICAL_PASTE_GRAPHEME_LIMIT)).pathological, false);
  const graphemes = pathologicalPasteDetails(`${'a'.repeat(PATHOLOGICAL_PASTE_GRAPHEME_LIMIT)}👍🏽`);
  assert.equal(graphemes.graphemeCount, PATHOLOGICAL_PASTE_GRAPHEME_LIMIT + 1);
  assert.equal(graphemes.overGraphemeLimit, true);
  const lines = pathologicalPasteDetails(Array.from(
    { length: PATHOLOGICAL_PASTE_LINE_LIMIT + 1 }, (_, index) => String(index),
  ).join('\r\n'));
  assert.equal(lines.lineCount, PATHOLOGICAL_PASTE_LINE_LIMIT + 1);
  assert.equal(lines.overLineLimit, true);
  assert.equal(lines.text.includes('\r'), false);
});

test('semantic signature ignores soft reflow geometry but detects formatting', () => {
  const first = richTextFromPlainText('alpha beta', { size: 12 }, {
    x: 10, y: 20, width: 100, height: 20,
  });
  const wrapped = structuredClone(first);
  const sourceRun = wrapped.lines[0].runs[0];
  wrapped.lines = [
    { ...structuredClone(wrapped.lines[0]), breakAfter: 'soft', runs: [{ ...sourceRun, text: 'alpha ' }] },
    { ...structuredClone(wrapped.lines[0]), id: 'wrapped-2', baseline: 4, runs: [{ ...sourceRun, id: 'wrapped-run', text: 'beta' }] },
  ];
  wrapped.region = { ...wrapped.region, y: -80, height: 120 };
  assert.equal(semanticRichTextSignature(first), semanticRichTextSignature(wrapped));
  wrapped.lines[1].runs[0].bold = true;
  wrapped.lines[1].runs[0].faceId = 'liberation-sans-bold';
  assert.notEqual(semanticRichTextSignature(first), semanticRichTextSignature(wrapped));
});

test('arrow deltas use one or ten display page points', () => {
  assert.deepEqual(displayArrowDelta('ArrowLeft'), { x: -1, y: 0 });
  assert.deepEqual(displayArrowDelta('ArrowDown', 10), { x: 0, y: 10 });
  assert.equal(displayArrowDelta('Enter'), null);
});

test('box expansion is offered only for matching valid exact layout inside clamps', () => {
  const placement = {
    canonicalBounds: { x: 10, y: 20, width: 100, height: 30 },
    pageWidth: 500,
    pageHeight: 700,
  };
  const layoutState = {
    pending: false,
    valid: true,
    requestedFingerprint: 'same',
    validatedFingerprint: 'same',
    result: {
      pageEdgeValid: true,
      columnValid: true,
      requiredHeight: 80,
      document: { region: { width: 100, height: 80 } },
    },
  };
  assert.deepEqual(exactExpansionCandidate({
    placement,
    layoutState,
    columnBounds: { left: 0, right: 200 },
  }), { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(exactExpansionCandidate({
    placement,
    layoutState: { ...layoutState, validatedFingerprint: 'stale' },
  }), null);
  assert.equal(exactExpansionCandidate({
    placement: { ...placement, pageHeight: 60 },
    layoutState,
  }), null);
  assert.equal(exactExpansionCandidate({
    placement,
    layoutState,
    columnBounds: { left: 0, right: 80 },
  }), null);
});
