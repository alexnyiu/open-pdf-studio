import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OCR_CONTRACT_LIMITS,
  OCR_CROPPED_DISPLAY_PDF_SPACE,
  OCR_CURRENT_SCHEMA_VERSION,
  OCR_DOCUMENT_STATE_CONTRACT,
  OCR_ENGINE_GEOMETRY_SPACE,
  OCR_ENGINE_CONTRACT,
  OCR_JOB_CONTRACT,
  OCR_MODEL_PACK_CONTRACT,
  OCR_NATIVE_JOB_CONTRACT,
  OCR_NATIVE_LIMITS,
  OCR_PAGE_GEOMETRY_CONTRACT,
  OCR_PDF_USER_SPACE,
  OCR_PREPROCESSED_RASTER_SPACE,
  OCR_PROGRESS_CONTRACT,
  OCR_PROGRESS_STAGES,
  OCR_RESULT_CONTRACT,
  OCR_SOURCE_RASTER_SPACE,
  OCR_WORKER_MESSAGE_CONTRACT,
  OCR_WORKER_MESSAGE_SCHEMA_VERSION,
  assertCompatibleOcrModelPack,
  assertInstallableOcrModelPack,
  assertOcrDocumentStateV1,
  assertOcrJobV1,
  assertOcrModelPackV1,
  assertOcrPageGeometryV1,
  assertOcrProgressV1,
  assertOcrResultV2,
  applyHomography,
  createHomographyOperation,
  createOcrPageGeometryV1,
  createOcrPageGeometryFromPdfiumV1,
  deriveAxisAlignedBounds,
  mapOcrPageGeometryBaseline,
  mapOcrPageGeometryPoint,
  mapOcrPageGeometryPolygon,
  migrateOcrEngineToCurrent,
  migrateOcrResultToCurrent,
  migrateUnpublishedOcrResultV2ToCurrent,
  modelPackIdentity,
  validateInstallableOcrModelPack,
  validateOcrDocumentStateV1,
  validateOcrEngineV2,
  validateOcrJobV1,
  validateOcrModelPackV1,
  validateNativeOcrJobEnvelopeV1,
  validateOcrPageGeometryV1,
  validateOcrProgressV1,
  validateOcrResultV2,
  validateOcrResultMatchesJob,
  validateOcrWorkerMessageV1,
  validatePdfiumPageGeometryV1,
} from './production.js';
import { validateAgainstJsonSchema } from './schema-validation.js';
import { assertOcrResultV1, validateOcrResultV1 } from './v1.js';

const MANIFEST_URL = new URL('../../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url);
const SCHEMA_NAMES = [
  'common.schema.json',
  'engine.v2.schema.json',
  'result.v2.schema.json',
  'model-pack.v1.schema.json',
  'job.v1.schema.json',
  'progress.v1.schema.json',
  'document-state.v1.schema.json',
  'page-geometry.v1.schema.json',
  'worker-message.v1.schema.json',
  'native-job.v1.schema.json',
];
const schemas = new Map(await Promise.all(SCHEMA_NAMES.map(async (name) => [
  name,
  JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8')),
])));
const schemaRegistry = [...schemas.values()];
const pack = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));

function hash(character) {
  return { algorithm: 'sha256', value: character.repeat(64) };
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
    requestId: 'request-1',
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

function migrationOptions(overrides = {}) {
  return {
    modelPack: pack,
    documentId: 'document-1',
    documentFingerprint: hash('a'),
    documentRevision: 3,
    documentGeneration: 'document-generation-3',
    documentPageCount: 2,
    pageId: 'page-1',
    pageRevision: 5,
    sourceRasterId: 'raster-1',
    sourceRasterFingerprint: hash('b'),
    rasterDpi: 144,
    recognitionConfigurationHash: hash('c'),
    ...overrides,
  };
}

function currentResult() {
  return migrateOcrResultToCurrent(phaseAResult(), migrationOptions());
}

function job() {
  const result = currentResult();
  return {
    contract: OCR_JOB_CONTRACT,
    schemaVersion: 1,
    jobId: result.jobId,
    requestId: result.requestId,
    engineId: result.engine.engineId,
    modelPack: structuredClone(result.engine.modelPack),
    document: structuredClone(result.document),
    page: {
      id: result.page.id,
      index: result.page.index,
      revision: result.page.revision,
      sourceRaster: structuredClone(result.sourceRaster),
    },
    recognitionConfigurationHash: structuredClone(result.recognitionConfigurationHash),
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: 144,
      maximumPixels: 10_000,
      maximumSide: 100,
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: true,
      forceRerun: false,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'normal', execution: 'one-page-child' },
    createdAt: '2026-08-16T12:00:00Z',
  };
}

function progress(stage = 'recognizing') {
  const result = currentResult();
  const terminalComplete = ['completed', 'partial', 'unsupported'].includes(stage);
  return {
    contract: OCR_PROGRESS_CONTRACT,
    schemaVersion: 1,
    eventId: `event-${stage}`,
    sequence: 4,
    jobId: result.jobId,
    requestId: result.requestId,
    documentId: result.document.id,
    documentRevision: result.document.revision,
    documentGeneration: result.document.generation,
    pageId: result.page.id,
    pageIndex: result.page.index,
    pageRevision: result.page.revision,
    sourceRasterId: result.sourceRaster.id,
    recognitionConfigurationHash: structuredClone(result.recognitionConfigurationHash),
    stage,
    fraction: terminalComplete ? 1 : 0.5,
    error: stage === 'failed'
      ? { code: 'engine-failed', message: 'Recognition failed.', retryable: true }
      : null,
    timestamp: '2026-08-16T12:00:01Z',
  };
}

function workerMessage(type, payload = {}) {
  return {
    contract: OCR_WORKER_MESSAGE_CONTRACT,
    schemaVersion: OCR_WORKER_MESSAGE_SCHEMA_VERSION,
    type,
    ...payload,
  };
}

function recognizeWorkerMessage() {
  const value = job();
  return workerMessage('recognize', {
    requestId: value.requestId,
    job: value,
    image: {
      width: value.page.sourceRaster.widthPx,
      height: value.page.sourceRaster.heightPx,
      rgba: new ArrayBuffer(value.page.sourceRaster.widthPx * value.page.sourceRaster.heightPx * 4),
    },
    rasterMs: 3,
    workerStartupMs: 2,
  });
}

function nativeJobEnvelope() {
  const value = job();
  const widthPx = value.page.sourceRaster.widthPx;
  const heightPx = value.page.sourceRaster.heightPx;
  return {
    contract: OCR_NATIVE_JOB_CONTRACT,
    schemaVersion: 1,
    job: value,
    raster: {
      format: 'rgba8',
      widthPx,
      heightPx,
      rowBytes: widthPx * 4,
      byteLength: widthPx * heightPx * 4,
    },
    rasterMs: 3,
    preprocessingRequest: structuredClone(value.recognitionOptions.preprocessing),
    limits: {
      maxWidthPx: Math.min(value.recognitionOptions.maximumSide, OCR_NATIVE_LIMITS.maxWidthPx),
      maxHeightPx: Math.min(value.recognitionOptions.maximumSide, OCR_NATIVE_LIMITS.maxHeightPx),
      maxPixels: Math.min(value.recognitionOptions.maximumPixels, OCR_NATIVE_LIMITS.maxPixels),
      maxMetadataBytes: OCR_NATIVE_LIMITS.maxMetadataBytes,
      maxRasterBytes: OCR_NATIVE_LIMITS.maxRasterBytes,
      maxResultBytes: OCR_NATIVE_LIMITS.maxResultBytes,
      timeoutMs: value.recognitionOptions.timeoutMs,
    },
    resultFile: { id: 'native-result-1' },
  };
}

function resultRef(result) {
  return {
    jobId: result.jobId,
    requestId: result.requestId,
    engineId: result.engine.engineId,
    modelPack: structuredClone(result.engine.modelPack),
    documentRevision: result.document.revision,
    documentGeneration: result.document.generation,
    pageRevision: result.page.revision,
    sourceRasterId: result.sourceRaster.id,
    sourceRasterFingerprint: structuredClone(result.sourceRaster.fingerprint),
    recognitionConfigurationHash: structuredClone(result.recognitionConfigurationHash),
  };
}

function documentState() {
  const result = currentResult();
  return {
    contract: OCR_DOCUMENT_STATE_CONTRACT,
    schemaVersion: 1,
    stateId: 'ocr-state-1',
    document: structuredClone(result.document),
    stateRevision: 2,
    pages: [{
      id: result.page.id,
      index: result.page.index,
      revision: result.page.revision,
      resultRef: resultRef(result),
      applicationStatus: 'idle',
      reviewStatus: 'in-review',
      corrections: [{
        id: 'correction-1',
        target: { kind: 'line', id: 'line-1' },
        originalText: 'hello',
        correctedText: 'Hello',
        status: 'accepted',
        createdAt: '2026-08-16T12:00:00Z',
        updatedAt: '2026-08-16T12:01:00Z',
      }],
      estimatedBaselines: [{
        id: 'estimated-baseline-1',
        lineId: 'line-1',
        baseline: {
          status: 'provided',
          coordinateSpace: 'source-raster-pixels',
          provenance: 'estimated',
          points: [[1, 11], [41, 11]],
        },
        createdAt: '2026-08-16T12:00:00Z',
        updatedAt: '2026-08-16T12:00:00Z',
      }],
      visibleEditRegions: [{
        id: 'edit-region-1',
        lineIds: ['line-1'],
        polygon: {
          coordinateSpace: 'source-raster-pixels',
          points: [[1, 2], [41, 2], [41, 12], [1, 12]],
        },
        eligibility: 'unknown',
        background: 'unknown',
        status: 'candidate',
        unsupportedReasons: [],
      }],
    }],
    undo: { generation: 1, undoDepth: 1, redoDepth: 0, lastOperationId: 'operation-1' },
    updatedAt: '2026-08-16T12:01:00Z',
  };
}

function pageGeometry() {
  const result = currentResult();
  return createOcrPageGeometryV1({
    geometryId: 'geometry-1',
    document: structuredClone(result.document),
    page: { id: result.page.id, index: result.page.index, revision: result.page.revision },
    boxes: {
      mediaBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 50, height: 25 },
      cropBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 50, height: 25 },
      bleedBox: null,
      trimBox: null,
      artBox: null,
    },
    userUnit: 1,
    intrinsicRotationDegrees: 0,
    applicationRotationDegrees: 0,
    requestedDpi: 144,
    requestedScale: 2,
    sourceRaster: structuredClone(result.sourceRaster),
    annotationsExcluded: true,
    formsExcluded: false,
  });
}

function canonicalGeometry({
  media = { x: 0, y: 0, width: 612, height: 792 },
  crop = media,
  userUnit = 1,
  intrinsicRotation = 0,
  applicationRotation = 0,
  scale = 2,
  actualWidth = null,
  actualHeight = null,
  orientation = 0,
  deskew = 0,
} = {}) {
  const totalRotation = (intrinsicRotation + applicationRotation) % 360;
  const displayedWidth = (totalRotation === 90 || totalRotation === 270 ? crop.height : crop.width) * userUnit;
  const displayedHeight = (totalRotation === 90 || totalRotation === 270 ? crop.width : crop.height) * userUnit;
  const widthPx = actualWidth ?? Math.ceil(displayedWidth * scale);
  const heightPx = actualHeight ?? Math.ceil(displayedHeight * scale);
  const orientedWidth = orientation === 90 || orientation === 270 ? heightPx : widthPx;
  const orientedHeight = orientation === 90 || orientation === 270 ? widthPx : heightPx;
  const box = (value) => ({ coordinateSpace: OCR_PDF_USER_SPACE, ...value });
  return createOcrPageGeometryV1({
    geometryId: 'canonical-geometry',
    document: { id: 'document-geometry', fingerprint: hash('e'), revision: 7, generation: 'generation-7', pageCount: 3 },
    page: { id: 'page-geometry', index: 1, revision: 9 },
    boxes: { mediaBox: box(media), cropBox: box(crop), bleedBox: null, trimBox: null, artBox: null },
    userUnit,
    intrinsicRotationDegrees: intrinsicRotation,
    applicationRotationDegrees: applicationRotation,
    requestedDpi: scale * 72,
    requestedScale: scale,
    sourceRaster: {
      id: 'raster-geometry',
      fingerprint: hash('f'),
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      widthPx,
      heightPx,
      dpi: scale * 72,
    },
    annotationsExcluded: true,
    formsExcluded: false,
    preprocessing: {
      orientationDegrees: orientation,
      orientationProvenance: orientation === 0 ? 'none' : 'requested',
      deskewDegrees: deskew,
      deskewProvenance: deskew === 0 ? 'none' : 'requested',
      outputWidthPx: orientedWidth,
      outputHeightPx: orientedHeight,
    },
  });
}

function pdfiumBoundaryFromGeometry(geometry) {
  const box = (value) => value === null ? null : ({
    ...structuredClone(value), unit: 'pdf-user-unit', origin: 'pdf-user-space-zero',
  });
  const rounding = geometry.rendering.rounding;
  return {
    contract: 'open-pdf-studio.pdfium.page-geometry',
    schemaVersion: 1,
    pageIndex: geometry.page.index,
    mediaBox: box(geometry.boxes.mediaBox),
    cropBox: box(geometry.boxes.cropBox),
    bleedBox: box(geometry.boxes.bleedBox),
    trimBox: box(geometry.boxes.trimBox),
    artBox: box(geometry.boxes.artBox),
    userUnit: geometry.userUnit.value,
    userUnitProvenance: geometry.userUnit.provenance,
    intrinsicRotationDegreesClockwise: geometry.rotations.intrinsicDegreesClockwise,
    applicationRotationDegreesClockwise: geometry.rotations.applicationDegreesClockwise,
    totalRotationDegreesClockwise: geometry.rotations.totalDegreesClockwise,
    displayedPage: {
      coordinateSpace: geometry.displayedPage.coordinateSpace,
      unit: 'pdf-point',
      origin: 'displayed-crop-top-left',
      width: geometry.displayedPage.width,
      height: geometry.displayedPage.height,
    },
    raster: {
      coordinateSpace: geometry.sourceRaster.coordinateSpace,
      unit: 'pixel',
      origin: 'top-left-pixel-edge',
      requestedDpi: geometry.rendering.requested.dpi,
      requestedScale: geometry.rendering.requested.scale,
      idealWidthPx: rounding.idealWidthPx,
      idealHeightPx: rounding.idealHeightPx,
      requestedWidthPx: rounding.requestedWidthPx,
      requestedHeightPx: rounding.requestedHeightPx,
      actualWidthPx: rounding.actualWidthPx,
      actualHeightPx: rounding.actualHeightPx,
      widthDeltaPx: rounding.widthDeltaPx,
      heightDeltaPx: rounding.heightDeltaPx,
      pdfiumAdjusted: rounding.pdfiumAdjusted,
      roundingMethod: rounding.method,
      annotationsExcluded: geometry.rendering.exclusions.annotationsExcluded,
      formsExcluded: geometry.rendering.exclusions.formsExcluded,
    },
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function assertPointClose(actual, expected, tolerance = 1e-7) {
  assert.equal(actual.length, 2);
  assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= tolerance,
    `${actual.join(',')} is not within ${tolerance} of ${expected.join(',')}`);
}

function unpublishedV2Result() {
  const engine = migrateOcrEngineToCurrent(phaseAEngine(), { modelPack: pack });
  return {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 2,
    jobId: 'legacy-job-1',
    engine: {
      ...structuredClone(engine),
      modelPack: {
        contract: OCR_MODEL_PACK_CONTRACT,
        schemaVersion: 1,
        packId: pack.packId,
        packVersion: pack.packVersion,
      },
      capabilities: {
        textDetection: true,
        textRecognition: true,
        blockResults: true,
        lineResults: true,
        wordResults: false,
        linePolygons: true,
        wordPolygons: false,
        alternatives: false,
        languageMetadata: false,
        writingDirectionMetadata: false,
        preprocessingMetadata: false,
        pdfWriting: false,
      },
    },
    document: { id: 'document-1', fingerprint: hash('a') },
    page: {
      id: 'page-1',
      index: 0,
      status: 'completed',
      raster: { widthPx: 100, heightPx: 50, scale: 2 },
    },
    text: 'hello',
    blocks: [{
      id: 'block-1',
      kind: 'text',
      text: 'hello',
      confidence: 0.9,
      polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
      lines: [{
        id: 'line-1',
        text: 'hello',
        confidence: 0.9,
        polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
        boundingBox: { x: 1, y: 2, width: 40, height: 10 },
        alternatives: [],
        language: { tag: 'und', source: 'unknown' },
        writingDirection: 'unknown',
      }],
    }],
    languages: [],
    warnings: [{ code: 'phase-a-warning', message: 'Review rotation.', severity: 'warning' }],
    unsupportedContentReasons: [],
    preprocessing: { status: 'unknown', operations: [] },
    pageTransform: null,
    metrics: structuredClone(phaseAResult().metrics),
    reviewCorrections: [{
      id: 'correction-1',
      target: { kind: 'line', id: 'line-1' },
      originalText: 'hello',
      correctedText: 'Hello',
      status: 'accepted',
      createdAt: '2026-08-16T12:00:00Z',
    }],
    visibleEditRegions: [{
      id: 'edit-region-1',
      lineIds: ['line-1'],
      polygon: [[1, 2], [41, 2], [41, 12], [1, 12]],
      eligibility: 'unknown',
      background: 'unknown',
      status: 'candidate',
      unsupportedReasons: [],
    }],
  };
}

function schemaValidation(name, value) {
  return validateAgainstJsonSchema(value, schemas.get(name), { schemas: schemaRegistry });
}

function assertCorpusParity({ name, schema, validate, cases }) {
  for (const fixture of cases) {
    const runtime = validate(fixture.value);
    const schemaResult = schemaValidation(schema, fixture.value);
    assert.equal(runtime.ok, fixture.valid, `${name}/${fixture.name}: runtime ${runtime.issues.join('; ')}`);
    assert.equal(schemaResult.ok, fixture.valid, `${name}/${fixture.name}: schema ${schemaResult.issues.join('; ')}`);
    assert.equal(runtime.ok, schemaResult.ok, `${name}/${fixture.name}: runtime/schema disagreement`);
  }
}

test('production schemas retain the v1 lineage and separate immutable result, mutable state, and page geometry', () => {
  assert.equal(schemas.get('engine.v2.schema.json').properties.schemaVersion.const, OCR_CURRENT_SCHEMA_VERSION);
  const resultSchema = schemas.get('result.v2.schema.json');
  assert.equal(resultSchema.properties.contract.const, OCR_RESULT_CONTRACT);
  assert.equal(resultSchema.$defs.line.required.includes('polygon'), true);
  assert.equal(resultSchema.$defs.line.required.includes('baseline'), true);
  assert.equal(resultSchema.$defs.word.required?.includes('polygon') ?? false, false);
  assert.equal(Object.hasOwn(resultSchema.properties, 'reviewCorrections'), false);
  assert.equal(Object.hasOwn(resultSchema.properties, 'visibleEditRegions'), false);
  assert.equal(Object.hasOwn(resultSchema.properties, 'pageTransform'), false);
  assert.equal(schemas.get('document-state.v1.schema.json').properties.contract.const, OCR_DOCUMENT_STATE_CONTRACT);
  assert.equal(schemas.get('page-geometry.v1.schema.json').properties.contract.const, OCR_PAGE_GEOMETRY_CONTRACT);
});

test('the model pack names its fixed 50-language/script support and has explicit install-safety metadata', () => {
  assert.equal(assertOcrModelPackV1(pack), pack);
  assert.equal(pack.recognitionSupport.selectionMode, 'fixed-multilingual');
  assert.equal(pack.recognitionSupport.languageSelector, 'none');
  assert.equal(pack.recognitionSupport.languages.length, 50);
  assert.equal(pack.recognitionSupport.languages.includes('und'), false);
  assert.deepEqual(pack.recognitionSupport.scripts, ['Hans', 'Hant', 'Jpan', 'Latn']);
  assert.equal(pack.distribution.bundled, true);
  assert.equal(pack.distribution.downloadable, false);
  assert.equal(pack.applicationCompatibility.minimumVersion, '1.85.0');
  assert.equal(assertCompatibleOcrModelPack(pack, phaseAEngine(), { platform: 'darwin', architecture: 'arm64' }), pack);
  assert.equal(assertCompatibleOcrModelPack(pack, phaseAEngine(), { platform: 'macos', architecture: 'x64' }), pack);
  assert.equal(assertInstallableOcrModelPack(pack, phaseAEngine(), {
    platform: 'macos',
    architecture: 'arm64',
    applicationVersion: '1.85.0',
    source: 'bundled',
    trustedRootIds: [pack.trust.trustRootId],
  }), pack);
  assert.equal(validateInstallableOcrModelPack(pack, phaseAEngine(), {
    platform: 'macos',
    architecture: 'arm64',
    applicationVersion: '1.85.0',
    source: 'download',
    trustedRootIds: [pack.trust.trustRootId],
  }).ok, false);
  const identity = modelPackIdentity(pack);
  assert.deepEqual(identity.assets, {
    detection: pack.assets.detection.sha256,
    recognition: pack.assets.recognition.sha256,
    dictionary: pack.assets.dictionary.sha256,
  });
});

test('Phase A v1 remains valid and migrates without paths or fabricated recognition evidence', () => {
  const legacy = assertOcrResultV1(phaseAResult());
  const current = currentResult();
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.engine.schemaVersion, 2);
  assert.equal(current.jobId, legacy.requestId);
  assert.equal(current.requestId, legacy.requestId);
  assert.equal(Object.hasOwn(current, 'source'), false);
  assert.equal(JSON.stringify(current).includes('/fixture.pdf'), false);
  assert.deepEqual(current.lines[0].polygon.points, legacy.lines[0].polygon);
  assert.equal(current.lines[0].polygon.coordinateSpace, 'source-raster-pixels');
  assert.deepEqual(current.lines[0].baseline, {
    status: 'unavailable',
    coordinateSpace: 'source-raster-pixels',
    reason: 'engine-did-not-provide',
  });
  assert.equal(Object.hasOwn(current.lines[0], 'words'), false);
  for (const capability of [
    'lineBaselines', 'wordResults', 'wordPolygons', 'alternatives', 'languageDetection',
    'writingDirectionDetection', 'nativePdfWriting',
  ]) assert.equal(current.engine.capabilities[capability], false);
});

test('v1 migration requires every stale-result identity field', () => {
  const required = [
    'documentId', 'documentFingerprint', 'documentRevision', 'documentGeneration',
    'documentPageCount', 'pageId', 'pageRevision', 'sourceRasterId',
    'sourceRasterFingerprint', 'rasterDpi', 'recognitionConfigurationHash',
  ];
  for (const key of required) {
    const options = migrationOptions();
    delete options[key];
    assert.throws(() => migrateOcrResultToCurrent(phaseAResult(), options), /migration|validation failed/);
  }
});

test('mutable review/edit state and estimated baselines validate only in document state', () => {
  const result = currentResult();
  const state = documentState();
  assert.equal(assertOcrResultV2(result), result);
  assert.equal(assertOcrDocumentStateV1(state), state);
  assert.equal(state.pages[0].estimatedBaselines[0].baseline.provenance, 'estimated');
  const invalidResult = structuredClone(result);
  invalidResult.lines[0].baseline = structuredClone(state.pages[0].estimatedBaselines[0].baseline);
  assert.equal(validateOcrResultV2(invalidResult).ok, false);
});

test('page geometry carries boxes, UserUnit, rotations, raster identity, and an invertible complete transform', () => {
  const geometry = pageGeometry();
  assert.equal(assertOcrPageGeometryV1(geometry), geometry);
  const incomplete = structuredClone(geometry);
  delete incomplete.boxes.cropBox;
  assert.equal(validateOcrPageGeometryV1(incomplete).ok, false);
  const mismatched = structuredClone(geometry);
  mismatched.sourceRaster.widthPx = 120;
  assert.ok(validateOcrPageGeometryV1(mismatched).issues.some((issue) => issue.includes('sourceRaster')));
});

test('the strict PDFium query response materializes the canonical page geometry contract', () => {
  const expected = canonicalGeometry({
    media: { x: -20, y: -40, width: 500, height: 700 },
    crop: { x: 10, y: 30, width: 420, height: 600 },
    userUnit: 2,
    intrinsicRotation: 90,
    applicationRotation: 180,
    scale: 1.25,
    actualWidth: 1499,
    actualHeight: 1051,
  });
  const boundary = pdfiumBoundaryFromGeometry(expected);
  assert.equal(validatePdfiumPageGeometryV1(boundary).ok, true);
  const materialized = createOcrPageGeometryFromPdfiumV1(boundary, {
    geometryId: expected.geometryId,
    document: expected.document,
    page: expected.page,
    sourceRasterId: expected.sourceRaster.id,
    sourceRasterFingerprint: expected.sourceRaster.fingerprint,
  });
  assert.deepEqual(materialized, expected);
  const unknown = structuredClone(boundary);
  unknown.raster.assumedWidthPx = unknown.raster.actualWidthPx;
  assert.equal(validatePdfiumPageGeometryV1(unknown).ok, false);
  const stalePage = structuredClone(expected.page);
  stalePage.index = 0;
  assert.throws(() => createOcrPageGeometryFromPdfiumV1(boundary, {
    geometryId: expected.geometryId,
    document: expected.document,
    page: stalePage,
    sourceRasterId: expected.sourceRaster.id,
    sourceRasterFingerprint: expected.sourceRaster.fingerprint,
  }), /page.index/);
});

test('canonical page geometry golden cases cover boxes, origins, rotations, UserUnit, PDFium rounding, and preprocessing', () => {
  const cropped = canonicalGeometry({
    media: { x: -40, y: -60, width: 700, height: 900 },
    crop: { x: 10, y: 20, width: 500, height: 700 },
  });
  assert.deepEqual(cropped.boxes.mediaBox, {
    coordinateSpace: OCR_PDF_USER_SPACE, x: -40, y: -60, width: 700, height: 900,
  });
  assertPointClose(mapOcrPageGeometryPoint(
    cropped, [10, 720], OCR_PDF_USER_SPACE, OCR_CROPPED_DISPLAY_PDF_SPACE,
  ), [0, 0]);

  const rotation90 = canonicalGeometry({
    media: { x: -25, y: -50, width: 300, height: 500 },
    crop: { x: -10, y: -20, width: 200, height: 400 },
    intrinsicRotation: 90,
  });
  assert.deepEqual([rotation90.displayedPage.width, rotation90.displayedPage.height], [400, 200]);
  assertPointClose(mapOcrPageGeometryPoint(
    rotation90, [-10, -20], OCR_PDF_USER_SPACE, OCR_CROPPED_DISPLAY_PDF_SPACE,
  ), [0, 0]);

  const rotation270 = canonicalGeometry({
    media: { x: -25, y: -50, width: 300, height: 500 },
    crop: { x: -10, y: -20, width: 200, height: 400 },
    intrinsicRotation: 180,
    applicationRotation: 90,
  });
  assert.equal(rotation270.rotations.totalDegreesClockwise, 270);
  assertPointClose(mapOcrPageGeometryPoint(
    rotation270, [190, 380], OCR_PDF_USER_SPACE, OCR_CROPPED_DISPLAY_PDF_SPACE,
  ), [0, 0]);

  const scaledAndRounded = canonicalGeometry({
    media: { x: 0, y: 0, width: 101.25, height: 202.5 },
    crop: { x: 0, y: 0, width: 101.25, height: 202.5 },
    userUnit: 2.5,
    scale: 1.3,
    actualWidth: 330,
    actualHeight: 659,
  });
  assert.deepEqual([scaledAndRounded.displayedPage.width, scaledAndRounded.displayedPage.height], [253.125, 506.25]);
  assert.equal(scaledAndRounded.rendering.rounding.requestedWidthPx, 330);
  assert.equal(scaledAndRounded.rendering.rounding.requestedHeightPx, 659);
  assert.equal(scaledAndRounded.rendering.rounding.pdfiumAdjusted, false);
  const adjusted = canonicalGeometry({
    media: { x: 0, y: 0, width: 101.25, height: 202.5 },
    userUnit: 2.5,
    scale: 1.3,
    actualWidth: 329,
    actualHeight: 660,
  });
  assert.equal(adjusted.rendering.rounding.pdfiumAdjusted, true);
  assert.equal(adjusted.rendering.rounding.actualWidthPx, 329);

  const preprocessed = canonicalGeometry({ orientation: 90, deskew: 3.75 });
  assert.equal(preprocessed.preprocessing.orientation.degreesClockwise, 90);
  assert.equal(preprocessed.preprocessing.deskew.degreesClockwise, 3.75);
  assert.equal(preprocessed.transformChain.operations.length, 5);
  for (const operation of preprocessed.transformChain.operations) {
    assert.equal(operation.matrix.length, 9);
    assert.equal(operation.inverseMatrix.length, 9);
  }
  const enginePoint = [123.5, 456.25];
  const pdfPoint = mapOcrPageGeometryPoint(
    preprocessed, enginePoint, OCR_ENGINE_GEOMETRY_SPACE, OCR_PDF_USER_SPACE,
  );
  assertPointClose(mapOcrPageGeometryPoint(
    preprocessed, pdfPoint, OCR_PDF_USER_SPACE, OCR_ENGINE_GEOMETRY_SPACE,
  ), enginePoint, 1e-6);
});

test('homography primitives preserve perspective capacity and reject singular or unstable matrices', () => {
  const operation = createHomographyOperation({
    id: 'future-perspective-correction',
    kind: 'perspective-correction',
    fromSpace: OCR_SOURCE_RASTER_SPACE,
    toSpace: OCR_PREPROCESSED_RASTER_SPACE,
    matrix: [1, 0.02, 5, -0.01, 1, 7, 0.0002, -0.0001, 1],
    provenance: { source: 'ocr-preprocessing', detail: 'deterministic perspective fixture' },
  });
  const point = [321.5, 127.25];
  const restored = applyHomography(operation.inverseMatrix, applyHomography(operation.matrix, point));
  assertPointClose(restored, point, 1e-8);

  const base = {
    id: 'invalid-transform',
    kind: 'test',
    fromSpace: OCR_SOURCE_RASTER_SPACE,
    toSpace: OCR_PREPROCESSED_RASTER_SPACE,
    provenance: { source: 'ocr-preprocessing', detail: 'invalid fixture' },
  };
  assert.throws(() => createHomographyOperation({
    ...base,
    matrix: [1, 0, 0, 0, 0, 0, 0, 0, 1],
  }), /singular|unstable/);
  assert.throws(() => createHomographyOperation({
    ...base,
    matrix: [1e-9, 0, 0, 0, 1e9, 0, 0, 0, 1],
  }), /unstable/);
});

test('line quadrilaterals and optional baselines map through the same authoritative chain', () => {
  const geometry = canonicalGeometry({
    media: { x: -20, y: 5, width: 400, height: 600 },
    crop: { x: 10, y: 25, width: 350, height: 500 },
    userUnit: 1.5,
    intrinsicRotation: 90,
    orientation: 270,
    deskew: -2.25,
  });
  const line = {
    coordinateSpace: OCR_ENGINE_GEOMETRY_SPACE,
    points: [[40, 50], [260, 45], [265, 90], [42, 95]],
  };
  const baseline = {
    status: 'provided',
    coordinateSpace: OCR_ENGINE_GEOMETRY_SPACE,
    provenance: 'engine',
    points: [[45, 84], [258, 79]],
  };
  const pdfLine = mapOcrPageGeometryPolygon(geometry, line, OCR_PDF_USER_SPACE);
  const pdfBaseline = mapOcrPageGeometryBaseline(geometry, baseline, OCR_PDF_USER_SPACE);
  assert.equal(pdfLine.coordinateSpace, OCR_PDF_USER_SPACE);
  assert.equal(pdfLine.points.length, 4);
  assert.equal(pdfBaseline.coordinateSpace, OCR_PDF_USER_SPACE);
  assert.equal(pdfBaseline.points.length, 2);
  const restoredLine = mapOcrPageGeometryPolygon(geometry, pdfLine, OCR_ENGINE_GEOMETRY_SPACE);
  const restoredBaseline = mapOcrPageGeometryBaseline(geometry, pdfBaseline, OCR_ENGINE_GEOMETRY_SPACE);
  restoredLine.points.forEach((point, index) => assertPointClose(point, line.points[index], 1e-6));
  restoredBaseline.points.forEach((point, index) => assertPointClose(point, baseline.points[index], 1e-6));
  const derived = deriveAxisAlignedBounds(pdfLine);
  assert.equal(derived.coordinateSpace, OCR_PDF_USER_SPACE);
  assert.ok(derived.width > 0 && derived.height > 0);
});

test('seeded randomized OCR-pixel to PDF round trips stay below 0.25 PDF points', () => {
  const random = seededRandom(0x0c4a11);
  const rotations = [0, 90, 180, 270];
  const userUnits = [0.25, 0.5, 1, 1.5, 2, 4, 10];
  for (let index = 0; index < 400; index += 1) {
    const cropWidth = 20 + random() * 1_980;
    const cropHeight = 20 + random() * 1_980;
    const cropX = -500 + random() * 1_000;
    const cropY = -500 + random() * 1_000;
    const padding = 1 + random() * 100;
    const userUnit = userUnits[Math.floor(random() * userUnits.length)];
    const intrinsicRotation = rotations[Math.floor(random() * rotations.length)];
    const applicationRotation = rotations[Math.floor(random() * rotations.length)];
    const orientation = rotations[Math.floor(random() * rotations.length)];
    const scale = 0.5 + random() * 3.5;
    const totalRotation = (intrinsicRotation + applicationRotation) % 360;
    const displayedWidth = (totalRotation === 90 || totalRotation === 270 ? cropHeight : cropWidth) * userUnit;
    const displayedHeight = (totalRotation === 90 || totalRotation === 270 ? cropWidth : cropHeight) * userUnit;
    const actualWidth = Math.max(1, Math.ceil(displayedWidth * scale) + Math.floor(random() * 3) - 1);
    const actualHeight = Math.max(1, Math.ceil(displayedHeight * scale) + Math.floor(random() * 3) - 1);
    const geometry = canonicalGeometry({
      media: {
        x: cropX - padding,
        y: cropY - padding,
        width: cropWidth + padding * 2,
        height: cropHeight + padding * 2,
      },
      crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
      userUnit,
      intrinsicRotation,
      applicationRotation,
      scale,
      actualWidth,
      actualHeight,
      orientation,
      deskew: -8 + random() * 16,
    });
    const point = [random() * geometry.engineGeometry.width, random() * geometry.engineGeometry.height];
    const pdf = mapOcrPageGeometryPoint(geometry, point, OCR_ENGINE_GEOMETRY_SPACE, OCR_PDF_USER_SPACE);
    const roundTrip = mapOcrPageGeometryPoint(geometry, pdf, OCR_PDF_USER_SPACE, OCR_ENGINE_GEOMETRY_SPACE);
    const displayOriginal = mapOcrPageGeometryPoint(geometry, point, OCR_ENGINE_GEOMETRY_SPACE, OCR_CROPPED_DISPLAY_PDF_SPACE);
    const displayRoundTrip = mapOcrPageGeometryPoint(geometry, roundTrip, OCR_ENGINE_GEOMETRY_SPACE, OCR_CROPPED_DISPLAY_PDF_SPACE);
    const errorInPdfPoints = Math.hypot(
      displayRoundTrip[0] - displayOriginal[0],
      displayRoundTrip[1] - displayOriginal[1],
    );
    assert.ok(errorInPdfPoints < 0.25, `seeded case ${index} round-trip error ${errorInPdfPoints} PDF points`);
  }
});

test('unpublished mixed-state result v2 migrates into result, document state, and optional full page geometry', () => {
  const legacy = unpublishedV2Result();
  assert.throws(() => migrateOcrResultToCurrent(legacy, migrationOptions()), /migrateUnpublishedOcrResultV2ToCurrent/);
  const migrated = migrateUnpublishedOcrResultV2ToCurrent(legacy, migrationOptions({
    requestId: 'legacy-request-1',
    stateId: 'state-from-legacy-v2',
    stateRevision: 0,
    stateUpdatedAt: '2026-08-16T12:02:00Z',
  }));
  assert.equal(Object.hasOwn(migrated.result, 'reviewCorrections'), false);
  assert.equal(Object.hasOwn(migrated.result, 'visibleEditRegions'), false);
  assert.equal(Object.hasOwn(migrated.result, 'pageTransform'), false);
  assert.equal(migrated.documentState.pages[0].corrections.length, 1);
  assert.equal(migrated.documentState.pages[0].visibleEditRegions.length, 1);
  assert.equal(migrated.documentState.pages[0].estimatedBaselines.length, 0);
  assert.equal(migrated.result.lines[0].baseline.status, 'unavailable');
  assert.equal(migrated.pageGeometry, null);

  const withIncompleteTransform = unpublishedV2Result();
  withIncompleteTransform.pageTransform = {
    sourceSpace: 'ocr-image-pixels',
    targetSpace: 'pdf-page-points',
    matrix: [0.5, 0, 0, 0.5, 0, 0],
    inverseMatrix: [2, 0, 0, 2, 0, 0],
    sourceSize: { width: 100, height: 50 },
    targetSize: { width: 50, height: 25 },
    rotationDegrees: 0,
  };
  const options = migrationOptions({
    requestId: 'legacy-request-1',
    stateId: 'state-from-legacy-v2',
    stateRevision: 0,
    stateUpdatedAt: '2026-08-16T12:02:00Z',
  });
  assert.throws(
    () => migrateUnpublishedOcrResultV2ToCurrent(withIncompleteTransform, options),
    /full pageGeometry contract/,
  );
  const withGeometry = migrateUnpublishedOcrResultV2ToCurrent(withIncompleteTransform, {
    ...options,
    pageGeometry: pageGeometry(),
  });
  assert.equal(withGeometry.pageGeometry.geometryId, 'geometry-1');
});

test('unpublished v2 migration rejects recognition evidence the current adapter did not emit', () => {
  const legacy = unpublishedV2Result();
  legacy.blocks[0].lines[0].alternatives.push({ text: 'hullo', confidence: 0.2 });
  assert.throws(() => migrateUnpublishedOcrResultV2ToCurrent(legacy, migrationOptions({
    stateId: 'state-1',
    stateRevision: 0,
    stateUpdatedAt: '2026-08-16T12:02:00Z',
  })), /does not emit/);
});

test('unpublished v2 migration rejects unknown nested fields and malformed legacy geometry', () => {
  const unknown = unpublishedV2Result();
  unknown.blocks[0].lines[0].futureGeometry = [];
  assert.throws(() => migrateUnpublishedOcrResultV2ToCurrent(unknown, migrationOptions({
    stateId: 'state-1',
    stateRevision: 0,
    stateUpdatedAt: '2026-08-16T12:02:00Z',
  })), /futureGeometry is not allowed/);

  const malformed = unpublishedV2Result();
  malformed.blocks[0].lines[0].polygon = [[1, 1], [10, 10], [1, 10], [10, 1]];
  assert.throws(() => migrateUnpublishedOcrResultV2ToCurrent(malformed, migrationOptions({
    stateId: 'state-1',
    stateRevision: 0,
    stateUpdatedAt: '2026-08-16T12:02:00Z',
  })), /non-zero|self-intersect/);
});

test('job separates recognition options, document policy, and one-page scheduler metadata', () => {
  const value = job();
  assert.equal(assertOcrJobV1(value), value);
  assert.equal(value.scheduler.execution, 'one-page-child');
  assert.deepEqual(Object.keys(value.recognitionOptions), [
    'languagePolicy', 'includeWords', 'orientation', 'deskew', 'preprocessing',
    'rasterDpi', 'maximumPixels', 'maximumSide', 'timeoutMs',
  ]);
  assert.deepEqual(Object.keys(value.documentPolicy), [
    'skipMeaningfulExistingText', 'forceRerun', 'replaceApplicationOwnedOcrOnly', 'keepCompletedPages',
  ]);
});

test('progress supports the complete child-engine lifecycle without application-only stages', () => {
  for (const stage of OCR_PROGRESS_STAGES) {
    const value = progress(stage);
    if (stage === 'queued') value.fraction = 0;
    assert.equal(assertOcrProgressV1(value).stage, stage);
  }
  assert.equal(OCR_PROGRESS_STAGES.includes('applying'), false);
  assert.equal(OCR_PROGRESS_STAGES.includes('skipped'), false);
  const invalid = progress('failed');
  invalid.error = null;
  assert.equal(validateOcrProgressV1(invalid).ok, false);
});

test('runtime and JSON Schema agree on the engine fixture corpus', () => {
  const valid = currentResult().engine;
  const unknown = structuredClone(valid);
  unknown.future = true;
  const dishonest = structuredClone(valid);
  dishonest.capabilities.languageDetection = true;
  const missingPack = structuredClone(valid);
  delete missingPack.modelPack.assets;
  const unsupported = structuredClone(valid);
  unsupported.schemaVersion = 99;
  assertCorpusParity({
    name: 'engine',
    schema: 'engine.v2.schema.json',
    validate: validateOcrEngineV2,
    cases: [
      { name: 'valid', value: valid, valid: true },
      { name: 'unknown-key', value: unknown, valid: false },
      { name: 'dishonest-capability', value: dishonest, valid: false },
      { name: 'missing-model-metadata', value: missingPack, valid: false },
      { name: 'unsupported-version', value: unsupported, valid: false },
    ],
  });
});

test('runtime and JSON Schema agree on strict result fixtures', () => {
  const valid = currentResult();
  const cases = [{ name: 'valid', value: valid, valid: true }];
  function invalid(name, mutate) {
    const value = structuredClone(valid);
    mutate(value);
    cases.push({ name, value, valid: false });
  }
  invalid('unknown-key', (value) => { value.mutableReviewState = {}; });
  invalid('missing-line-polygon', (value) => { delete value.lines[0].polygon; });
  invalid('missing-baseline', (value) => { delete value.lines[0].baseline; });
  invalid('self-intersecting-polygon', (value) => {
    value.lines[0].polygon.points = [[1, 1], [10, 10], [1, 10], [10, 1]];
  });
  invalid('zero-area-polygon', (value) => {
    value.lines[0].polygon.points = [[1, 1], [2, 2], [3, 3], [4, 4]];
  });
  invalid('nan-confidence', (value) => { value.lines[0].confidence = Number.NaN; });
  invalid('infinite-metric', (value) => { value.metrics.totalOcrMs = Number.POSITIVE_INFINITY; });
  invalid('invalid-unicode', (value) => { value.lines[0].text = '\ud800'; });
  invalid('inconsistent-combined-text', (value) => { value.text = 'different text'; });
  invalid('duplicate-id', (value) => { value.lines.push(structuredClone(value.lines[0])); });
  invalid('impossible-page-index', (value) => { value.page.index = value.document.pageCount; });
  invalid('mismatched-raster-size', (value) => { value.lines[0].polygon.points[1][0] = 101; });
  invalid('capability-data-contradiction', (value) => {
    value.lines[0].words = [{ id: 'word-1', text: 'hello', confidence: 0.8 }];
  });
  invalid('word-box-outside-raster', (value) => {
    value.engine.engineId = 'future-word-engine';
    value.engine.capabilities.wordResults = true;
    value.lines[0].words = [{
      id: 'word-1', text: 'hello', confidence: 0.8,
      boundingBox: { coordinateSpace: 'source-raster-pixels', x: 90, y: 1, width: 20, height: 10 },
    }];
  });
  invalid('unsupported-reason-polygon-outside-raster', (value) => {
    value.unsupportedContentReasons = [{
      id: 'reason-1', code: 'other', message: 'Outside source raster.',
      polygon: {
        coordinateSpace: 'source-raster-pixels',
        points: [[90, 1], [110, 1], [110, 10], [90, 10]],
      },
    }];
  });
  invalid('duplicate-detected-language-tag', (value) => {
    value.engine.engineId = 'future-language-engine';
    value.engine.capabilities.languageDetection = true;
    value.detectedLanguages = [{ tag: 'en', confidence: 0.9 }, { tag: 'en', confidence: 0.8 }];
  });
  invalid('applied-preprocessing-without-applied-operation', (value) => {
    value.engine.engineId = 'future-preprocessing-engine';
    value.engine.capabilities.preprocessingMetadata = true;
    value.preprocessing = {
      status: 'applied',
      operations: [{ kind: 'deskew', applied: false, value: 0, unit: 'degrees' }],
      outputRaster: {
        id: 'preprocessed-raster-1', fingerprint: hash('d'),
        coordinateSpace: 'preprocessed-raster-pixels', widthPx: 100, heightPx: 50, dpi: 144,
      },
      transform: {
        fromSpace: 'source-raster-pixels', toSpace: 'preprocessed-raster-pixels',
        matrix: [1, 0, 0, 1, 0, 0], inverseMatrix: [1, 0, 0, 1, 0, 0],
      },
    };
  });
  invalid('unsupported-version', (value) => { value.schemaVersion = 99; });
  invalid('missing-model-metadata', (value) => { delete value.engine.modelPack; });
  invalid('estimated-engine-baseline', (value) => {
    value.lines[0].baseline = {
      status: 'provided', coordinateSpace: 'source-raster-pixels', provenance: 'estimated', points: [[1, 11], [41, 11]],
    };
  });
  const nonJson = structuredClone(valid);
  nonJson.text = undefined;
  cases.push({ name: 'non-json-value', value: nonJson, valid: false });
  const cyclic = structuredClone(valid);
  cyclic.lines[0].cycle = cyclic;
  cases.push({ name: 'cyclic-value', value: cyclic, valid: false });
  const oversized = structuredClone(valid);
  oversized.text = 'x'.repeat(OCR_CONTRACT_LIMITS.maxResultBytes);
  cases.push({ name: 'oversized', value: oversized, valid: false });
  assertCorpusParity({
    name: 'result',
    schema: 'result.v2.schema.json',
    validate: validateOcrResultV2,
    cases,
  });
});

test('runtime and JSON Schema agree on the strict Worker message corpus', () => {
  const recognize = recognizeWorkerMessage();
  const result = currentResult();
  result.preprocessing = { status: 'none', operations: [], outputRaster: null, transform: null };
  const validMessages = [
    recognize,
    workerMessage('dispose'),
    workerMessage('ready'),
    workerMessage('lifecycle', {
      stage: 'recognizing',
      atEpochMs: 1,
      detail: { adapterLoadCount: 1 },
    }),
    workerMessage('result', { requestId: result.requestId, result }),
    workerMessage('error', {
      requestId: 'request-1',
      error: { name: 'OcrWorkerError', code: 'OCR_WORKER_ERROR', message: 'Failed.', retryable: false },
    }),
    workerMessage('disposed', { detail: { onnxSessionsReleased: true } }),
  ];
  const cases = validMessages.map((value, index) => ({ name: `valid-${index}`, value, valid: true }));
  const unknown = structuredClone(recognize);
  unknown.sourcePath = '/private/source.pdf';
  cases.push({ name: 'unknown-key', value: unknown, valid: false });
  const badDimensions = structuredClone(recognize);
  badDimensions.image.width += 1;
  cases.push({ name: 'raster-identity-mismatch', value: badDimensions, valid: false });
  const badByteLength = structuredClone(recognize);
  badByteLength.image.rgba = new ArrayBuffer(4);
  cases.push({ name: 'raster-byte-length', value: badByteLength, valid: false });
  const badRequest = structuredClone(recognize);
  badRequest.requestId = 'other-request';
  cases.push({ name: 'request-job-mismatch', value: badRequest, valid: false });
  const binaryLifecycle = workerMessage('lifecycle', {
    stage: 'recognizing', atEpochMs: 1, detail: { binary: new ArrayBuffer(1) },
  });
  cases.push({ name: 'non-json-lifecycle-detail', value: binaryLifecycle, valid: false });
  assertCorpusParity({
    name: 'worker-message',
    schema: 'worker-message.v1.schema.json',
    validate: validateOcrWorkerMessageV1,
    cases,
  });
  assert.equal(validateOcrWorkerMessageV1(workerMessage('ready'), {
    direction: 'parent-to-worker',
  }).ok, false);
  assert.equal(validateOcrWorkerMessageV1(recognize, {
    direction: 'worker-to-parent',
  }).ok, false);
});

test('Worker result identity matching covers every stale-result field', () => {
  const request = recognizeWorkerMessage();
  const result = currentResult();
  result.preprocessing = { status: 'none', operations: [], outputRaster: null, transform: null };
  assert.equal(validateOcrResultMatchesJob(result, request.job).ok, true);
  const stale = structuredClone(result);
  stale.document.generation = 'different-generation';
  assert.equal(validateOcrResultMatchesJob(stale, request.job).ok, false);
});

test('runtime and JSON Schema agree on the bounded native child job envelope', () => {
  const valid = nativeJobEnvelope();
  const unknown = structuredClone(valid);
  unknown.sourcePdfPath = '/private/source.pdf';
  const badDimensions = structuredClone(valid);
  badDimensions.raster.widthPx += 1;
  const badPreprocessing = structuredClone(valid);
  badPreprocessing.preprocessingRequest = { mode: 'standard', operations: ['grayscale'] };
  const badLimit = structuredClone(valid);
  badLimit.limits.maxPixels = 10;
  const badTimeout = structuredClone(valid);
  badTimeout.limits.timeoutMs += 1;
  assertCorpusParity({
    name: 'native-job', schema: 'native-job.v1.schema.json', validate: validateNativeOcrJobEnvelopeV1,
    cases: [
      { name: 'valid', value: valid, valid: true },
      { name: 'source-path', value: unknown, valid: false },
      { name: 'raster-identity-mismatch', value: badDimensions, valid: false },
      { name: 'preprocessing-mismatch', value: badPreprocessing, valid: false },
      { name: 'raster-limit', value: badLimit, valid: false },
      { name: 'timeout-mismatch', value: badTimeout, valid: false },
    ],
  });
});

test('line polygons are mandatory and word polygons remain optional', () => {
  const result = currentResult();
  result.engine.engineId = 'future-word-engine';
  result.engine.capabilities.wordResults = true;
  result.lines[0].words = [{ id: 'word-1', text: 'hello', confidence: 0.8 }];
  assert.equal(validateOcrResultV2(result).ok, true);
  result.lines[0].words[0].polygon = {
    coordinateSpace: 'source-raster-pixels',
    points: [[1, 1], [2, 2], [3, 3]],
  };
  result.engine.capabilities.wordPolygons = true;
  assert.equal(validateOcrResultV2(result).ok, false);
});

test('runtime and JSON Schema agree on job, progress, state, geometry, and model-pack corpora', () => {
  const validJob = job();
  const badJob = structuredClone(validJob);
  badJob.documentPolicy.forceRerun = true;
  const badRasterJob = structuredClone(validJob);
  badRasterJob.recognitionOptions.maximumPixels = 10;
  const badLanguageJob = structuredClone(validJob);
  badLanguageJob.recognitionOptions.languagePolicy = { mode: 'restrict', languages: ['und'], scripts: [] };
  const badOrientationJob = structuredClone(validJob);
  badOrientationJob.recognitionOptions.orientation = { mode: 'detect', degrees: 90 };
  const badPreprocessingJob = structuredClone(validJob);
  badPreprocessingJob.recognitionOptions.preprocessing = { mode: 'custom', operations: [] };
  assertCorpusParity({
    name: 'job', schema: 'job.v1.schema.json', validate: validateOcrJobV1,
    cases: [
      { name: 'valid', value: validJob, valid: true },
      { name: 'contradictory-policy', value: badJob, valid: false },
      { name: 'raster-limit', value: badRasterJob, valid: false },
      { name: 'und-selector', value: badLanguageJob, valid: false },
      { name: 'orientation-mode', value: badOrientationJob, valid: false },
      { name: 'empty-custom-preprocessing', value: badPreprocessingJob, valid: false },
    ],
  });

  const validProgress = progress();
  const badProgress = progress('completed');
  badProgress.fraction = 0.5;
  const badProgressStage = progress();
  badProgressStage.stage = 'applying';
  assertCorpusParity({
    name: 'progress', schema: 'progress.v1.schema.json', validate: validateOcrProgressV1,
    cases: [
      { name: 'valid', value: validProgress, valid: true },
      { name: 'terminal-fraction', value: badProgress, valid: false },
      { name: 'application-stage', value: badProgressStage, valid: false },
    ],
  });

  const validState = documentState();
  const duplicateState = structuredClone(validState);
  duplicateState.pages.push(structuredClone(duplicateState.pages[0]));
  const badBaselineState = structuredClone(validState);
  badBaselineState.pages[0].estimatedBaselines[0].baseline.provenance = 'engine';
  const reversedTimestampState = structuredClone(validState);
  reversedTimestampState.pages[0].estimatedBaselines[0].updatedAt = '2026-08-16T11:59:00Z';
  assertCorpusParity({
    name: 'document-state', schema: 'document-state.v1.schema.json', validate: validateOcrDocumentStateV1,
    cases: [
      { name: 'valid', value: validState, valid: true },
      { name: 'duplicate-page', value: duplicateState, valid: false },
      { name: 'false-baseline-provenance', value: badBaselineState, valid: false },
      { name: 'reversed-baseline-timestamps', value: reversedTimestampState, valid: false },
    ],
  });

  const validGeometry = pageGeometry();
  const badGeometry = structuredClone(validGeometry);
  badGeometry.transformChain.operations[0].inverseMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const badBoxGeometry = structuredClone(validGeometry);
  badBoxGeometry.boxes.cropBox.width = 60;
  assertCorpusParity({
    name: 'page-geometry', schema: 'page-geometry.v1.schema.json', validate: validateOcrPageGeometryV1,
    cases: [
      { name: 'valid', value: validGeometry, valid: true },
      { name: 'inverse-mismatch', value: badGeometry, valid: false },
      { name: 'crop-outside-media', value: badBoxGeometry, valid: false },
    ],
  });

  const badPack = structuredClone(pack);
  badPack.recognitionSupport.languages[0] = 'und';
  const unknownPack = structuredClone(pack);
  unknownPack.signature = 'not-a-signature';
  const malformedPack = structuredClone(pack);
  malformedPack.assets.detection.sha256 = 'bad';
  const unsafePathPack = structuredClone(pack);
  unsafePathPack.assets.detection.file = '../detection.onnx';
  const reversedCompatibilityPack = structuredClone(pack);
  reversedCompatibilityPack.applicationCompatibility.maximumVersionExclusive = '1.84.0';
  assertCorpusParity({
    name: 'model-pack', schema: 'model-pack.v1.schema.json', validate: validateOcrModelPackV1,
    cases: [
      { name: 'valid', value: pack, valid: true },
      { name: 'und-language', value: badPack, valid: false },
      { name: 'unknown-signature', value: unknownPack, valid: false },
      { name: 'malformed-checksum', value: malformedPack, valid: false },
      { name: 'unsafe-asset-path', value: unsafePathPack, valid: false },
      { name: 'reversed-app-compatibility', value: reversedCompatibilityPack, valid: false },
    ],
  });
});

test('incompatible packs and unsafe install contexts are rejected', () => {
  const wrongEngine = structuredClone(pack);
  wrongEngine.engineCompatibility.engineId = 'different-engine';
  assert.throws(() => assertCompatibleOcrModelPack(wrongEngine, phaseAEngine()), /incompatible/);
  assert.throws(() => assertCompatibleOcrModelPack(pack, phaseAEngine(), { platform: 'linux' }), /does not support platform/);
  assert.equal(validateInstallableOcrModelPack(pack, phaseAEngine(), {
    platform: 'macos',
    architecture: 'arm64',
    applicationVersion: '1.84.0',
    source: 'bundled',
    trustedRootIds: [pack.trust.trustRootId],
  }).ok, false);
  assert.equal(validateInstallableOcrModelPack(pack, phaseAEngine(), {
    platform: 'macos',
    architecture: 'arm64',
    applicationVersion: '1.85.0',
    source: 'bundled',
    trustedRootIds: ['different-root'],
  }).ok, false);
});

test('Phase A v1 still rejects malformed polygons and invalid Unicode without changing its contract shape', () => {
  const invalidPolygon = phaseAResult();
  invalidPolygon.lines[0].polygon = [[1, 1], [2, 2], [3, 3], [4, 4]];
  assert.equal(validateOcrResultV1(invalidPolygon).ok, false);
  const invalidUnicode = phaseAResult();
  invalidUnicode.text = '\ud800';
  assert.ok(validateOcrResultV1(invalidUnicode).issues.some((issue) => issue.includes('valid Unicode')));
});
