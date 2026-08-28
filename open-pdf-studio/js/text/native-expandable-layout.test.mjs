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
    inkPadding: 2,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
  });
  assert.equal(result.valid, true);
  assert.ok(result.document.lines.length > 1);
  assert.ok(result.contentWidth < 45);
  assert.equal(result.lineInkBounds.length, result.document.lines.length);
  assert.ok(result.lineInkBounds.every((bounds) => (
    bounds.x >= result.editorBounds.x - 1e-6
      && bounds.x + bounds.width <= result.editorBounds.x + result.editorBounds.width + 1e-6
  )));
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

test('exact native layout rejects a canonical editor region outside the CropBox even when ink fits', async () => {
  const source = documentFor('short', { x: 170, width: 45 });
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
  });
  assert.equal(result.pageEdgeValid, false);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReasons.join('; '), /CropBox/);
});

test('ink-safe content width contains small mixed-style runs and right-edge punctuation', async () => {
  const source = createRichTextDocument([
    createTextLine([
      createTextRun('Main explanation ', { faceId: 'liberation-sans-regular', size: 8.7 }),
      createTextRun('(small gray detail),', {
        faceId: 'liberation-sans-regular', size: 6.8, color: '#777777',
      }),
    ], { baseline: 90, baselineAdvance: 11, breakAfter: 'hard' }),
  ], { x: 10, y: 75, width: 88, height: 18 });
  const result = await layoutExpandableNativeText(source, {
    width: 88,
    inkPadding: 2,
    minimumHeight: 18,
    anchorTop: 93,
  });
  assert.equal(result.valid, true);
  assert.ok(result.document.lines.length >= 2);
  assert.ok(result.inkInsets.left >= 3);
  assert.ok(result.inkInsets.right >= 3);
  for (const bounds of result.lineInkBounds) {
    assert.ok(bounds.x >= result.editorBounds.x - 1e-6);
    assert.ok(bounds.x + bounds.width <= result.editorBounds.x + result.editorBounds.width + 1e-6);
  }
});

test('manual-line mode never generates wraps and rejects an overlong authored line', async () => {
  const source = documentFor('one two three four five six');
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    inkPadding: 2,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
    manualLineBreaks: true,
  });
  assert.equal(result.document.lines.length, 1);
  assert.equal(result.document.lines.some((line) => line.breakAfter === 'soft'), false);
  assert.equal(richTextToPlainText(result.document), 'one two three four five six');
  assert.ok(result.requiredWidth > result.editorBounds.width);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReasons.join('; '), /press Enter/);
});

test('unchanged ARCALYST source uses its complete authored width without consuming visual ink padding', async () => {
  const sourceWidth = 261.6415875;
  const source = createRichTextDocument([
    createTextLine([
      createTextRun('ARCALYST penetration ', {
        faceId: 'liberation-sans-regular', size: 9,
      }),
      createTextRun('(the share of the potential market already', {
        faceId: 'liberation-sans-italic', size: 9, italic: true,
      }),
      // richTextForNativeBlock retains the semantic separator between source
      // visual lines as canonical trailing whitespace on the soft-wrap line.
      createTextRun(' ', {
        faceId: 'liberation-sans-italic', size: 9, italic: true,
      }),
    ], { baseline: 735, baselineAdvance: 11, breakAfter: 'soft' }),
    createTextLine([
      createTextRun('using the product) ', {
        faceId: 'liberation-sans-italic', size: 9, italic: true,
      }),
      createTextRun('+ pipeline', {
        faceId: 'liberation-sans-regular', size: 9,
      }),
    ], { baseline: 724, baselineAdvance: 11, breakAfter: 'hard' }),
  ], { x: 180, y: 721.3, width: sourceWidth, height: 22.7 });

  const result = await layoutExpandableNativeText(source, {
    width: sourceWidth,
    contentWidth: sourceWidth,
    contentInset: 0,
    inkPadding: 2,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 612, height: 792 },
    columnBounds: { left: 180, right: 464 },
    manualLineBreaks: true,
  });

  assert.equal(result.valid, true, result.rejectionReasons.join('; '));
  assert.equal(result.contentWidth, sourceWidth);
  assert.equal(result.contentInset, 0);
  assert.deepEqual(result.contentInsets, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.equal(result.document.region.x, source.region.x);
  assert.equal(result.document.region.width, source.region.width);
  assert.equal(result.document.lines.length, 2);
  assert.equal(richTextToPlainText(result.document), richTextToPlainText(source));
  assert.ok(result.fullLineAdvances[0] > result.contentWidth,
    'the canonical soft-wrap separator remains in the logical shaped line');
  assert.ok(result.paintedLineAdvances[0] <= result.contentWidth + 1e-6,
    'trailing Unicode whitespace does not consume visible line capacity');
  assert.ok(result.requiredWidth <= result.contentWidth + 1e-6);
  assert.ok(result.inkInsets.left >= 3, 'visual ink safety remains available to the editor');
  assert.ok(result.lineInkBounds.every((bounds) => (
    bounds.x >= 180 - 1e-6 && bounds.x + bounds.width <= 464 + 1e-6
  )));
  assert.doesNotMatch(result.rejectionReasons.join('; '), /fixed region|press Enter/u);
});

test('explicit manual capacity still rejects genuinely visible overflow', async () => {
  const source = documentFor('one two three four five six');
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    contentWidth: 45,
    contentInset: 0,
    inkPadding: 2,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
    manualLineBreaks: true,
  });

  assert.ok(result.paintedLineAdvances[0] > result.contentWidth);
  assert.equal(result.valid, false);
  assert.match(result.rejectionReasons.join('; '), /press Enter/u);
});

test('automatic substitution compensates an exact 0.393557 PDF-point width delta', async () => {
  const text = 'EUV advanced lithography substitute width';
  const probe = documentFor(text, { x: 100, width: 300 });
  const measured = await layoutExpandableNativeText(probe, {
    width: 300,
    contentWidth: 300,
    contentInset: 0,
    minimumHeight: probe.region.height,
    manualLineBreaks: true,
  });
  const requiredAdvance = measured.paintedLineAdvances[0];
  const sourceWidth = requiredAdvance - 0.393557;
  const source = documentFor(text, { x: 100, width: sourceWidth });
  const result = await layoutExpandableNativeText(source, {
    width: sourceWidth,
    contentWidth: sourceWidth,
    sourceWidth,
    substitutionWidthAllowance: 1,
    contentInset: 0,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    pageBounds: { x: 0, y: 0, width: 612, height: 792 },
    columnBounds: { left: 100, right: 100 + sourceWidth + 12.84 },
    manualLineBreaks: true,
  });

  assert.equal(result.valid, true, result.rejectionReasons.join('; '));
  assert.ok(Math.abs(result.widthCompensation - 0.393557) < 1e-6);
  assert.ok(Math.abs(result.effectiveContentWidth - requiredAdvance) < 1e-6);
  assert.ok(Math.abs(result.document.region.width - (sourceWidth + 0.393557)) < 1e-6);
  assert.equal(result.document.region.x, source.region.x);
  assert.equal(result.document.region.y + result.document.region.height,
    source.region.y + source.region.height);
});

test('substitution compensation above one point or across a column boundary fails closed', async () => {
  const text = 'EUV advanced lithography substitute width';
  const probe = documentFor(text, { x: 100, width: 300 });
  const measured = await layoutExpandableNativeText(probe, {
    width: 300, contentWidth: 300, contentInset: 0, manualLineBreaks: true,
  });
  const requiredAdvance = measured.paintedLineAdvances[0];

  const tooNarrowWidth = requiredAdvance - 1.0001;
  const tooNarrow = documentFor(text, { x: 100, width: tooNarrowWidth });
  const overAllowance = await layoutExpandableNativeText(tooNarrow, {
    width: tooNarrowWidth,
    contentWidth: tooNarrowWidth,
    sourceWidth: tooNarrowWidth,
    substitutionWidthAllowance: 1,
    contentInset: 0,
    manualLineBreaks: true,
  });
  assert.equal(overAllowance.widthCompensation, 0);
  assert.equal(overAllowance.valid, false);
  assert.match(overAllowance.rejectionReasons.join('; '), /press Enter/u);

  const boundaryWidth = requiredAdvance - 0.393557;
  const boundarySource = documentFor(text, { x: 100, width: boundaryWidth });
  const crossesBoundary = await layoutExpandableNativeText(boundarySource, {
    width: boundaryWidth,
    contentWidth: boundaryWidth,
    sourceWidth: boundaryWidth,
    substitutionWidthAllowance: 1,
    contentInset: 0,
    columnBounds: { left: 100, right: 100 + boundaryWidth + 0.2 },
    manualLineBreaks: true,
  });
  assert.equal(crossesBoundary.widthCompensation, 0);
  assert.equal(crossesBoundary.valid, false);
  assert.match(crossesBoundary.rejectionReasons.join('; '), /press Enter/u);
});

test('trailing Unicode whitespace does not shift explicit right alignment', async () => {
  const plain = documentFor('aligned');
  const spaced = documentFor('aligned\u00a0');
  plain.lines[0].alignment = 'right';
  spaced.lines[0].alignment = 'right';
  const options = {
    width: 80,
    contentWidth: 80,
    contentInset: 0,
    minimumHeight: 16,
    manualLineBreaks: true,
  };

  const [plainResult, spacedResult] = await Promise.all([
    layoutExpandableNativeText(plain, options),
    layoutExpandableNativeText(spaced, options),
  ]);

  assert.ok(spacedResult.fullLineAdvances[0] > plainResult.fullLineAdvances[0]);
  assert.ok(Math.abs(
    spacedResult.paintedLineAdvances[0] - plainResult.paintedLineAdvances[0],
  ) <= 1e-6);
  assert.ok(Math.abs(
    spacedResult.lineInkBounds[0].x - plainResult.lineInkBounds[0].x,
  ) <= 1e-6);
});

test('explicit canonical content inset controls x placement and vertical growth', async () => {
  const source = documentFor('short', { x: 10, y: 78, width: 80, height: 10 });
  const result = await layoutExpandableNativeText(source, {
    width: 80,
    contentWidth: 72,
    contentInset: 4,
    inkPadding: 7,
    minimumHeight: 0,
    anchorTop: 94,
    pageBounds: { x: 0, y: 0, width: 200, height: 200 },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.contentInsets, { left: 4, right: 4, top: 4, bottom: 4 });
  assert.ok(result.lineInkBounds[0].x >= source.region.x + 4 - 1e-6);
  assert.ok(result.requiredHeight >= source.lines[0].baselineAdvance + 8);
  assert.equal(result.document.region.y + result.document.region.height, 94);
});

test('manual-line mode preserves a source visual-line marker without adding lines', async () => {
  const source = createRichTextDocument([
    createTextLine([createTextRun('one two three four five six', { size: 10 })], {
      baseline: 90, baselineAdvance: 12, breakAfter: 'soft',
    }),
  ], { x: 10, y: 78, width: 45, height: 16 });
  const result = await layoutExpandableNativeText(source, {
    width: 45,
    minimumHeight: 16,
    manualLineBreaks: true,
  });
  assert.equal(result.document.lines.length, 1);
  assert.equal(result.document.lines[0].breakAfter, 'soft');
  assert.match(result.rejectionReasons.join('; '), /press Enter/);
});

test('manual-line mode accepts explicit lines and grows only for those lines', async () => {
  const source = createRichTextDocument([
    createTextLine([createTextRun('one two', { size: 10 })], {
      baseline: 90, baselineAdvance: 12, breakAfter: 'hard',
    }),
    createTextLine([createTextRun('three four', { size: 10 })], {
      baseline: 78, baselineAdvance: 12, breakAfter: 'hard',
    }),
  ], { x: 10, y: 78, width: 55, height: 16 });
  const result = await layoutExpandableNativeText(source, {
    width: 55,
    inkPadding: 2,
    minimumHeight: 16,
    anchorTop: 94,
    manualLineBreaks: true,
  });
  assert.equal(result.valid, true);
  assert.equal(result.document.lines.length, 2);
  assert.equal(result.document.lines.every((line) => line.breakAfter === 'hard'), true);
  assert.ok(result.document.region.height > 16);
});

test('manual-line shaping preserves complete run and paragraph formatting', async () => {
  const source = createRichTextDocument([
    createTextLine([
      createTextRun('Blue ', {
        faceId: 'liberation-sans-bold-italic', size: 8.7, color: '#0057a8',
        bold: true, italic: true, underline: true, strikeout: false,
      }),
      createTextRun('gray', {
        faceId: 'liberation-serif-regular', size: 6.8, color: '#666666',
        bold: false, italic: false, underline: false, strikeout: true,
      }),
    ], {
      baseline: 90, baselineAdvance: 9.5, alignment: 'right', breakAfter: 'hard',
    }),
    createTextLine([createTextRun('next', {
      faceId: 'liberation-mono-italic', size: 7.2, color: '#123456', italic: true,
    })], {
      baseline: 80.4997, baselineAdvance: 10.25, alignment: 'center', breakAfter: 'hard',
    }),
  ], { x: 10, y: 70, width: 90, height: 24 });
  const result = await layoutExpandableNativeText(source, {
    width: 90,
    minimumHeight: 24,
    anchorTop: 94,
    manualLineBreaks: true,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.document.lines.map((line) => ({
    baseline: line.baseline,
    alignment: line.alignment,
    baselineAdvance: line.baselineAdvance,
    breakAfter: line.breakAfter,
    runs: line.runs.map((run) => ({
      text: run.text,
      faceId: run.faceId,
      size: run.size,
      color: run.color,
      bold: run.bold,
      italic: run.italic,
      underline: run.underline,
      strikeout: run.strikeout,
    })),
  })), source.lines.map((line) => ({
    baseline: line.baseline,
    alignment: line.alignment,
    baselineAdvance: line.baselineAdvance,
    breakAfter: line.breakAfter,
    runs: line.runs.map((run) => ({
      text: run.text,
      faceId: run.faceId,
      size: run.size,
      color: run.color,
      bold: run.bold,
      italic: run.italic,
      underline: run.underline,
      strikeout: run.strikeout,
    })),
  })));
});
