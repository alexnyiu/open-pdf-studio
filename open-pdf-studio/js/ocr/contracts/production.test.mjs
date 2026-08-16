import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OCR_CONTRACT_LIMITS,
  OCR_CURRENT_SCHEMA_VERSION,
  OCR_ENGINE_CONTRACT,
  OCR_JOB_CONTRACT,
  OCR_MODEL_PACK_CONTRACT,
  OCR_PROGRESS_CONTRACT,
  OCR_RESULT_CONTRACT,
  assertCompatibleOcrModelPack,
  assertOcrJobV1,
  assertOcrModelPackV1,
  assertOcrProgressV1,
  assertOcrResultV2,
  migrateOcrEngineToCurrent,
  migrateOcrResultToCurrent,
  modelPackIdentity,
  validateOcrJobV1,
  validateOcrProgressV1,
  validateOcrResultV2,
} from './production.js';
import { assertOcrResultV1, validateOcrResultV1 } from './v1.js';

const MANIFEST_URL = new URL('../../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url);

async function modelPack() {
  return JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
}

function phaseAEngine() {
  return {
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: 1,
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    adapterVersion: '0.1.0',
    provider: 'PaddleOCR',
    model: {
      family: 'PP-OCRv6',
      tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx',
      recognition: 'PP-OCRv6_small_rec_onnx',
    },
    runtime: {
      name: 'onnxruntime-web',
      version: '1.27.0',
      executionProvider: 'wasm',
      offline: true,
    },
    capabilities: {
      textDetection: true,
      textRecognition: true,
      wordBoxes: false,
      pdfWriting: false,
    },
  };
}

function phaseAResult() {
  return {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 1,
    requestId: 'job-1',
    engine: phaseAEngine(),
    source: {
      kind: 'pdf-page',
      path: '/fixture.pdf',
      pageIndex: 0,
      widthPx: 100,
      heightPx: 50,
      scale: 2,
    },
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
    warnings: ['Rotated text is not qualified.'],
  };
}

async function migratedResult() {
  return migrateOcrResultToCurrent(phaseAResult(), {
    modelPack: await modelPack(),
    documentId: 'document-1',
    pageId: 'page-1',
  });
}

async function productionResult() {
  const result = await migratedResult();
  result.engine.capabilities.wordResults = true;
  result.engine.capabilities.alternatives = true;
  result.engine.capabilities.languageMetadata = true;
  result.engine.capabilities.writingDirectionMetadata = true;
  result.engine.capabilities.preprocessingMetadata = true;
  const line = result.blocks[0].lines[0];
  line.words = [{
    id: 'word-1',
    text: 'hello',
    confidence: 0.88,
    alternatives: [{ text: 'hullo', confidence: 0.2 }],
    language: { tag: 'en', source: 'requested' },
  }];
  line.alternatives = [{ text: 'hullo', confidence: 0.2 }];
  line.language = { tag: 'en', source: 'engine', confidence: 0.95 };
  line.writingDirection = 'ltr';
  result.languages = [{ tag: 'en', source: 'engine', confidence: 0.95 }];
  result.unsupportedContentReasons = [{
    code: 'rotated-text',
    message: 'Rotated text requires review.',
    polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
  }];
  result.preprocessing = {
    status: 'applied',
    operations: [{ kind: 'deskew', applied: true, value: 0.5, unit: 'degrees' }],
  };
  result.pageTransform = {
    sourceSpace: 'ocr-image-pixels',
    targetSpace: 'pdf-page-points',
    matrix: [0.5, 0, 0, 0.5, 0, 0],
    inverseMatrix: [2, 0, 0, 2, 0, 0],
    sourceSize: { width: 100, height: 50 },
    targetSize: { width: 50, height: 25 },
    rotationDegrees: 0,
  };
  result.reviewCorrections = [{
    id: 'correction-1',
    target: { kind: 'line', id: 'line-1' },
    originalText: 'hello',
    correctedText: 'Hello',
    status: 'accepted',
    createdAt: '2026-08-16T12:00:00Z',
  }];
  result.visibleEditRegions = [{
    id: 'edit-region-1',
    lineIds: ['line-1'],
    polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
    eligibility: 'unknown',
    background: 'unknown',
    status: 'candidate',
    unsupportedReasons: [],
  }];
  return result;
}

function job(packIdentity) {
  return {
    contract: OCR_JOB_CONTRACT,
    schemaVersion: 1,
    jobId: 'job-1',
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    modelPack: packIdentity,
    document: {
      id: 'document-1',
      fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) },
      pageCount: 2,
    },
    pages: [
      { id: 'page-1', index: 0, status: 'queued', attempts: 0 },
      { id: 'page-2', index: 1, status: 'queued', attempts: 0 },
    ],
    options: { languages: ['en'], includeWords: false },
    createdAt: '2026-08-16T12:00:00Z',
    updatedAt: '2026-08-16T12:00:00Z',
  };
}

function progress() {
  return {
    contract: OCR_PROGRESS_CONTRACT,
    schemaVersion: 1,
    jobId: 'job-1',
    documentId: 'document-1',
    pageId: 'page-1',
    pageIndex: 0,
    pageStatus: 'recognizing',
    stage: 'recognizing',
    completedPages: 0,
    totalPages: 2,
    fraction: 0.25,
    timestamp: '2026-08-16T12:00:01Z',
  };
}

test('versioned production JSON schemas are present and retain the existing contract lineage', async () => {
  const names = [
    'engine.v2.schema.json',
    'result.v2.schema.json',
    'model-pack.v1.schema.json',
    'job.v1.schema.json',
    'progress.v1.schema.json',
  ];
  const schemas = await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'))));
  assert.equal(schemas[0].properties.contract.const, OCR_ENGINE_CONTRACT);
  assert.equal(schemas[0].properties.schemaVersion.const, OCR_CURRENT_SCHEMA_VERSION);
  assert.equal(schemas[1].properties.contract.const, OCR_RESULT_CONTRACT);
  assert.ok(schemas[1].$defs.line.required.includes('polygon'));
  assert.equal(schemas[1].$defs.word.required.includes('polygon'), false);
  assert.equal(schemas[2].properties.contract.const, OCR_MODEL_PACK_CONTRACT);
});

test('the committed macOS model pack is complete and compatible with both macOS architectures', async () => {
  const pack = assertOcrModelPackV1(await modelPack());
  const engine = phaseAEngine();
  assert.equal(assertCompatibleOcrModelPack(pack, engine, { platform: 'darwin', architecture: 'arm64' }), pack);
  assert.equal(assertCompatibleOcrModelPack(pack, engine, { platform: 'macos', architecture: 'x64' }), pack);
});

test('Phase A result v1 remains valid and migrates without fabricating words or word geometry', async () => {
  const legacy = assertOcrResultV1(phaseAResult());
  const current = await migratedResult();
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.engine.schemaVersion, 2);
  assert.equal(current.document.id, 'document-1');
  assert.equal(current.page.id, 'page-1');
  assert.deepEqual(current.blocks[0].lines[0].polygon, legacy.lines[0].polygon);
  assert.equal(Object.hasOwn(current.blocks[0].lines[0], 'words'), false);
  assert.equal(current.engine.capabilities.wordResults, false);
  assert.equal(current.engine.capabilities.wordPolygons, false);
});

test('production v2 accepts blocks, optional geometry-free words, alternatives, language, transforms, review, and edit regions', async () => {
  const result = await productionResult();
  assert.equal(assertOcrResultV2(result), result);
  assert.equal(Object.hasOwn(result.blocks[0].lines[0].words[0], 'polygon'), false);
});

test('line polygons are mandatory while word polygons remain optional and validated only when present', async () => {
  const result = await productionResult();
  const missingLinePolygon = structuredClone(result);
  delete missingLinePolygon.blocks[0].lines[0].polygon;
  assert.equal(validateOcrResultV2(missingLinePolygon).ok, false);

  const noWordPolygon = structuredClone(result);
  assert.equal(validateOcrResultV2(noWordPolygon).ok, true);

  const malformedWordPolygon = structuredClone(result);
  malformedWordPolygon.engine.capabilities.wordPolygons = true;
  malformedWordPolygon.blocks[0].lines[0].words[0].polygon = [[1, 1], [2, 2], [3, 3]];
  assert.ok(validateOcrResultV2(malformedWordPolygon).issues.some((issue) => issue.includes('words[0].polygon')));
});

test('runtime validation rejects malformed, non-finite, self-intersecting, and out-of-page polygons', async () => {
  const mutations = [
    (polygon) => polygon.splice(0, polygon.length, [1, 1], [2, 2], [3, 3]),
    (polygon) => { polygon[0][0] = Number.NaN; },
    (polygon) => { polygon[0][1] = Number.POSITIVE_INFINITY; },
    (polygon) => polygon.splice(0, polygon.length, [1, 1], [10, 10], [1, 10], [10, 1]),
    (polygon) => { polygon[1][0] = 101; },
  ];
  for (const mutate of mutations) {
    const result = await productionResult();
    mutate(result.blocks[0].lines[0].polygon);
    const validation = validateOcrResultV2(result);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((issue) => issue.includes('polygon')));
  }
});

test('runtime validation rejects invalid confidence and invalid Unicode everywhere they can enter reviewable text', async () => {
  const confidenceMutations = [
    (result) => { result.blocks[0].lines[0].confidence = -0.1; },
    (result) => { result.blocks[0].lines[0].words[0].confidence = 1.1; },
    (result) => { result.blocks[0].lines[0].alternatives[0].confidence = Number.NaN; },
  ];
  for (const mutate of confidenceMutations) {
    const result = await productionResult();
    mutate(result);
    assert.equal(validateOcrResultV2(result).ok, false);
  }

  const unicodeMutations = [
    (result) => { result.blocks[0].lines[0].text = '\ud800'; },
    (result) => { result.warnings[0].message = '\udfff'; },
    (result) => { result.reviewCorrections[0].correctedText = '\ud800'; },
  ];
  for (const mutate of unicodeMutations) {
    const result = await productionResult();
    mutate(result);
    const validation = validateOcrResultV2(result);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((issue) => issue.includes('valid Unicode')));
  }
});

test('Phase A v1 validation gains the same malformed-polygon and Unicode guards', () => {
  const invalidPolygon = phaseAResult();
  invalidPolygon.lines[0].polygon = [[1, 1], [2, 2], [3, 3], [4, 4]];
  assert.equal(validateOcrResultV1(invalidPolygon).ok, false);
  const invalidUnicode = phaseAResult();
  invalidUnicode.text = '\ud800';
  assert.ok(validateOcrResultV1(invalidUnicode).issues.some((issue) => issue.includes('valid Unicode')));
});

test('oversized results are rejected before they can cross the production boundary', async () => {
  const result = await productionResult();
  result.text = 'x'.repeat(OCR_CONTRACT_LIMITS.maxResultBytes);
  const validation = validateOcrResultV2(result);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.includes('serialized UTF-8 bytes')));
});

test('unsupported schema versions and missing migration identity are rejected explicitly', async () => {
  const pack = await modelPack();
  const packIdentity = modelPackIdentity(pack);
  const result = phaseAResult();
  result.schemaVersion = 99;
  assert.throws(
    () => migrateOcrResultToCurrent(result, { modelPack: pack, documentId: 'document-1', pageId: 'page-1' }),
    /unsupported schemaVersion 99/,
  );
  const engine = phaseAEngine();
  engine.schemaVersion = 99;
  assert.throws(() => migrateOcrEngineToCurrent(engine, { modelPack: pack }), /unsupported schemaVersion 99/);
  assert.throws(
    () => migrateOcrResultToCurrent(phaseAResult(), { modelPack: pack }),
    /migration.documentId|migration.pageId/,
  );

  const unsupportedPack = structuredClone(pack);
  unsupportedPack.schemaVersion = 99;
  assert.throws(() => assertOcrModelPackV1(unsupportedPack), /schemaVersion must be 1/);
  const unsupportedJob = job(packIdentity);
  unsupportedJob.schemaVersion = 99;
  assert.throws(() => assertOcrJobV1(unsupportedJob), /schemaVersion must be 1/);
  const unsupportedProgress = progress();
  unsupportedProgress.schemaVersion = 99;
  assert.throws(() => assertOcrProgressV1(unsupportedProgress), /schemaVersion must be 1/);
});

test('missing and incompatible model metadata are rejected', async () => {
  const pack = await modelPack();
  const missing = structuredClone(pack);
  delete missing.engineCompatibility;
  assert.throws(() => assertOcrModelPackV1(missing), /engineCompatibility/);

  const resultMissingPack = await migratedResult();
  delete resultMissingPack.engine.modelPack;
  assert.throws(() => assertOcrResultV2(resultMissingPack), /modelPack/);

  const wrongEngine = structuredClone(pack);
  wrongEngine.engineCompatibility.engineId = 'different-engine';
  assert.throws(() => assertCompatibleOcrModelPack(wrongEngine, phaseAEngine()), /incompatible/);

  assert.throws(
    () => assertCompatibleOcrModelPack(pack, phaseAEngine(), { platform: 'linux' }),
    /does not support platform/,
  );
  assert.throws(
    () => assertCompatibleOcrModelPack(pack, phaseAEngine(), { architecture: 'riscv64' }),
    /does not support architecture/,
  );
});

test('job and progress contracts preserve document/page identity and enforce page status', async () => {
  const packIdentity = modelPackIdentity(await modelPack());
  const validJob = job(packIdentity);
  assert.equal(assertOcrJobV1(validJob), validJob);
  assert.equal(assertOcrProgressV1(progress()).stage, 'recognizing');

  const duplicatePage = structuredClone(validJob);
  duplicatePage.pages[1].id = duplicatePage.pages[0].id;
  assert.equal(validateOcrJobV1(duplicatePage).ok, false);

  const invalidStatus = structuredClone(validJob);
  invalidStatus.pages[0].status = 'scheduled';
  assert.ok(validateOcrJobV1(invalidStatus).issues.some((issue) => issue.includes('status')));

  const invalidProgress = progress();
  invalidProgress.pageId = null;
  invalidProgress.fraction = Number.POSITIVE_INFINITY;
  const progressValidation = validateOcrProgressV1(invalidProgress);
  assert.equal(progressValidation.ok, false);
  assert.ok(progressValidation.issues.some((issue) => issue.includes('pageId and pageIndex')));
  assert.ok(progressValidation.issues.some((issue) => issue.includes('finite number')));
});
