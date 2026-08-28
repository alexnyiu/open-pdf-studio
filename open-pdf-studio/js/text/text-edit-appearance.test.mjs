import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPageRotation,
  dominantBackgroundColor,
  elementRectToCanvasPixels,
  getPageRotationMatrix,
  getTextLayerCssMatrix,
  invertPageRotation,
  pdfJsViewportPointInTextLayerSpace,
  restoreTextEditSnapshot,
  rawPdfTextLayerViewportOptions,
  resolveTextEditPageGeometry,
  selectTextColor,
  sourceTextLineExtent,
} from './text-edit-appearance.js';

test('page rotation matrix keeps PDF text attached for every quarter turn', () => {
  const width = 600;
  const height = 800;
  const point = { x: 100, y: 200 };

  assert.deepEqual(getPageRotationMatrix(width, height, 0), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(getPageRotationMatrix(width, height, 90), [0, 1, -1, 0, 800, 0]);
  assert.deepEqual(getPageRotationMatrix(width, height, 180), [-1, 0, 0, -1, 600, 800]);
  assert.deepEqual(getPageRotationMatrix(width, height, 270), [0, -1, 1, 0, 0, 600]);

  assert.deepEqual(applyPageRotation(point.x, point.y, width, height, 90), { x: 600, y: 100 });
  assert.deepEqual(applyPageRotation(point.x, point.y, width, height, 180), { x: 500, y: 600 });
  assert.deepEqual(applyPageRotation(point.x, point.y, width, height, 270), { x: 200, y: 500 });
});

test('rotated display coordinates invert to the original text position', () => {
  const width = 600;
  const height = 800;
  const original = { x: 123, y: 456 };

  for (const rotation of [0, 90, 180, 270]) {
    const displayed = applyPageRotation(original.x, original.y, width, height, rotation);
    assert.deepEqual(invertPageRotation(displayed.x, displayed.y, width, height, rotation), original);
  }
});

test('text layer matrix composes page rotation, zoom, and viewport offset', () => {
  assert.deepEqual(
    getTextLayerCssMatrix(600, 800, 90, 2, 10, 20),
    [0, 2, -2, 0, 1610, 20],
  );
  assert.deepEqual(
    getTextLayerCssMatrix(600, 800, 270, 1.5, -5, 12),
    [0, -1.5, 1.5, 0, -5, 912],
  );
});

test('text colour selection ignores white background and antialiased grey edges', () => {
  const blackGlyph = new Uint8ClampedArray([
    255, 255, 255, 255,
    188, 188, 188, 255,
    17, 17, 17, 255,
    110, 110, 110, 255,
  ]);
  assert.equal(selectTextColor(blackGlyph), '#000000');

  const redGlyph = new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 170, 170, 255,
    214, 32, 40, 255,
  ]);
  assert.equal(selectTextColor(redGlyph), '#d62028');
});

test('text colour selection preserves colours on light and dark backgrounds', () => {
  assert.equal(selectTextColor(new Uint8ClampedArray([
    0, 0, 0, 255,
    0, 0, 0, 255,
    214, 32, 40, 255,
  ])), '#d62028');
  assert.equal(selectTextColor(new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 255, 255, 255,
    51, 51, 51, 255,
  ])), '#333333');
  assert.equal(selectTextColor(new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 255, 255, 255,
    244, 244, 244, 255,
  ])), '#f4f4f4');

  assert.equal(selectTextColor(new Uint8ClampedArray([
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  ]), '#000000', 3, 3), '#000000');
});

test('cancelling a live text edit restores the complete record snapshot', () => {
  const record = { pdfX: 12, pdfY: 30, color: '#ff0000', transient: true };
  restoreTextEditSnapshot(record, { pdfX: 10, pdfY: 20, color: '#000000' });
  assert.deepEqual(record, { pdfX: 10, pdfY: 20, color: '#000000' });
});

test('DOM text bounds are converted to canvas backing pixels', () => {
  const canvasRect = { left: 20, top: 40, width: 400, height: 300 };
  const textRect = { left: 120, top: 115, right: 220, bottom: 145 };

  assert.deepEqual(
    elementRectToCanvasPixels(textRect, canvasRect, 800, 600),
    { x: 200, y: 150, width: 200, height: 60 },
  );
});

test('page geometry combines intrinsic and user rotation', () => {
  assert.deepEqual(
    resolveTextEditPageGeometry({ widthPt: 600, heightPt: 800, rotation: 90 }, 800, 600, 90),
    { pageWidth: 600, pageHeight: 800, rotation: 180, displayWidth: 600, displayHeight: 800 },
  );
});

test('unified text layers stay in unrotated raw PDF user space', () => {
  assert.deepEqual(rawPdfTextLayerViewportOptions(1.25), { scale: 0.8, rotation: 0 });
  assert.deepEqual(rawPdfTextLayerViewportOptions(1), { scale: 1, rotation: 0 });
  assert.deepEqual(rawPdfTextLayerViewportOptions(0), { scale: 1, rotation: 0 });
});

test('PDF.js OCR projection removes UserUnit only for raw-unit continuous hosts', () => {
  const viewport = {
    userUnit: 1.25,
    convertToViewportPoint(x, y) {
      return [x * 1.25, (240 - y) * 1.25];
    },
  };
  assert.deepEqual(pdfJsViewportPointInTextLayerSpace(
    viewport,
    20,
    200,
    { rawUnitHost: true },
  ), [20, 40]);
  assert.deepEqual(pdfJsViewportPointInTextLayerSpace(viewport, 20, 200), [25, 50]);
  assert.deepEqual(pdfJsViewportPointInTextLayerSpace({
    userUnit: 1,
    convertToViewportPoint: (x, y) => [x, y],
  }, 20, 40), [20, 40]);
});

test('source text line extent preserves gaps between PDF.js word spans', () => {
  assert.deepEqual(sourceTextLineExtent([
    { pdfX: 54, pdfWidth: 27 },
    { pdfX: 90, pdfWidth: 45 },
    { pdfX: 459, pdfWidth: 90 },
  ]), { x: 54, width: 495 });
});

test('live text preview covers only a dominant uniform background', () => {
  const mostlyWhite = new Uint8ClampedArray([
    255, 255, 255, 255,
    252, 252, 252, 255,
    250, 250, 250, 255,
    10, 10, 10, 255,
  ]);
  assert.deepEqual(dominantBackgroundColor(mostlyWhite), { r: 252, g: 252, b: 252 });

  const complex = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 255,
    220, 20, 60, 255,
    20, 90, 220, 255,
  ]);
  assert.equal(dominantBackgroundColor(complex), null);
});
