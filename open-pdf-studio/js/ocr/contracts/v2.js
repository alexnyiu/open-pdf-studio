import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  assertOcrEngineV1,
  assertOcrResultV1,
} from './v1.js';
import {
  OCR_MODEL_PACK_CONTRACT,
  assertCompatibleOcrModelPack,
  modelPackIdentity,
  validateOcrModelPackIdentity,
} from './model-pack.v1.js';
import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateAffineInverse,
  validateBoundingBox,
  validateConfidence,
  validateFingerprint,
  validateIdentifier,
  validateIsoTimestamp,
  validateJsonValue,
  validateLanguageTag,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validatePositiveNumber,
  validatePolygon,
  validateSemver,
  validateSerializedSize,
  validateString,
} from './validation.js';
import {
  OCR_PREPROCESSED_RASTER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  validateAffineTransform,
  validateBaseline,
  validateCoordinateBoundingBox,
  validateCoordinatePolygon,
  validateRasterIdentity,
} from './geometry.js';
import {
  OCR_DOCUMENT_STATE_CONTRACT,
  OCR_DOCUMENT_STATE_SCHEMA_VERSION,
  toValidatedOcrDocumentStateV1Json,
} from './document-state.v1.js';
import { toValidatedOcrPageGeometryV1Json } from './page-geometry.v1.js';

export { OCR_ENGINE_CONTRACT, OCR_RESULT_CONTRACT };
export const OCR_CURRENT_SCHEMA_VERSION = 2;
export const OCR_RESULT_PAGE_STATUSES = Object.freeze([
  'completed',
  'partial',
  'unsupported',
  'failed',
  'cancelled',
]);
export const OCR_WRITING_DIRECTIONS = Object.freeze(['ltr', 'rtl', 'ttb', 'btt']);
export const OCR_UNSUPPORTED_CONTENT_CODES = Object.freeze([
  'handwriting',
  'table',
  'math',
  'vertical-text',
  'curved-text',
  'rotated-text',
  'low-confidence',
  'unknown-language',
  'complex-layout',
  'other',
]);

const PADDLE_ENGINE_ID = 'paddleocr-pp-ocrv6-small-onnx-wasm';
const ENGINE_CAPABILITIES = [
  'textDetection',
  'textRecognition',
  'lineResults',
  'linePolygons',
  'lineBaselines',
  'wordResults',
  'wordPolygons',
  'alternatives',
  'languageDetection',
  'writingDirectionDetection',
  'preprocessingMetadata',
  'nativePdfWriting',
];
const PADDLE_UNSUPPORTED_CAPABILITIES = [
  'lineBaselines',
  'wordResults',
  'wordPolygons',
  'alternatives',
  'languageDetection',
  'writingDirectionDetection',
  'preprocessingMetadata',
  'nativePdfWriting',
];
const METRIC_KEYS = [
  'workerStartupMs',
  'modelStartupMs',
  'rasterMs',
  'detectionMs',
  'recognitionMs',
  'totalOcrMs',
];

function validateEngineV2(value, issues, path = 'engine') {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'engineId', 'adapterVersion', 'provider',
    'model', 'modelPack', 'runtime', 'capabilities',
  ]), path, issues);
  if (value.contract !== OCR_ENGINE_CONTRACT) issues.push(`${path}.contract must be ${OCR_ENGINE_CONTRACT}`);
  if (value.schemaVersion !== OCR_CURRENT_SCHEMA_VERSION) issues.push(`${path}.schemaVersion must be 2`);
  validateIdentifier(value.engineId, `${path}.engineId`, issues);
  validateSemver(value.adapterVersion, `${path}.adapterVersion`, issues);
  validateString(value.provider, `${path}.provider`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  if (!isObject(value.model)) {
    issues.push(`${path}.model must be an object`);
  } else {
    requireExactKeys(value.model, new Set(['family', 'tier', 'detection', 'recognition']), `${path}.model`, issues);
    for (const key of ['family', 'tier', 'detection', 'recognition']) {
      validateString(value.model[key], `${path}.model.${key}`, issues, { nonEmpty: true, maxCodeUnits: 256 });
    }
  }
  const modelValidation = validateOcrModelPackIdentity(value.modelPack, `${path}.modelPack`);
  issues.push(...modelValidation.issues);
  if (!isObject(value.runtime)) {
    issues.push(`${path}.runtime must be an object`);
  } else {
    requireExactKeys(value.runtime, new Set(['name', 'version', 'executionProvider', 'offline']), `${path}.runtime`, issues);
    for (const key of ['name', 'version', 'executionProvider']) {
      validateString(value.runtime[key], `${path}.runtime.${key}`, issues, { nonEmpty: true, maxCodeUnits: 128 });
    }
    if (value.runtime.offline !== true) issues.push(`${path}.runtime.offline must be true`);
  }
  if (!isObject(value.capabilities)) {
    issues.push(`${path}.capabilities must be an object`);
  } else {
    requireExactKeys(value.capabilities, new Set(ENGINE_CAPABILITIES), `${path}.capabilities`, issues);
    for (const capability of ENGINE_CAPABILITIES) {
      if (typeof value.capabilities[capability] !== 'boolean') {
        issues.push(`${path}.capabilities.${capability} must be boolean`);
      }
    }
    for (const capability of ['textDetection', 'textRecognition', 'lineResults', 'linePolygons']) {
      if (value.capabilities[capability] !== true) issues.push(`${path}.capabilities.${capability} must be true`);
    }
    if (value.capabilities.wordPolygons === true && value.capabilities.wordResults !== true) {
      issues.push(`${path}.capabilities.wordPolygons requires wordResults`);
    }
    if (value.engineId === PADDLE_ENGINE_ID) {
      for (const capability of PADDLE_UNSUPPORTED_CAPABILITIES) {
        if (value.capabilities[capability] !== false) {
          issues.push(`${path}.capabilities.${capability} must be false for the current Paddle adapter`);
        }
      }
    }
  }
}

export function validateOcrEngineV2(value) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['engine must be an object'] };
  validateJsonValue(value, 'engine', issues);
  validateSerializedSize(value, 'engine', issues, 256 * 1024);
  validateEngineV2(value, issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrEngineV2(value) {
  const validation = validateOcrEngineV2(value);
  if (!validation.ok) throw new OcrContractError(OCR_ENGINE_CONTRACT, validation.issues);
  return value;
}

function validateDocument(value, issues) {
  if (!isObject(value)) {
    issues.push('document must be an object');
    return;
  }
  requireExactKeys(value, new Set(['id', 'fingerprint', 'revision', 'generation', 'pageCount']), 'document', issues);
  validateIdentifier(value.id, 'document.id', issues);
  validateFingerprint(value.fingerprint, 'document.fingerprint', issues);
  validateNonNegativeInteger(value.revision, 'document.revision', issues);
  validateIdentifier(value.generation, 'document.generation', issues);
  validatePositiveInteger(value.pageCount, 'document.pageCount', issues, { maximum: OCR_CONTRACT_LIMITS.maxPagesPerJob });
}

function validatePage(value, pageCount, issues) {
  if (!isObject(value)) {
    issues.push('page must be an object');
    return;
  }
  requireExactKeys(value, new Set(['id', 'index', 'revision', 'status']), 'page', issues);
  validateIdentifier(value.id, 'page.id', issues);
  validateNonNegativeInteger(value.index, 'page.index', issues);
  validateNonNegativeInteger(value.revision, 'page.revision', issues);
  if (Number.isSafeInteger(value.index) && Number.isSafeInteger(pageCount) && value.index >= pageCount) {
    issues.push('page.index must identify a page in document.pageCount');
  }
  if (!OCR_RESULT_PAGE_STATUSES.includes(value.status)) issues.push('page.status is unsupported');
}

function validateDetectedLanguage(value, path, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['tag', 'confidence']), path, issues);
  validateLanguageTag(value.tag, `${path}.tag`, issues);
  if (value.tag === 'und') issues.push(`${path}.tag must name a detected language`);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  state.hasDetectedLanguage = true;
}

function validateAlternatives(value, path, issues, state) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxAlternativesPerItem) {
    issues.push(`${path} exceeds ${OCR_CONTRACT_LIMITS.maxAlternativesPerItem} items`);
  }
  value.slice(0, OCR_CONTRACT_LIMITS.maxAlternativesPerItem).forEach((alternative, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(alternative)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    requireExactKeys(alternative, new Set(['text', 'confidence']), itemPath, issues);
    validateString(alternative.text, `${itemPath}.text`, issues);
    validateConfidence(alternative.confidence, `${itemPath}.confidence`, issues);
  });
  if (value.length > 0) state.hasAlternatives = true;
}

function validateWritingDirection(value, path, issues, state) {
  if (!OCR_WRITING_DIRECTIONS.includes(value)) issues.push(`${path} is unsupported`);
  else state.hasWritingDirection = true;
}

function validateWord(value, path, rasters, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'alternatives',
    'detectedLanguage', 'detectedWritingDirection',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (state.entityIds.has(value.id)) issues.push(`${path}.id must be unique across result entities`);
  state.entityIds.add(value.id);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  if (value.polygon !== undefined) {
    validateCoordinatePolygon(value.polygon, `${path}.polygon`, issues, { rasters });
    state.hasWordPolygons = true;
    state.geometrySpaces.add(value.polygon?.coordinateSpace);
  }
  if (value.boundingBox !== undefined) {
    validateCoordinateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { rasters });
    state.geometrySpaces.add(value.boundingBox?.coordinateSpace);
  }
  if (value.alternatives !== undefined) validateAlternatives(value.alternatives, `${path}.alternatives`, issues, state);
  if (value.detectedLanguage !== undefined) {
    validateDetectedLanguage(value.detectedLanguage, `${path}.detectedLanguage`, issues, state);
  }
  if (value.detectedWritingDirection !== undefined) {
    validateWritingDirection(value.detectedWritingDirection, `${path}.detectedWritingDirection`, issues, state);
  }
  state.totalWords += 1;
}

function validateLine(value, index, rasters, issues, state) {
  const path = `lines[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'baseline', 'words',
    'alternatives', 'detectedLanguage', 'detectedWritingDirection',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (state.entityIds.has(value.id)) issues.push(`${path}.id must be unique across result entities`);
  state.entityIds.add(value.id);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validateCoordinatePolygon(value.polygon, `${path}.polygon`, issues, { rasters });
  state.geometrySpaces.add(value.polygon?.coordinateSpace);
  if (value.boundingBox !== undefined) {
    validateCoordinateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { rasters });
    state.geometrySpaces.add(value.boundingBox?.coordinateSpace);
  }
  validateBaseline(value.baseline, `${path}.baseline`, issues, { rasters, allowedProvenance: ['engine'] });
  state.geometrySpaces.add(value.baseline?.coordinateSpace);
  if (value.baseline?.status === 'provided') state.hasEngineBaselines = true;
  if (value.words !== undefined) {
    if (!Array.isArray(value.words)) {
      issues.push(`${path}.words must be an array`);
    } else {
      value.words.forEach((word, wordIndex) => {
        if (state.totalWords < OCR_CONTRACT_LIMITS.maxWordsPerPage) {
          validateWord(word, `${path}.words[${wordIndex}]`, rasters, issues, state);
        }
      });
    }
  }
  if (value.alternatives !== undefined) validateAlternatives(value.alternatives, `${path}.alternatives`, issues, state);
  if (value.detectedLanguage !== undefined) {
    validateDetectedLanguage(value.detectedLanguage, `${path}.detectedLanguage`, issues, state);
  }
  if (value.detectedWritingDirection !== undefined) {
    validateWritingDirection(value.detectedWritingDirection, `${path}.detectedWritingDirection`, issues, state);
  }
}

function validatePreprocessing(value, sourceRaster, issues, capabilities) {
  if (!isObject(value)) {
    issues.push('preprocessing must be an object');
    return { [OCR_SOURCE_RASTER_SPACE]: sourceRaster };
  }
  requireExactKeys(value, new Set(['status', 'operations', 'outputRaster', 'transform']), 'preprocessing', issues);
  if (!['unknown', 'none', 'applied'].includes(value.status)) issues.push('preprocessing.status is unsupported');
  if (!Array.isArray(value.operations)) {
    issues.push('preprocessing.operations must be an array');
  } else {
    if (value.operations.length > OCR_CONTRACT_LIMITS.maxPreprocessingOperations) {
      issues.push(`preprocessing.operations exceeds ${OCR_CONTRACT_LIMITS.maxPreprocessingOperations} items`);
    }
    value.operations.slice(0, OCR_CONTRACT_LIMITS.maxPreprocessingOperations).forEach((operation, index) => {
      const path = `preprocessing.operations[${index}]`;
      if (!isObject(operation)) {
        issues.push(`${path} must be an object`);
        return;
      }
      requireExactKeys(operation, new Set(['kind', 'applied', 'value', 'unit']), path, issues);
      if (!['orientation', 'deskew', 'denoise', 'contrast', 'binarize', 'resize', 'crop'].includes(operation.kind)) {
        issues.push(`${path}.kind is unsupported`);
      }
      if (typeof operation.applied !== 'boolean') issues.push(`${path}.applied must be boolean`);
      if (operation.value !== null && typeof operation.value !== 'string' &&
          !(typeof operation.value === 'number' && Number.isFinite(operation.value))) {
        issues.push(`${path}.value must be null, a finite number, or a string`);
      }
      if (typeof operation.value === 'string') validateString(operation.value, `${path}.value`, issues, { maxCodeUnits: 256 });
      if (operation.unit !== null) validateString(operation.unit, `${path}.unit`, issues, { nonEmpty: true, maxCodeUnits: 64 });
    });
  }
  const rasters = { [OCR_SOURCE_RASTER_SPACE]: sourceRaster };
  if (value.outputRaster !== null) {
    validateRasterIdentity(value.outputRaster, 'preprocessing.outputRaster', issues, {
      coordinateSpace: OCR_PREPROCESSED_RASTER_SPACE,
    });
    rasters[OCR_PREPROCESSED_RASTER_SPACE] = value.outputRaster;
  }
  if (value.transform !== null) {
    validateAffineTransform(value.transform, 'preprocessing.transform', issues, {
      fromSpace: OCR_SOURCE_RASTER_SPACE,
      toSpace: OCR_PREPROCESSED_RASTER_SPACE,
    });
  }
  if (value.status === 'applied') {
    if (value.outputRaster === null || value.transform === null) {
      issues.push('applied preprocessing requires outputRaster and transform');
    }
    if (!value.operations?.some((operation) => operation?.applied === true)) {
      issues.push('applied preprocessing requires at least one applied operation');
    }
    if (capabilities?.preprocessingMetadata !== true) {
      issues.push('engine capabilities do not permit preprocessing metadata');
    }
  } else if (value.operations?.length > 0 || value.outputRaster !== null || value.transform !== null) {
    issues.push('unknown or absent preprocessing must not contain operations, outputRaster, or transform');
  }
  return rasters;
}

function validateWarnings(value, issues, entityIds) {
  if (!Array.isArray(value)) {
    issues.push('warnings must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxWarningsPerPage) {
    issues.push(`warnings exceeds ${OCR_CONTRACT_LIMITS.maxWarningsPerPage} items`);
  }
  value.slice(0, OCR_CONTRACT_LIMITS.maxWarningsPerPage).forEach((warning, index) => {
    const path = `warnings[${index}]`;
    if (!isObject(warning)) {
      issues.push(`${path} must be an object`);
      return;
    }
    requireExactKeys(warning, new Set(['code', 'message', 'severity', 'entityIds']), path, issues);
    validateIdentifier(warning.code, `${path}.code`, issues);
    validateString(warning.message, `${path}.message`, issues, { nonEmpty: true });
    if (!['info', 'warning', 'error'].includes(warning.severity)) issues.push(`${path}.severity is unsupported`);
    if (!Array.isArray(warning.entityIds)) {
      issues.push(`${path}.entityIds must be an array`);
    } else {
      const seen = new Set();
      warning.entityIds.forEach((id, entityIndex) => {
        validateIdentifier(id, `${path}.entityIds[${entityIndex}]`, issues);
        if (seen.has(id)) issues.push(`${path}.entityIds[${entityIndex}] must be unique`);
        if (!entityIds.has(id)) issues.push(`${path}.entityIds[${entityIndex}] is unknown`);
        seen.add(id);
      });
    }
  });
}

function validateUnsupportedReasons(value, rasters, issues) {
  if (!Array.isArray(value)) {
    issues.push('unsupportedContentReasons must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage) {
    issues.push(`unsupportedContentReasons exceeds ${OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage} items`);
  }
  const ids = new Set();
  value.slice(0, OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage).forEach((reason, index) => {
    const path = `unsupportedContentReasons[${index}]`;
    if (!isObject(reason)) {
      issues.push(`${path} must be an object`);
      return;
    }
    requireExactKeys(reason, new Set(['id', 'code', 'message', 'polygon']), path, issues);
    validateIdentifier(reason.id, `${path}.id`, issues);
    if (ids.has(reason.id)) issues.push(`${path}.id must be unique`);
    ids.add(reason.id);
    if (!OCR_UNSUPPORTED_CONTENT_CODES.includes(reason.code)) issues.push(`${path}.code is unsupported`);
    validateString(reason.message, `${path}.message`, issues, { nonEmpty: true });
    if (reason.polygon !== undefined) validateCoordinatePolygon(reason.polygon, `${path}.polygon`, issues, { rasters });
  });
}

function validateMetrics(value, issues) {
  if (!isObject(value)) {
    issues.push('metrics must be an object');
    return;
  }
  requireExactKeys(value, new Set(METRIC_KEYS), 'metrics', issues);
  for (const key of METRIC_KEYS) validateNonNegativeNumber(value[key], `metrics.${key}`, issues);
}

export function validateOcrResultV2(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxResultBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['result must be an object'] };
  validateJsonValue(value, 'result', issues);
  if (!validateSerializedSize(value, 'result', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'requestId', 'engine', 'document',
    'page', 'recognitionConfigurationHash', 'sourceRaster', 'text', 'lines',
    'detectedLanguages', 'warnings', 'unsupportedContentReasons', 'preprocessing', 'metrics',
  ]), 'result', issues);
  if (value.contract !== OCR_RESULT_CONTRACT) issues.push(`contract must be ${OCR_RESULT_CONTRACT}`);
  if (value.schemaVersion !== OCR_CURRENT_SCHEMA_VERSION) issues.push('schemaVersion must be 2');
  validateIdentifier(value.jobId, 'jobId', issues);
  validateIdentifier(value.requestId, 'requestId', issues);
  validateEngineV2(value.engine, issues);
  validateDocument(value.document, issues);
  validatePage(value.page, value.document?.pageCount, issues);
  validateFingerprint(value.recognitionConfigurationHash, 'recognitionConfigurationHash', issues);
  validateRasterIdentity(value.sourceRaster, 'sourceRaster', issues, {
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
  });
  validateString(value.text, 'text', issues);
  const rasters = validatePreprocessing(value.preprocessing, value.sourceRaster, issues, value.engine?.capabilities);
  const state = {
    entityIds: new Set(),
    totalWords: 0,
    hasWordPolygons: false,
    hasAlternatives: false,
    hasDetectedLanguage: false,
    hasWritingDirection: false,
    hasEngineBaselines: false,
    geometrySpaces: new Set(),
  };
  if (!Array.isArray(value.lines)) {
    issues.push('lines must be an array');
  } else {
    if (value.lines.length > OCR_CONTRACT_LIMITS.maxLinesPerPage) {
      issues.push(`lines exceeds ${OCR_CONTRACT_LIMITS.maxLinesPerPage} items`);
    }
    value.lines.slice(0, OCR_CONTRACT_LIMITS.maxLinesPerPage)
      .forEach((line, index) => validateLine(line, index, rasters, issues, state));
    const combinedLineText = value.lines.map((line) => line?.text).filter(Boolean).join('\n');
    if (value.text !== combinedLineText) {
      issues.push('text must equal the non-empty line text joined with newlines');
    }
  }
  const declaredWordCount = Array.isArray(value.lines)
    ? value.lines.reduce((count, line) => count + (Array.isArray(line?.words) ? line.words.length : 0), 0)
    : 0;
  if (declaredWordCount > OCR_CONTRACT_LIMITS.maxWordsPerPage) {
    issues.push(`result exceeds ${OCR_CONTRACT_LIMITS.maxWordsPerPage} words`);
  }
  if (!Array.isArray(value.detectedLanguages)) {
    issues.push('detectedLanguages must be an array');
  } else {
    const tags = new Set();
    value.detectedLanguages.forEach((language, index) => {
      validateDetectedLanguage(language, `detectedLanguages[${index}]`, issues, state);
      if (tags.has(language?.tag)) issues.push(`detectedLanguages[${index}].tag must be unique`);
      tags.add(language?.tag);
    });
  }
  validateWarnings(value.warnings, issues, state.entityIds);
  validateUnsupportedReasons(value.unsupportedContentReasons, rasters, issues);
  validateMetrics(value.metrics, issues);
  if (value.page?.status === 'unsupported' && value.unsupportedContentReasons?.length === 0) {
    issues.push('unsupported pages require at least one unsupportedContentReason');
  }
  if (['failed', 'cancelled'].includes(value.page?.status) && (value.lines?.length > 0 || value.text !== '')) {
    issues.push(`${value.page.status} results must not contain recognized text or lines`);
  }
  if (state.geometrySpaces.has(OCR_PREPROCESSED_RASTER_SPACE) && value.preprocessing?.status !== 'applied') {
    issues.push('preprocessed-raster geometry requires applied preprocessing metadata');
  }
  const capabilities = value.engine?.capabilities;
  if (value.lines?.length > 0 && capabilities?.lineResults !== true) issues.push('engine capabilities do not permit line results');
  if (state.totalWords > 0 && capabilities?.wordResults !== true) issues.push('engine capabilities do not permit word results');
  if (state.hasWordPolygons && capabilities?.wordPolygons !== true) issues.push('engine capabilities do not permit word polygons');
  if (state.hasAlternatives && capabilities?.alternatives !== true) issues.push('engine capabilities do not permit alternatives');
  if (state.hasDetectedLanguage && capabilities?.languageDetection !== true) issues.push('engine capabilities do not permit language detection');
  if (state.hasWritingDirection && capabilities?.writingDirectionDetection !== true) {
    issues.push('engine capabilities do not permit writing-direction detection');
  }
  if (state.hasEngineBaselines && capabilities?.lineBaselines !== true) issues.push('engine capabilities do not permit engine baselines');
  return { ok: issues.length === 0, issues };
}

export function assertOcrResultV2(value, options) {
  const validation = validateOcrResultV2(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_RESULT_CONTRACT, validation.issues);
  return value;
}

export function toValidatedOcrResultV2Json(value, options) {
  assertOcrResultV2(value, options);
  const parsed = JSON.parse(JSON.stringify(value));
  assertOcrResultV2(parsed, options);
  return parsed;
}

function currentCapabilitiesFromV1(value) {
  const isCurrentPaddle = value.engineId === PADDLE_ENGINE_ID;
  return {
    textDetection: value.capabilities.textDetection,
    textRecognition: value.capabilities.textRecognition,
    lineResults: true,
    linePolygons: true,
    lineBaselines: false,
    wordResults: isCurrentPaddle ? false : value.capabilities.wordBoxes,
    wordPolygons: isCurrentPaddle ? false : value.capabilities.wordBoxes,
    alternatives: false,
    languageDetection: false,
    writingDirectionDetection: false,
    preprocessingMetadata: false,
    nativePdfWriting: false,
  };
}

function isLegacyUnpublishedEngineV2(value) {
  return isObject(value) && value.contract === OCR_ENGINE_CONTRACT && value.schemaVersion === 2 &&
    isObject(value.capabilities) && Object.hasOwn(value.capabilities, 'languageMetadata');
}

function validateLegacyUnpublishedEngineV2(value, path = 'engine') {
  const issues = [];
  if (!isObject(value)) return [`${path} must be an object`];
  validateJsonValue(value, path, issues);
  validateSerializedSize(value, path, issues, 256 * 1024);
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'engineId', 'adapterVersion', 'provider',
    'model', 'modelPack', 'runtime', 'capabilities',
  ]), path, issues);
  if (value.contract !== OCR_ENGINE_CONTRACT) issues.push(`${path}.contract must be ${OCR_ENGINE_CONTRACT}`);
  if (value.schemaVersion !== 2) issues.push(`${path}.schemaVersion must be 2`);
  validateIdentifier(value.engineId, `${path}.engineId`, issues);
  validateSemver(value.adapterVersion, `${path}.adapterVersion`, issues);
  validateString(value.provider, `${path}.provider`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  if (!isObject(value.model)) {
    issues.push(`${path}.model must be an object`);
  } else {
    requireExactKeys(value.model, new Set(['family', 'tier', 'detection', 'recognition']), `${path}.model`, issues);
    for (const key of ['family', 'tier', 'detection', 'recognition']) {
      validateString(value.model[key], `${path}.model.${key}`, issues, { nonEmpty: true, maxCodeUnits: 256 });
    }
  }
  if (!isObject(value.modelPack)) {
    issues.push(`${path}.modelPack must be an object`);
  } else {
    requireExactKeys(value.modelPack, new Set(['contract', 'schemaVersion', 'packId', 'packVersion']), `${path}.modelPack`, issues);
    if (value.modelPack.contract !== OCR_MODEL_PACK_CONTRACT) {
      issues.push(`${path}.modelPack.contract is unsupported`);
    }
    if (value.modelPack.schemaVersion !== 1) issues.push(`${path}.modelPack.schemaVersion must be 1`);
    validateIdentifier(value.modelPack.packId, `${path}.modelPack.packId`, issues);
    validateSemver(value.modelPack.packVersion, `${path}.modelPack.packVersion`, issues);
  }
  if (!isObject(value.runtime)) {
    issues.push(`${path}.runtime must be an object`);
  } else {
    requireExactKeys(value.runtime, new Set(['name', 'version', 'executionProvider', 'offline']), `${path}.runtime`, issues);
    for (const key of ['name', 'version', 'executionProvider']) {
      validateString(value.runtime[key], `${path}.runtime.${key}`, issues, { nonEmpty: true, maxCodeUnits: 128 });
    }
    if (value.runtime.offline !== true) issues.push(`${path}.runtime.offline must be true`);
  }
  const capabilityNames = [
    'textDetection', 'textRecognition', 'blockResults', 'lineResults', 'wordResults',
    'linePolygons', 'wordPolygons', 'alternatives', 'languageMetadata',
    'writingDirectionMetadata', 'preprocessingMetadata', 'pdfWriting',
  ];
  if (!isObject(value.capabilities)) {
    issues.push(`${path}.capabilities must be an object`);
  } else {
    requireExactKeys(value.capabilities, new Set(capabilityNames), `${path}.capabilities`, issues);
    for (const capability of capabilityNames) {
      if (typeof value.capabilities[capability] !== 'boolean') {
        issues.push(`${path}.capabilities.${capability} must be boolean`);
      }
    }
    if (value.capabilities.lineResults !== true) issues.push(`${path}.capabilities.lineResults must be true`);
    if (value.capabilities.linePolygons !== true) issues.push(`${path}.capabilities.linePolygons must be true`);
    if (value.capabilities.wordPolygons === true && value.capabilities.wordResults !== true) {
      issues.push(`${path}.capabilities.wordPolygons requires wordResults`);
    }
    if (value.capabilities.pdfWriting !== false) issues.push(`${path}.capabilities.pdfWriting must be false`);
  }
  if (value.engineId !== PADDLE_ENGINE_ID) {
    issues.push(`${path}.engineId has no defined unpublished-v2 migration`);
  }
  return issues;
}

export function migrateOcrEngineToCurrent(value, { modelPack } = {}) {
  if (!isObject(value) || value.contract !== OCR_ENGINE_CONTRACT) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, [`contract must be ${OCR_ENGINE_CONTRACT}`]);
  }
  if (value.schemaVersion === OCR_CURRENT_SCHEMA_VERSION && !isLegacyUnpublishedEngineV2(value)) {
    return assertOcrEngineV2(value);
  }
  if (value.schemaVersion !== 1 && !isLegacyUnpublishedEngineV2(value)) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, [`unsupported schemaVersion ${String(value.schemaVersion)}`]);
  }
  if (modelPack === undefined) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, ['modelPack metadata is required to migrate the engine']);
  }
  if (value.schemaVersion === 1) assertOcrEngineV1(value);
  if (isLegacyUnpublishedEngineV2(value)) {
    const legacyIssues = validateLegacyUnpublishedEngineV2(value);
    if (value.modelPack?.packId !== modelPack.packId || value.modelPack?.packVersion !== modelPack.packVersion) {
      legacyIssues.push('engine.modelPack identity does not match the supplied model pack');
    }
    if (legacyIssues.length > 0) throw new OcrContractError(OCR_ENGINE_CONTRACT, legacyIssues);
  }
  assertCompatibleOcrModelPack(modelPack, value, { platform: 'macos' });
  return assertOcrEngineV2({
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    engineId: value.engineId,
    adapterVersion: value.adapterVersion,
    provider: value.provider,
    model: { ...value.model },
    modelPack: modelPackIdentity(modelPack),
    runtime: { ...value.runtime },
    capabilities: currentCapabilitiesFromV1({
      ...value,
      capabilities: value.schemaVersion === 1
        ? value.capabilities
        : {
            textDetection: value.capabilities.textDetection,
            textRecognition: value.capabilities.textRecognition,
            wordBoxes: value.capabilities.wordPolygons === true,
          },
    }),
  });
}

function validateMigrationIdentity(options, pageIndex) {
  const issues = [];
  for (const key of ['documentId', 'documentGeneration', 'pageId', 'sourceRasterId']) {
    validateIdentifier(options[key], `migration.${key}`, issues);
  }
  validateFingerprint(options.documentFingerprint, 'migration.documentFingerprint', issues);
  validateNonNegativeInteger(options.documentRevision, 'migration.documentRevision', issues);
  validatePositiveInteger(options.documentPageCount, 'migration.documentPageCount', issues, {
    maximum: OCR_CONTRACT_LIMITS.maxPagesPerJob,
  });
  validateNonNegativeInteger(options.pageRevision, 'migration.pageRevision', issues);
  validateFingerprint(options.sourceRasterFingerprint, 'migration.sourceRasterFingerprint', issues);
  validatePositiveNumber(options.rasterDpi, 'migration.rasterDpi', issues);
  validateFingerprint(options.recognitionConfigurationHash, 'migration.recognitionConfigurationHash', issues);
  if (Number.isSafeInteger(options.documentPageCount) && pageIndex >= options.documentPageCount) {
    issues.push('migration.documentPageCount must include the migrated page index');
  }
  if (issues.length > 0) throw new OcrContractError(OCR_RESULT_CONTRACT, issues);
}

function migratedResultRef(result) {
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

function migratedLineFromV1(line) {
  return {
    id: line.id,
    text: line.text,
    confidence: line.confidence,
    polygon: {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      points: line.polygon.map((point) => [...point]),
    },
    boundingBox: {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      ...line.boundingBox,
    },
    baseline: {
      status: 'unavailable',
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      reason: 'engine-did-not-provide',
    },
  };
}

export function migrateOcrResultToCurrent(value, options = {}) {
  if (!isObject(value) || value.contract !== OCR_RESULT_CONTRACT) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, [`contract must be ${OCR_RESULT_CONTRACT}`]);
  }
  if (value.schemaVersion === OCR_CURRENT_SCHEMA_VERSION) {
    const current = validateOcrResultV2(value);
    if (current.ok) return toValidatedOcrResultV2Json(value);
    if (Object.hasOwn(value, 'reviewCorrections') || Object.hasOwn(value, 'pageTransform')) {
      throw new OcrContractError(OCR_RESULT_CONTRACT, [
        'unpublished result v2 must be migrated with migrateUnpublishedOcrResultV2ToCurrent so mutable state is not lost',
      ]);
    }
    throw new OcrContractError(OCR_RESULT_CONTRACT, current.issues);
  }
  if (value.schemaVersion !== 1) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, [`unsupported schemaVersion ${String(value.schemaVersion)}`]);
  }
  assertOcrResultV1(value);
  validateMigrationIdentity(options, value.source.pageIndex);
  const engine = migrateOcrEngineToCurrent(value.engine, { modelPack: options.modelPack });
  const requestId = options.requestId ?? value.requestId;
  const jobId = options.jobId ?? requestId;
  const idIssues = [];
  validateIdentifier(requestId, 'migration.requestId', idIssues);
  validateIdentifier(jobId, 'migration.jobId', idIssues);
  if (idIssues.length > 0) throw new OcrContractError(OCR_RESULT_CONTRACT, idIssues);
  return toValidatedOcrResultV2Json({
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    jobId,
    requestId,
    engine,
    document: {
      id: options.documentId,
      fingerprint: structuredClone(options.documentFingerprint),
      revision: options.documentRevision,
      generation: options.documentGeneration,
      pageCount: options.documentPageCount,
    },
    page: {
      id: options.pageId,
      index: value.source.pageIndex,
      revision: options.pageRevision,
      status: 'completed',
    },
    recognitionConfigurationHash: structuredClone(options.recognitionConfigurationHash),
    sourceRaster: {
      id: options.sourceRasterId,
      fingerprint: structuredClone(options.sourceRasterFingerprint),
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      widthPx: value.source.widthPx,
      heightPx: value.source.heightPx,
      dpi: options.rasterDpi,
    },
    text: value.text,
    lines: value.lines.map(migratedLineFromV1),
    detectedLanguages: [],
    warnings: value.warnings.map((message) => ({
      code: 'phase-a-warning',
      message,
      severity: 'warning',
      entityIds: [],
    })),
    unsupportedContentReasons: [],
    preprocessing: {
      status: 'unknown',
      operations: [],
      outputRaster: null,
      transform: null,
    },
    metrics: { ...value.metrics },
  });
}

function legacyLines(value) {
  const lines = [];
  for (const block of value.blocks ?? []) {
    for (const line of block?.lines ?? []) lines.push(line);
  }
  return lines;
}

function validateLegacyPaddleClaims(value) {
  const issues = [];
  if (value.engine?.engineId !== PADDLE_ENGINE_ID) return issues;
  for (const [index, line] of legacyLines(value).entries()) {
    if (line.words?.length > 0) issues.push(`legacy lines[${index}] contains word data the current Paddle adapter does not emit`);
    if (line.alternatives?.length > 0) issues.push(`legacy lines[${index}] contains alternatives the current Paddle adapter does not emit`);
    if (line.language?.source === 'engine') issues.push(`legacy lines[${index}] claims language detection the current Paddle adapter does not emit`);
    if (line.writingDirection && line.writingDirection !== 'unknown') {
      issues.push(`legacy lines[${index}] claims writing-direction detection the current Paddle adapter does not emit`);
    }
  }
  if (value.languages?.some((language) => language?.source === 'engine')) {
    issues.push('legacy result claims language detection the current Paddle adapter does not emit');
  }
  return issues;
}

function validateLegacyLanguage(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['tag', 'source', 'confidence']), path, issues);
  validateLanguageTag(value.tag, `${path}.tag`, issues);
  if (!['engine', 'requested', 'review', 'unknown'].includes(value.source)) issues.push(`${path}.source is unsupported`);
  if (value.confidence !== undefined) validateConfidence(value.confidence, `${path}.confidence`, issues);
}

function validateLegacyAlternatives(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxAlternativesPerItem) {
    issues.push(`${path} exceeds ${OCR_CONTRACT_LIMITS.maxAlternativesPerItem} items`);
  }
  value.slice(0, OCR_CONTRACT_LIMITS.maxAlternativesPerItem).forEach((alternative, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(alternative)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    requireExactKeys(alternative, new Set(['text', 'confidence']), itemPath, issues);
    validateString(alternative.text, `${itemPath}.text`, issues);
    validateConfidence(alternative.confidence, `${itemPath}.confidence`, issues);
  });
}

function addLegacyEntityId(id, path, issues, state, kind) {
  validateIdentifier(id, path, issues);
  if (typeof id !== 'string') return;
  if (state.entityIds.has(id)) issues.push(`${path} must be unique across lines and words`);
  state.entityIds.add(id);
  state[`${kind}Ids`].add(id);
}

function validateLegacyWord(value, path, raster, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'alternatives', 'language',
  ]), path, issues);
  addLegacyEntityId(value.id, `${path}.id`, issues, state, 'word');
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  if (value.polygon !== undefined) {
    validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  }
  if (value.boundingBox !== undefined) {
    validateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  }
  validateLegacyAlternatives(value.alternatives, `${path}.alternatives`, issues);
  if (value.language !== undefined) validateLegacyLanguage(value.language, `${path}.language`, issues);
  state.totalWords += 1;
}

function validateLegacyLine(value, path, raster, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'words', 'alternatives',
    'language', 'writingDirection',
  ]), path, issues);
  addLegacyEntityId(value.id, `${path}.id`, issues, state, 'line');
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  if (value.boundingBox !== undefined) {
    validateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  }
  validateLegacyAlternatives(value.alternatives, `${path}.alternatives`, issues);
  validateLegacyLanguage(value.language, `${path}.language`, issues);
  if (!['ltr', 'rtl', 'ttb', 'btt', 'unknown'].includes(value.writingDirection)) {
    issues.push(`${path}.writingDirection is unsupported`);
  }
  if (value.words !== undefined) {
    if (!Array.isArray(value.words)) {
      issues.push(`${path}.words must be an array`);
    } else {
      value.words.forEach((word, index) => {
        if (state.totalWords < OCR_CONTRACT_LIMITS.maxWordsPerPage) {
          validateLegacyWord(word, `${path}.words[${index}]`, raster, issues, state);
        }
      });
    }
  }
  state.totalLines += 1;
}

function validateLegacyBlock(value, index, raster, issues, state) {
  const path = `legacyResult.blocks[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['id', 'kind', 'text', 'confidence', 'polygon', 'lines']), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (typeof value.id === 'string' && state.blockIds.has(value.id)) issues.push(`${path}.id must be unique`);
  if (typeof value.id === 'string') {
    state.blockIds.add(value.id);
    state.warningEntityIds.add(value.id);
  }
  if (!['text', 'unknown'].includes(value.kind)) issues.push(`${path}.kind is unsupported`);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    issues.push(`${path}.lines must be a non-empty array`);
  } else {
    value.lines.forEach((line, lineIndex) => {
      if (state.totalLines < OCR_CONTRACT_LIMITS.maxLinesPerPage) {
        validateLegacyLine(line, `${path}.lines[${lineIndex}]`, raster, issues, state);
      }
    });
  }
}

function validateLegacyPageTransform(value, raster, issues) {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push('legacyResult.pageTransform must be null or an object');
    return;
  }
  requireExactKeys(value, new Set([
    'sourceSpace', 'targetSpace', 'matrix', 'inverseMatrix', 'sourceSize', 'targetSize', 'rotationDegrees',
  ]), 'legacyResult.pageTransform', issues);
  if (value.sourceSpace !== 'ocr-image-pixels') issues.push('legacyResult.pageTransform.sourceSpace is unsupported');
  if (value.targetSpace !== 'pdf-page-points') issues.push('legacyResult.pageTransform.targetSpace is unsupported');
  validateAffineInverse(value.matrix, value.inverseMatrix, 'legacyResult.pageTransform', issues);
  for (const [name, size] of [['sourceSize', value.sourceSize], ['targetSize', value.targetSize]]) {
    if (!isObject(size)) {
      issues.push(`legacyResult.pageTransform.${name} must be an object`);
    } else {
      requireExactKeys(size, new Set(['width', 'height']), `legacyResult.pageTransform.${name}`, issues);
      validatePositiveNumber(size.width, `legacyResult.pageTransform.${name}.width`, issues);
      validatePositiveNumber(size.height, `legacyResult.pageTransform.${name}.height`, issues);
    }
  }
  if (isFiniteNumber(value.sourceSize?.width) && value.sourceSize.width !== raster?.widthPx) {
    issues.push('legacyResult.pageTransform.sourceSize.width must match page.raster.widthPx');
  }
  if (isFiniteNumber(value.sourceSize?.height) && value.sourceSize.height !== raster?.heightPx) {
    issues.push('legacyResult.pageTransform.sourceSize.height must match page.raster.heightPx');
  }
  if (![0, 90, 180, 270].includes(value.rotationDegrees)) {
    issues.push('legacyResult.pageTransform.rotationDegrees is unsupported');
  }
}

function validateLegacyMetrics(value, issues) {
  if (!isObject(value)) {
    issues.push('legacyResult.metrics must be an object');
    return;
  }
  requireExactKeys(value, new Set(METRIC_KEYS), 'legacyResult.metrics', issues);
  for (const key of METRIC_KEYS) validateNonNegativeNumber(value[key], `legacyResult.metrics.${key}`, issues);
}

function validateLegacyUnpublishedResult(value) {
  const issues = [];
  validateJsonValue(value, 'legacyResult', issues);
  if (!validateSerializedSize(value, 'legacyResult', issues, OCR_CONTRACT_LIMITS.maxResultBytes)) return issues;
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'engine', 'document', 'page', 'text',
    'blocks', 'languages', 'warnings', 'unsupportedContentReasons', 'preprocessing',
    'pageTransform', 'metrics', 'reviewCorrections', 'visibleEditRegions',
  ]), 'legacyResult', issues);
  if (value.contract !== OCR_RESULT_CONTRACT) issues.push(`legacyResult.contract must be ${OCR_RESULT_CONTRACT}`);
  if (value.schemaVersion !== 2) issues.push('legacyResult.schemaVersion must be 2');
  validateIdentifier(value.jobId, 'legacyResult.jobId', issues);
  issues.push(...validateLegacyUnpublishedEngineV2(value.engine, 'legacyResult.engine'));
  if (!isObject(value.document)) {
    issues.push('legacyResult.document must be an object');
  } else {
    requireExactKeys(value.document, new Set(['id', 'fingerprint']), 'legacyResult.document', issues);
    validateIdentifier(value.document.id, 'legacyResult.document.id', issues);
    if (value.document.fingerprint !== undefined) {
      validateFingerprint(value.document.fingerprint, 'legacyResult.document.fingerprint', issues);
    }
  }
  let raster = null;
  if (!isObject(value.page)) {
    issues.push('legacyResult.page must be an object');
  } else {
    requireExactKeys(value.page, new Set(['id', 'index', 'status', 'raster']), 'legacyResult.page', issues);
    validateIdentifier(value.page.id, 'legacyResult.page.id', issues);
    validateNonNegativeInteger(value.page.index, 'legacyResult.page.index', issues);
    if (!OCR_RESULT_PAGE_STATUSES.includes(value.page.status)) issues.push('legacyResult.page.status is unsupported');
    raster = value.page.raster;
    if (!isObject(raster)) {
      issues.push('legacyResult.page.raster must be an object');
    } else {
      requireExactKeys(raster, new Set(['widthPx', 'heightPx', 'scale']), 'legacyResult.page.raster', issues);
      validatePositiveInteger(raster.widthPx, 'legacyResult.page.raster.widthPx', issues);
      validatePositiveInteger(raster.heightPx, 'legacyResult.page.raster.heightPx', issues);
      validatePositiveNumber(raster.scale, 'legacyResult.page.raster.scale', issues);
    }
  }
  validateString(value.text, 'legacyResult.text', issues);
  const state = {
    blockIds: new Set(),
    lineIds: new Set(),
    wordIds: new Set(),
    entityIds: new Set(),
    warningEntityIds: new Set(),
    totalLines: 0,
    totalWords: 0,
  };
  if (!Array.isArray(value.blocks)) {
    issues.push('legacyResult.blocks must be an array');
  } else {
    if (value.blocks.length > OCR_CONTRACT_LIMITS.maxBlocksPerPage) {
      issues.push(`legacyResult.blocks exceeds ${OCR_CONTRACT_LIMITS.maxBlocksPerPage} items`);
    }
    value.blocks.slice(0, OCR_CONTRACT_LIMITS.maxBlocksPerPage)
      .forEach((block, index) => validateLegacyBlock(block, index, raster, issues, state));
  }
  for (const id of state.entityIds) state.warningEntityIds.add(id);
  const legacyLineCount = legacyLines(value).length;
  const legacyWordCount = legacyLines(value)
    .reduce((count, line) => count + (Array.isArray(line?.words) ? line.words.length : 0), 0);
  if (legacyLineCount > OCR_CONTRACT_LIMITS.maxLinesPerPage) {
    issues.push(`legacyResult exceeds ${OCR_CONTRACT_LIMITS.maxLinesPerPage} lines`);
  }
  if (legacyWordCount > OCR_CONTRACT_LIMITS.maxWordsPerPage) {
    issues.push(`legacyResult exceeds ${OCR_CONTRACT_LIMITS.maxWordsPerPage} words`);
  }
  if (!Array.isArray(value.languages)) {
    issues.push('legacyResult.languages must be an array');
  } else {
    const tags = new Set();
    value.languages.forEach((language, index) => {
      validateLegacyLanguage(language, `legacyResult.languages[${index}]`, issues);
      if (tags.has(language?.tag)) issues.push(`legacyResult.languages[${index}].tag must be unique`);
      tags.add(language?.tag);
    });
  }
  if (!Array.isArray(value.warnings)) {
    issues.push('legacyResult.warnings must be an array');
  } else {
    if (value.warnings.length > OCR_CONTRACT_LIMITS.maxWarningsPerPage) {
      issues.push(`legacyResult.warnings exceeds ${OCR_CONTRACT_LIMITS.maxWarningsPerPage} items`);
    }
    value.warnings.slice(0, OCR_CONTRACT_LIMITS.maxWarningsPerPage).forEach((warning, index) => {
      const path = `legacyResult.warnings[${index}]`;
      if (!isObject(warning)) {
        issues.push(`${path} must be an object`);
        return;
      }
      requireExactKeys(warning, new Set(['code', 'message', 'severity', 'entityIds']), path, issues);
      validateIdentifier(warning.code, `${path}.code`, issues);
      validateString(warning.message, `${path}.message`, issues, { nonEmpty: true });
      if (!['info', 'warning', 'error'].includes(warning.severity)) issues.push(`${path}.severity is unsupported`);
      if (warning.entityIds !== undefined) {
        if (!Array.isArray(warning.entityIds)) {
          issues.push(`${path}.entityIds must be an array`);
        } else {
          const seen = new Set();
          warning.entityIds.forEach((id, entityIndex) => {
            validateIdentifier(id, `${path}.entityIds[${entityIndex}]`, issues);
            if (seen.has(id)) issues.push(`${path}.entityIds[${entityIndex}] must be unique`);
            if (!state.warningEntityIds.has(id)) issues.push(`${path}.entityIds[${entityIndex}] is unknown`);
            seen.add(id);
          });
        }
      }
    });
  }
  if (!Array.isArray(value.unsupportedContentReasons)) {
    issues.push('legacyResult.unsupportedContentReasons must be an array');
  } else {
    if (value.unsupportedContentReasons.length > OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage) {
      issues.push(`legacyResult.unsupportedContentReasons exceeds ${OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage} items`);
    }
    value.unsupportedContentReasons.slice(0, OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage).forEach((reason, index) => {
      const path = `legacyResult.unsupportedContentReasons[${index}]`;
      if (!isObject(reason)) {
        issues.push(`${path} must be an object`);
        return;
      }
      requireExactKeys(reason, new Set(['code', 'message', 'polygon']), path, issues);
      if (!OCR_UNSUPPORTED_CONTENT_CODES.includes(reason.code)) issues.push(`${path}.code is unsupported`);
      validateString(reason.message, `${path}.message`, issues, { nonEmpty: true });
      if (reason.polygon !== undefined) {
        validatePolygon(reason.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
      }
    });
  }
  if (!isObject(value.preprocessing)) {
    issues.push('legacyResult.preprocessing must be an object');
  } else {
    requireExactKeys(value.preprocessing, new Set(['status', 'operations']), 'legacyResult.preprocessing', issues);
    if (!['unknown', 'none', 'applied'].includes(value.preprocessing.status)) {
      issues.push('legacyResult.preprocessing.status is unsupported');
    }
    if (!Array.isArray(value.preprocessing.operations)) {
      issues.push('legacyResult.preprocessing.operations must be an array');
    } else {
      if (value.preprocessing.operations.length > OCR_CONTRACT_LIMITS.maxPreprocessingOperations) {
        issues.push(`legacyResult.preprocessing.operations exceeds ${OCR_CONTRACT_LIMITS.maxPreprocessingOperations} items`);
      }
      value.preprocessing.operations.slice(0, OCR_CONTRACT_LIMITS.maxPreprocessingOperations).forEach((operation, index) => {
        const path = `legacyResult.preprocessing.operations[${index}]`;
        if (!isObject(operation)) {
          issues.push(`${path} must be an object`);
          return;
        }
        requireExactKeys(operation, new Set(['kind', 'applied', 'value', 'unit']), path, issues);
        if (!['orientation', 'deskew', 'denoise', 'contrast', 'binarize', 'resize', 'crop'].includes(operation.kind)) {
          issues.push(`${path}.kind is unsupported`);
        }
        if (typeof operation.applied !== 'boolean') issues.push(`${path}.applied must be boolean`);
        if (operation.value !== undefined && typeof operation.value !== 'string' && !isFiniteNumber(operation.value)) {
          issues.push(`${path}.value must be a finite number or string`);
        }
        if (operation.unit !== undefined) validateString(operation.unit, `${path}.unit`, issues, { nonEmpty: true, maxCodeUnits: 64 });
      });
      if (value.preprocessing.status !== 'applied' && value.preprocessing.operations.length > 0) {
        issues.push('legacyResult.preprocessing.operations requires applied status');
      }
      if (value.preprocessing.status === 'applied' &&
          !value.preprocessing.operations.some((operation) => operation?.applied === true)) {
        issues.push('legacyResult.preprocessing applied status requires an applied operation');
      }
    }
  }
  validateLegacyPageTransform(value.pageTransform, raster, issues);
  validateLegacyMetrics(value.metrics, issues);
  if (!Array.isArray(value.reviewCorrections)) {
    issues.push('legacyResult.reviewCorrections must be an array');
  } else {
    const ids = new Set();
    value.reviewCorrections.forEach((correction, index) => {
      const path = `legacyResult.reviewCorrections[${index}]`;
      if (!isObject(correction)) {
        issues.push(`${path} must be an object`);
        return;
      }
      requireExactKeys(correction, new Set([
        'id', 'target', 'originalText', 'correctedText', 'status', 'createdAt',
      ]), path, issues);
      validateIdentifier(correction.id, `${path}.id`, issues);
      if (ids.has(correction.id)) issues.push(`${path}.id must be unique`);
      ids.add(correction.id);
      if (!isObject(correction.target)) {
        issues.push(`${path}.target must be an object`);
      } else {
        requireExactKeys(correction.target, new Set(['kind', 'id']), `${path}.target`, issues);
        if (!['line', 'word'].includes(correction.target.kind)) issues.push(`${path}.target.kind is unsupported`);
        validateIdentifier(correction.target.id, `${path}.target.id`, issues);
        const targetIds = correction.target.kind === 'word' ? state.wordIds : state.lineIds;
        if (!targetIds.has(correction.target.id)) issues.push(`${path}.target.id does not identify a result entity`);
      }
      validateString(correction.originalText, `${path}.originalText`, issues);
      validateString(correction.correctedText, `${path}.correctedText`, issues);
      if (!['pending', 'accepted', 'rejected'].includes(correction.status)) issues.push(`${path}.status is unsupported`);
      validateIsoTimestamp(correction.createdAt, `${path}.createdAt`, issues);
    });
  }
  if (!Array.isArray(value.visibleEditRegions)) {
    issues.push('legacyResult.visibleEditRegions must be an array');
  } else {
    const ids = new Set();
    value.visibleEditRegions.forEach((region, index) => {
      const path = `legacyResult.visibleEditRegions[${index}]`;
      if (!isObject(region)) {
        issues.push(`${path} must be an object`);
        return;
      }
      requireExactKeys(region, new Set([
        'id', 'lineIds', 'polygon', 'eligibility', 'background', 'status', 'unsupportedReasons',
      ]), path, issues);
      validateIdentifier(region.id, `${path}.id`, issues);
      if (ids.has(region.id)) issues.push(`${path}.id must be unique`);
      ids.add(region.id);
      if (!Array.isArray(region.lineIds) || region.lineIds.length === 0) {
        issues.push(`${path}.lineIds must be a non-empty array`);
      } else {
        const lineIds = new Set();
        region.lineIds.forEach((id, lineIndex) => {
          validateIdentifier(id, `${path}.lineIds[${lineIndex}]`, issues);
          if (lineIds.has(id)) issues.push(`${path}.lineIds[${lineIndex}] must be unique`);
          if (!state.lineIds.has(id)) issues.push(`${path}.lineIds[${lineIndex}] is unknown`);
          lineIds.add(id);
        });
      }
      validatePolygon(region.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
      if (!['unknown', 'eligible', 'ineligible'].includes(region.eligibility)) issues.push(`${path}.eligibility is unsupported`);
      if (!['unknown', 'flat', 'complex'].includes(region.background)) issues.push(`${path}.background is unsupported`);
      if (!['candidate', 'approved', 'rejected'].includes(region.status)) issues.push(`${path}.status is unsupported`);
      if (!Array.isArray(region.unsupportedReasons)) {
        issues.push(`${path}.unsupportedReasons must be an array`);
      } else {
        const reasons = new Set();
        region.unsupportedReasons.forEach((reason, reasonIndex) => {
          if (!OCR_UNSUPPORTED_CONTENT_CODES.includes(reason)) issues.push(`${path}.unsupportedReasons[${reasonIndex}] is unsupported`);
          if (reasons.has(reason)) issues.push(`${path}.unsupportedReasons[${reasonIndex}] must be unique`);
          reasons.add(reason);
        });
      }
    });
  }
  if (['failed', 'cancelled'].includes(value.page?.status) && ((value.blocks?.length ?? 0) > 0 || value.text !== '')) {
    issues.push(`legacyResult ${value.page.status} state must not contain recognition data`);
  }
  issues.push(...validateLegacyPaddleClaims(value));
  return issues;
}

export function migrateUnpublishedOcrResultV2ToCurrent(value, options = {}) {
  if (!isObject(value) || value.contract !== OCR_RESULT_CONTRACT || value.schemaVersion !== 2 ||
      !Object.hasOwn(value, 'reviewCorrections')) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, ['value is not the unpublished mixed-state result v2 shape']);
  }
  const legacyIssues = validateLegacyUnpublishedResult(value);
  if (legacyIssues.length > 0) throw new OcrContractError(OCR_RESULT_CONTRACT, legacyIssues);
  validateMigrationIdentity({
    ...options,
    documentId: options.documentId ?? value.document?.id,
  }, value.page?.index);
  const requestId = options.requestId ?? value.jobId;
  const jobId = options.jobId ?? value.jobId;
  const engine = migrateOcrEngineToCurrent(value.engine, { modelPack: options.modelPack });
  const sourceLines = legacyLines(value);
  const result = toValidatedOcrResultV2Json({
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    jobId,
    requestId,
    engine,
    document: {
      id: options.documentId ?? value.document.id,
      fingerprint: structuredClone(options.documentFingerprint),
      revision: options.documentRevision,
      generation: options.documentGeneration,
      pageCount: options.documentPageCount,
    },
    page: {
      id: options.pageId,
      index: value.page.index,
      revision: options.pageRevision,
      status: value.page.status,
    },
    recognitionConfigurationHash: structuredClone(options.recognitionConfigurationHash),
    sourceRaster: {
      id: options.sourceRasterId,
      fingerprint: structuredClone(options.sourceRasterFingerprint),
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      widthPx: value.page.raster.widthPx,
      heightPx: value.page.raster.heightPx,
      dpi: options.rasterDpi,
    },
    text: value.text,
    lines: sourceLines.map((line) => migratedLineFromV1({
      id: line.id,
      text: line.text,
      confidence: line.confidence,
      boundingBox: line.boundingBox ?? polygonBounds(line.polygon),
      polygon: line.polygon,
    })),
    detectedLanguages: [],
    warnings: value.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      severity: warning.severity,
      entityIds: structuredClone(warning.entityIds ?? []),
    })),
    unsupportedContentReasons: value.unsupportedContentReasons.map((reason, index) => ({
      id: `legacy-reason-${index + 1}`,
      code: reason.code,
      message: reason.message,
      ...(reason.polygon === undefined ? {} : {
        polygon: {
          coordinateSpace: OCR_SOURCE_RASTER_SPACE,
          points: reason.polygon.map((point) => [...point]),
        },
      }),
    })),
    preprocessing: {
      status: 'unknown',
      operations: [],
      outputRaster: null,
      transform: null,
    },
    metrics: structuredClone(value.metrics),
  });
  const stateIssues = [];
  validateIdentifier(options.stateId, 'migration.stateId', stateIssues);
  validateNonNegativeInteger(options.stateRevision, 'migration.stateRevision', stateIssues);
  validateString(options.stateUpdatedAt, 'migration.stateUpdatedAt', stateIssues, { nonEmpty: true, maxCodeUnits: 64 });
  if (stateIssues.length > 0) throw new OcrContractError(OCR_DOCUMENT_STATE_CONTRACT, stateIssues);
  const documentState = toValidatedOcrDocumentStateV1Json({
    contract: OCR_DOCUMENT_STATE_CONTRACT,
    schemaVersion: OCR_DOCUMENT_STATE_SCHEMA_VERSION,
    stateId: options.stateId,
    document: structuredClone(result.document),
    stateRevision: options.stateRevision,
    pages: [{
      id: result.page.id,
      index: result.page.index,
      revision: result.page.revision,
      resultRef: migratedResultRef(result),
      applicationStatus: 'idle',
      reviewStatus: 'unreviewed',
      corrections: value.reviewCorrections.map((correction) => ({
        ...structuredClone(correction),
        updatedAt: correction.createdAt,
      })),
      estimatedBaselines: [],
      visibleEditRegions: value.visibleEditRegions.map((region) => ({
        ...structuredClone(region),
        polygon: {
          coordinateSpace: OCR_SOURCE_RASTER_SPACE,
          points: region.polygon.map((point) => [...point]),
        },
      })),
    }],
    undo: {
      generation: 0,
      undoDepth: 0,
      redoDepth: 0,
      lastOperationId: null,
    },
    updatedAt: options.stateUpdatedAt,
  });
  let pageGeometry = null;
  if (value.pageTransform !== null && options.pageGeometry === undefined) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, [
      'legacy pageTransform is incomplete; a full pageGeometry contract with page boxes, UserUnit, rotations, and raster identity is required',
    ]);
  }
  if (options.pageGeometry !== undefined && options.pageGeometry !== null) {
    pageGeometry = toValidatedOcrPageGeometryV1Json(options.pageGeometry);
    if (pageGeometry.document.id !== result.document.id || pageGeometry.page.id !== result.page.id ||
        pageGeometry.sourceRaster.id !== result.sourceRaster.id) {
      throw new OcrContractError(OCR_RESULT_CONTRACT, ['pageGeometry identity must match the migrated result']);
    }
  }
  return { result: toValidatedOcrResultV2Json(result), documentState, pageGeometry };
}

function polygonBounds(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
