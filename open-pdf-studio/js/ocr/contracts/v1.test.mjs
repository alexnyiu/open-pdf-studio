import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  assertOcrEngineV1,
  assertOcrResultV1,
  validateOcrResultV1,
} from './v1.js';

function engine() {
  return {
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: 1,
    engineId: 'test-engine',
    adapterVersion: '0.1.0',
    provider: 'test',
    model: { family: 'test', tier: 'small', detection: 'det', recognition: 'rec' },
    runtime: { name: 'test', version: '1', executionProvider: 'wasm', offline: true },
    capabilities: { textDetection: true, textRecognition: true, wordBoxes: false, pdfWriting: false },
  };
}

function result() {
  return {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 1,
    requestId: 'request-1',
    engine: engine(),
    source: { kind: 'pdf-page', path: '/fixture.pdf', pageIndex: 0, widthPx: 100, heightPx: 50, scale: 2 },
    text: 'hello',
    lines: [{
      id: 'line-1',
      text: 'hello',
      confidence: 0.9,
      boundingBox: { x: 1, y: 2, width: 40, height: 10 },
      polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
    }],
    metrics: {
      workerStartupMs: 1,
      modelStartupMs: 2,
      rasterMs: 3,
      detectionMs: 4,
      recognitionMs: 5,
      totalOcrMs: 9,
    },
    warnings: [],
  };
}

test('engine and result v1 contracts accept validated JSON', () => {
  assert.equal(assertOcrEngineV1(engine()).schemaVersion, 1);
  assert.equal(assertOcrResultV1(result()).text, 'hello');
});

test('result v1 rejects unknown fields and out-of-bounds boxes', () => {
  const invalid = result();
  invalid.futureField = true;
  invalid.lines[0].boundingBox.width = 150;
  const validation = validateOcrResultV1(invalid);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.includes('futureField')));
  assert.ok(validation.issues.some((issue) => issue.includes('exceeds source width')));
});

test('engine contract explicitly forbids PDF writing', () => {
  assert.equal(assertOcrEngineV1(engine()).capabilities.pdfWriting, false);
});
