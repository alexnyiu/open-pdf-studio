import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PADDLE_DB_POSTPROCESS,
  classifyUnsupportedLayout,
  derivePostprocessBudget,
  detectionMapToQuadrilaterals,
  orderRecognizedLines,
  suppressDuplicateDetections,
} from './postprocess.js';

function detectorMap(width, height, paint = null) {
  const data = new Float32Array(width * height);
  paint?.(data, width, height);
  return { data, dims: [1, 1, height, width] };
}

function fillRectangle(data, width, left, top, right, bottom, score = 0.9) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) data[y * width + x] = score;
  }
}

function fillRotatedRectangle(data, width, height, centerX, centerY, lineWidth, lineHeight, degrees) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offsetX = x + 0.5 - centerX;
      const offsetY = y + 0.5 - centerY;
      const along = offsetX * cosine + offsetY * sine;
      const across = -offsetX * sine + offsetY * cosine;
      if (Math.abs(along) <= lineWidth / 2 && Math.abs(across) <= lineHeight / 2) {
        data[y * width + x] = 0.9;
      }
    }
  }
}

function recognizedLine(text, x, y, width = 40, height = 8, angleDegrees = 0) {
  const polygon = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  return {
    text,
    confidence: 0.95,
    detectionConfidence: 0.95,
    polygon,
    boundingBox: { x, y, width, height },
    center: [x + width / 2, y + height / 2],
    width,
    height,
    angleDegrees,
  };
}

test('dense detector output is not truncated at 64 lines', () => {
  const output = detectorMap(96, 282, (data, width) => {
    for (let line = 0; line < 70; line += 1) {
      fillRectangle(data, width, 4, line * 4 + 1, 82, line * 4 + 3);
    }
  });
  const detections = detectionMapToQuadrilaterals(output, 960, 2_820);
  assert.equal(detections.length, 70);
});

test('DB-style extraction preserves rotated quadrilaterals and mild skew', () => {
  const output = detectorMap(96, 64, (data, width, height) => {
    fillRotatedRectangle(data, width, height, 48, 32, 30, 8, 11);
  });
  const [detection] = detectionMapToQuadrilaterals(output, 960, 640);
  assert.ok(Math.abs(detection.angleDegrees) > 7);
  assert.ok(Math.abs(detection.polygon[0][1] - detection.polygon[1][1]) > 5);
  assert.equal(detection.polygon.length, 4);

  const layout = orderRecognizedLines([{ ...detection, text: 'Skew line', confidence: 0.95 }]);
  assert.deepEqual(layout.lines.map((line) => line.text), ['Skew line']);
  assert.deepEqual(classifyUnsupportedLayout({
    candidates: [detection],
    recognizedLines: [{ ...detection, text: 'Skew line', confidence: 0.95 }],
    blocks: layout.blocks,
  }), []);
});

test('two-column reading order is stable and deterministic', () => {
  const lines = [
    recognizedLine('right second', 120, 30),
    recognizedLine('left first', 10, 10),
    recognizedLine('right first', 120, 10),
    recognizedLine('left second', 10, 30),
  ];
  const expected = ['left first', 'left second', 'right first', 'right second'];
  for (let offset = 0; offset < lines.length; offset += 1) {
    const permutation = [...lines.slice(offset), ...lines.slice(0, offset)].reverse();
    assert.deepEqual(orderRecognizedLines(permutation).lines.map((line) => line.text), expected);
  }
});

test('blank pages return no detections', () => {
  assert.deepEqual(detectionMapToQuadrilaterals(detectorMap(64, 64), 640, 640), []);
});

test('duplicate detections are suppressed by polygon overlap', () => {
  const primary = recognizedLine('primary', 10, 10, 100, 20);
  const duplicate = { ...recognizedLine('duplicate', 11, 10, 100, 20), detectionConfidence: 0.8 };
  const separate = recognizedLine('separate', 10, 50, 100, 20);
  assert.deepEqual(
    suppressDuplicateDetections([duplicate, separate, primary]).map((line) => line.text),
    ['primary', 'separate'],
  );
});

test('unclipping clamps every detector point to the raster bounds', () => {
  const output = detectorMap(64, 64, (data, width) => {
    fillRectangle(data, width, 0, 0, 30, 4);
    fillRectangle(data, width, 34, 59, 63, 63);
  });
  const rotatedOutput = detectorMap(64, 64, (data, width, height) => {
    fillRotatedRectangle(data, width, height, 7, 7, 24, 6, 20);
  });
  const detections = [
    ...detectionMapToQuadrilaterals(output, 640, 640),
    ...detectionMapToQuadrilaterals(rotatedOutput, 640, 640),
  ];
  assert.equal(detections.length, 3);
  for (const point of detections.flatMap((detection) => detection.polygon)) {
    assert.ok(point[0] >= 0 && point[0] <= 640);
    assert.ok(point[1] >= 0 && point[1] <= 640);
  }
});

test('page-complexity and result-size budgets reject excess detections', () => {
  const output = detectorMap(64, 32, (data, width) => {
    fillRectangle(data, width, 2, 2, 20, 6);
    fillRectangle(data, width, 2, 20, 20, 24);
  });
  assert.throws(
    () => detectionMapToQuadrilaterals(output, 640, 320, {
      budget: { maximumLines: 1, maximumBlocks: 1 },
    }),
    (error) => error.code === 'OCR_PAGE_COMPLEXITY_LIMIT',
  );
  assert.throws(
    () => derivePostprocessBudget({ sourceWidth: 640, sourceHeight: 320, maximumResultBytes: 1_024 }),
    /result budget is too small/,
  );
  assert.throws(
    () => detectionMapToQuadrilaterals(output, 640, 320, {
      maximumContourPointsPerCandidate: 8,
    }),
    (error) => error.code === 'OCR_PAGE_COMPLEXITY_LIMIT',
  );
});

test('rotated and table-shaped layouts are explicitly unsupported', () => {
  const rotated = recognizedLine('rotated', 20, 20, 100, 20, 30);
  let layout = orderRecognizedLines([rotated]);
  assert.equal(classifyUnsupportedLayout({
    candidates: [rotated],
    recognizedLines: [rotated],
    blocks: layout.blocks,
  })[0].code, 'rotated-text');

  const table = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      table.push(recognizedLine(`${row}-${column}`, 10 + column * 70, 10 + row * 30, 40, 10));
    }
  }
  layout = orderRecognizedLines(table);
  assert.equal(layout.blocks.length, 3);
  assert.equal(classifyUnsupportedLayout({
    candidates: table,
    recognizedLines: table,
    blocks: layout.blocks,
  })[0].code, 'table');
});

test('resource policy has explicit detector and serialized-result ceilings', () => {
  const budget = derivePostprocessBudget({ sourceWidth: 2_000, sourceHeight: 3_000 });
  assert.equal(budget.maximumLines, PADDLE_DB_POSTPROCESS.maximumDetectorCandidates);
  assert.ok(budget.maximumLines > 64);
  assert.ok(budget.estimatedResultBytesPerLine > 0);
});
