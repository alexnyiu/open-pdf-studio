import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  assertOcrEngineV1,
  assertOcrResultV1,
} from './v1.js';
import {
  OCR_MODEL_PACK_CONTRACT,
  OCR_MODEL_PACK_SCHEMA_VERSION,
  assertCompatibleOcrModelPack,
  modelPackIdentity,
} from './model-pack.v1.js';
import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateBoundingBox,
  validateConfidence,
  validateIdentifier,
  validateIsoTimestamp,
  validateLanguageTag,
  validateNonNegativeNumber,
  validatePolygon,
  validatePositiveNumber,
  validateSemver,
  validateSerializedSize,
  validateString,
} from './validation.js';

export const OCR_CURRENT_SCHEMA_VERSION = 2;
export const OCR_RESULT_PAGE_STATUSES = Object.freeze([
  'completed',
  'partial',
  'unsupported',
  'failed',
  'cancelled',
]);
export const OCR_WRITING_DIRECTIONS = Object.freeze(['ltr', 'rtl', 'ttb', 'btt', 'unknown']);
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

const ENGINE_CAPABILITIES = [
  'textDetection',
  'textRecognition',
  'blockResults',
  'lineResults',
  'wordResults',
  'linePolygons',
  'wordPolygons',
  'alternatives',
  'languageMetadata',
  'writingDirectionMetadata',
  'preprocessingMetadata',
  'pdfWriting',
];
const METRIC_KEYS = [
  'workerStartupMs',
  'modelStartupMs',
  'rasterMs',
  'detectionMs',
  'recognitionMs',
  'totalOcrMs',
];

function validateModelPackIdentity(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['contract', 'schemaVersion', 'packId', 'packVersion']), path, issues);
  if (value.contract !== OCR_MODEL_PACK_CONTRACT) issues.push(`${path}.contract must be ${OCR_MODEL_PACK_CONTRACT}`);
  if (value.schemaVersion !== OCR_MODEL_PACK_SCHEMA_VERSION) issues.push(`${path}.schemaVersion must be 1`);
  validateIdentifier(value.packId, `${path}.packId`, issues);
  validateSemver(value.packVersion, `${path}.packVersion`, issues);
}

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
  validateModelPackIdentity(value.modelPack, `${path}.modelPack`, issues);

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
    if (value.capabilities.lineResults !== true) issues.push(`${path}.capabilities.lineResults must be true`);
    if (value.capabilities.linePolygons !== true) issues.push(`${path}.capabilities.linePolygons must be true`);
    if (value.capabilities.wordPolygons === true && value.capabilities.wordResults !== true) {
      issues.push(`${path}.capabilities.wordPolygons requires wordResults`);
    }
    if (value.capabilities.pdfWriting !== false) issues.push(`${path}.capabilities.pdfWriting must remain false`);
  }
}

export function validateOcrEngineV2(value) {
  const issues = [];
  validateEngineV2(value, issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrEngineV2(value) {
  const validation = validateOcrEngineV2(value);
  if (!validation.ok) throw new OcrContractError(OCR_ENGINE_CONTRACT, validation.issues);
  return value;
}

function validateFingerprint(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['algorithm', 'value']), path, issues);
  if (value.algorithm !== 'sha256') issues.push(`${path}.algorithm must be sha256`);
  const valid = validateString(value.value, `${path}.value`, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (valid && !/^[0-9a-f]{64}$/.test(value.value)) issues.push(`${path}.value must be a lowercase SHA-256 digest`);
}

function validateDocument(value, issues) {
  if (!isObject(value)) {
    issues.push('document must be an object');
    return;
  }
  requireExactKeys(value, new Set(['id', 'fingerprint']), 'document', issues);
  validateIdentifier(value.id, 'document.id', issues);
  if (value.fingerprint !== undefined) validateFingerprint(value.fingerprint, 'document.fingerprint', issues);
}

function validateRaster(value, issues) {
  if (!isObject(value)) {
    issues.push('page.raster must be an object');
    return;
  }
  requireExactKeys(value, new Set(['widthPx', 'heightPx', 'scale']), 'page.raster', issues);
  if (!Number.isInteger(value.widthPx) || value.widthPx <= 0) issues.push('page.raster.widthPx must be a positive integer');
  if (!Number.isInteger(value.heightPx) || value.heightPx <= 0) issues.push('page.raster.heightPx must be a positive integer');
  validatePositiveNumber(value.scale, 'page.raster.scale', issues);
}

function validatePage(value, issues) {
  if (!isObject(value)) {
    issues.push('page must be an object');
    return;
  }
  requireExactKeys(value, new Set(['id', 'index', 'status', 'raster']), 'page', issues);
  validateIdentifier(value.id, 'page.id', issues);
  if (!Number.isInteger(value.index) || value.index < 0) issues.push('page.index must be a non-negative integer');
  if (!OCR_RESULT_PAGE_STATUSES.includes(value.status)) issues.push('page.status is unsupported');
  validateRaster(value.raster, issues);
}

function validateLanguage(value, path, issues, state = null) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['tag', 'source', 'confidence']), path, issues);
  validateLanguageTag(value.tag, `${path}.tag`, issues);
  if (!['engine', 'requested', 'review', 'unknown'].includes(value.source)) issues.push(`${path}.source is unsupported`);
  if (value.confidence !== undefined) validateConfidence(value.confidence, `${path}.confidence`, issues);
  if (state && value.source === 'engine') state.hasEngineLanguage = true;
}

function validateAlternatives(value, path, issues, state) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxAlternativesPerItem) {
    issues.push(`${path} exceeds ${OCR_CONTRACT_LIMITS.maxAlternativesPerItem} items`);
  }
  const count = Math.min(value.length, OCR_CONTRACT_LIMITS.maxAlternativesPerItem);
  for (let index = 0; index < count; index += 1) {
    const alternative = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(alternative)) {
      issues.push(`${itemPath} must be an object`);
      continue;
    }
    requireExactKeys(alternative, new Set(['text', 'confidence']), itemPath, issues);
    validateString(alternative.text, `${itemPath}.text`, issues);
    validateConfidence(alternative.confidence, `${itemPath}.confidence`, issues);
  }
  if (value.length > 0) state.hasAlternatives = true;
}

function validateWord(value, path, raster, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'alternatives', 'language',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  if (value.polygon !== undefined) {
    validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
    state.hasWordPolygons = true;
  }
  if (value.boundingBox !== undefined) {
    validateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  }
  validateAlternatives(value.alternatives, `${path}.alternatives`, issues, state);
  if (value.language !== undefined) validateLanguage(value.language, `${path}.language`, issues, state);
  state.totalWords += 1;
  if (typeof value.id === 'string' && state.wordIds.has(value.id)) issues.push(`${path}.id must be unique`);
  state.wordIds.add(value.id);
}

function validateLine(value, path, raster, issues, state) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'text', 'confidence', 'polygon', 'boundingBox', 'words', 'alternatives',
    'language', 'writingDirection',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  if (value.boundingBox !== undefined) {
    validateBoundingBox(value.boundingBox, `${path}.boundingBox`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  }
  validateAlternatives(value.alternatives, `${path}.alternatives`, issues, state);
  validateLanguage(value.language, `${path}.language`, issues, state);
  if (!OCR_WRITING_DIRECTIONS.includes(value.writingDirection)) issues.push(`${path}.writingDirection is unsupported`);
  if (value.writingDirection !== 'unknown') state.hasWritingDirection = true;
  if (value.words !== undefined) {
    if (!Array.isArray(value.words)) {
      issues.push(`${path}.words must be an array`);
    } else {
      for (let index = 0; index < value.words.length && state.totalWords <= OCR_CONTRACT_LIMITS.maxWordsPerPage; index += 1) {
        validateWord(value.words[index], `${path}.words[${index}]`, raster, issues, state);
      }
    }
  }
  state.totalLines += 1;
  if (typeof value.id === 'string' && state.lineIds.has(value.id)) issues.push(`${path}.id must be unique`);
  state.lineIds.add(value.id);
}

function validateBlock(value, index, raster, issues, state) {
  const path = `blocks[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['id', 'kind', 'text', 'confidence', 'polygon', 'lines']), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (!['text', 'unknown'].includes(value.kind)) issues.push(`${path}.kind is unsupported`);
  validateString(value.text, `${path}.text`, issues);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validatePolygon(value.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    issues.push(`${path}.lines must be a non-empty array`);
  } else {
    for (let lineIndex = 0; lineIndex < value.lines.length && state.totalLines <= OCR_CONTRACT_LIMITS.maxLinesPerPage; lineIndex += 1) {
      validateLine(value.lines[lineIndex], `${path}.lines[${lineIndex}]`, raster, issues, state);
    }
  }
  if (typeof value.id === 'string' && state.blockIds.has(value.id)) issues.push(`${path}.id must be unique`);
  state.blockIds.add(value.id);
}

function validateWarnings(value, issues) {
  if (!Array.isArray(value)) {
    issues.push('warnings must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxWarningsPerPage) {
    issues.push(`warnings exceeds ${OCR_CONTRACT_LIMITS.maxWarningsPerPage} items`);
  }
  const count = Math.min(value.length, OCR_CONTRACT_LIMITS.maxWarningsPerPage);
  for (let index = 0; index < count; index += 1) {
    const warning = value[index];
    const path = `warnings[${index}]`;
    if (!isObject(warning)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireExactKeys(warning, new Set(['code', 'message', 'severity', 'entityIds']), path, issues);
    validateIdentifier(warning.code, `${path}.code`, issues);
    validateString(warning.message, `${path}.message`, issues, { nonEmpty: true });
    if (!['info', 'warning', 'error'].includes(warning.severity)) issues.push(`${path}.severity is unsupported`);
    if (warning.entityIds !== undefined) {
      if (!Array.isArray(warning.entityIds)) {
        issues.push(`${path}.entityIds must be an array`);
      } else {
        warning.entityIds.forEach((id, entityIndex) => validateIdentifier(id, `${path}.entityIds[${entityIndex}]`, issues));
      }
    }
  }
}

function validateUnsupportedReasons(value, raster, issues) {
  if (!Array.isArray(value)) {
    issues.push('unsupportedContentReasons must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage) {
    issues.push(`unsupportedContentReasons exceeds ${OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage} items`);
  }
  const count = Math.min(value.length, OCR_CONTRACT_LIMITS.maxUnsupportedReasonsPerPage);
  for (let index = 0; index < count; index += 1) {
    const reason = value[index];
    const path = `unsupportedContentReasons[${index}]`;
    if (!isObject(reason)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireExactKeys(reason, new Set(['code', 'message', 'polygon']), path, issues);
    if (!OCR_UNSUPPORTED_CONTENT_CODES.includes(reason.code)) issues.push(`${path}.code is unsupported`);
    validateString(reason.message, `${path}.message`, issues, { nonEmpty: true });
    if (reason.polygon !== undefined) {
      validatePolygon(reason.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
    }
  }
}

function validatePreprocessing(value, issues) {
  if (!isObject(value)) {
    issues.push('preprocessing must be an object');
    return;
  }
  requireExactKeys(value, new Set(['status', 'operations']), 'preprocessing', issues);
  if (!['unknown', 'none', 'applied'].includes(value.status)) issues.push('preprocessing.status is unsupported');
  if (!Array.isArray(value.operations)) {
    issues.push('preprocessing.operations must be an array');
    return;
  }
  if (value.operations.length > 32) issues.push('preprocessing.operations exceeds 32 items');
  const supported = new Set(['orientation', 'deskew', 'denoise', 'contrast', 'binarize', 'resize', 'crop']);
  value.operations.slice(0, 32).forEach((operation, index) => {
    const path = `preprocessing.operations[${index}]`;
    if (!isObject(operation)) {
      issues.push(`${path} must be an object`);
      return;
    }
    requireExactKeys(operation, new Set(['kind', 'applied', 'value', 'unit']), path, issues);
    if (!supported.has(operation.kind)) issues.push(`${path}.kind is unsupported`);
    if (typeof operation.applied !== 'boolean') issues.push(`${path}.applied must be boolean`);
    if (operation.value !== undefined && typeof operation.value !== 'string' && !isFiniteNumber(operation.value)) {
      issues.push(`${path}.value must be a finite number or string`);
    }
    if (typeof operation.value === 'string') validateString(operation.value, `${path}.value`, issues, { maxCodeUnits: 256 });
    if (operation.unit !== undefined) validateString(operation.unit, `${path}.unit`, issues, { nonEmpty: true, maxCodeUnits: 64 });
  });
  if (value.status !== 'applied' && value.operations.length > 0) issues.push('preprocessing.operations must be empty unless status is applied');
  if (value.status === 'applied' && !value.operations.some((operation) => operation?.applied === true)) {
    issues.push('preprocessing.status applied requires an applied operation');
  }
}

function validateSize(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['width', 'height']), path, issues);
  validatePositiveNumber(value.width, `${path}.width`, issues);
  validatePositiveNumber(value.height, `${path}.height`, issues);
}

function validateMatrix(value, path, issues) {
  if (!Array.isArray(value) || value.length !== 6 || !value.every(isFiniteNumber)) {
    issues.push(`${path} must contain six finite numbers`);
    return false;
  }
  const determinant = value[0] * value[3] - value[1] * value[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) {
    issues.push(`${path} must be invertible`);
    return false;
  }
  return true;
}

function affineProduct(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function validatePageTransform(value, raster, issues) {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push('pageTransform must be null or an object');
    return;
  }
  requireExactKeys(value, new Set([
    'sourceSpace', 'targetSpace', 'matrix', 'inverseMatrix', 'sourceSize',
    'targetSize', 'rotationDegrees',
  ]), 'pageTransform', issues);
  if (value.sourceSpace !== 'ocr-image-pixels') issues.push('pageTransform.sourceSpace must be ocr-image-pixels');
  if (value.targetSpace !== 'pdf-page-points') issues.push('pageTransform.targetSpace must be pdf-page-points');
  const matrixValid = validateMatrix(value.matrix, 'pageTransform.matrix', issues);
  const inverseValid = validateMatrix(value.inverseMatrix, 'pageTransform.inverseMatrix', issues);
  validateSize(value.sourceSize, 'pageTransform.sourceSize', issues);
  validateSize(value.targetSize, 'pageTransform.targetSize', issues);
  if (isFiniteNumber(value.sourceSize?.width) && value.sourceSize.width !== raster?.widthPx) {
    issues.push('pageTransform.sourceSize.width must match page.raster.widthPx');
  }
  if (isFiniteNumber(value.sourceSize?.height) && value.sourceSize.height !== raster?.heightPx) {
    issues.push('pageTransform.sourceSize.height must match page.raster.heightPx');
  }
  if (![0, 90, 180, 270].includes(value.rotationDegrees)) issues.push('pageTransform.rotationDegrees is unsupported');
  if (matrixValid && inverseValid) {
    const product = affineProduct(value.matrix, value.inverseMatrix);
    const identity = [1, 0, 0, 1, 0, 0];
    if (product.some((entry, index) => Math.abs(entry - identity[index]) > 1e-6)) {
      issues.push('pageTransform.inverseMatrix must invert pageTransform.matrix');
    }
  }
}

function validateMetrics(value, issues) {
  if (!isObject(value)) {
    issues.push('metrics must be an object');
    return;
  }
  requireExactKeys(value, new Set(METRIC_KEYS), 'metrics', issues);
  for (const key of METRIC_KEYS) validateNonNegativeNumber(value[key], `metrics.${key}`, issues);
}

function validateCorrections(value, issues, state) {
  if (!Array.isArray(value)) {
    issues.push('reviewCorrections must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxCorrectionsPerPage) {
    issues.push(`reviewCorrections exceeds ${OCR_CONTRACT_LIMITS.maxCorrectionsPerPage} items`);
  }
  const ids = new Set();
  const count = Math.min(value.length, OCR_CONTRACT_LIMITS.maxCorrectionsPerPage);
  for (let index = 0; index < count; index += 1) {
    const correction = value[index];
    const path = `reviewCorrections[${index}]`;
    if (!isObject(correction)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireExactKeys(correction, new Set([
      'id', 'target', 'originalText', 'correctedText', 'status', 'createdAt',
    ]), path, issues);
    validateIdentifier(correction.id, `${path}.id`, issues);
    if (typeof correction.id === 'string' && ids.has(correction.id)) issues.push(`${path}.id must be unique`);
    ids.add(correction.id);
    if (!isObject(correction.target)) {
      issues.push(`${path}.target must be an object`);
    } else {
      requireExactKeys(correction.target, new Set(['kind', 'id']), `${path}.target`, issues);
      if (!['line', 'word'].includes(correction.target.kind)) issues.push(`${path}.target.kind is unsupported`);
      validateIdentifier(correction.target.id, `${path}.target.id`, issues);
      const targets = correction.target.kind === 'line' ? state.lineIds : state.wordIds;
      if (typeof correction.target.id === 'string' && !targets.has(correction.target.id)) {
        issues.push(`${path}.target.id does not identify a result entity`);
      }
    }
    validateString(correction.originalText, `${path}.originalText`, issues);
    validateString(correction.correctedText, `${path}.correctedText`, issues);
    if (!['pending', 'accepted', 'rejected'].includes(correction.status)) issues.push(`${path}.status is unsupported`);
    validateIsoTimestamp(correction.createdAt, `${path}.createdAt`, issues);
  }
}

function validateEditRegions(value, raster, issues, state) {
  if (!Array.isArray(value)) {
    issues.push('visibleEditRegions must be an array');
    return;
  }
  if (value.length > OCR_CONTRACT_LIMITS.maxEditRegionsPerPage) {
    issues.push(`visibleEditRegions exceeds ${OCR_CONTRACT_LIMITS.maxEditRegionsPerPage} items`);
  }
  const ids = new Set();
  const count = Math.min(value.length, OCR_CONTRACT_LIMITS.maxEditRegionsPerPage);
  for (let index = 0; index < count; index += 1) {
    const region = value[index];
    const path = `visibleEditRegions[${index}]`;
    if (!isObject(region)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    requireExactKeys(region, new Set([
      'id', 'lineIds', 'polygon', 'eligibility', 'background', 'status',
      'unsupportedReasons',
    ]), path, issues);
    validateIdentifier(region.id, `${path}.id`, issues);
    if (typeof region.id === 'string' && ids.has(region.id)) issues.push(`${path}.id must be unique`);
    ids.add(region.id);
    if (!Array.isArray(region.lineIds) || region.lineIds.length === 0) {
      issues.push(`${path}.lineIds must be a non-empty array`);
    } else {
      const lineIds = new Set();
      region.lineIds.forEach((lineId, lineIndex) => {
        validateIdentifier(lineId, `${path}.lineIds[${lineIndex}]`, issues);
        if (lineIds.has(lineId)) issues.push(`${path}.lineIds[${lineIndex}] must be unique`);
        if (typeof lineId === 'string' && !state.lineIds.has(lineId)) issues.push(`${path}.lineIds[${lineIndex}] is unknown`);
        lineIds.add(lineId);
      });
    }
    validatePolygon(region.polygon, `${path}.polygon`, issues, { width: raster?.widthPx, height: raster?.heightPx });
    if (!['unknown', 'eligible', 'ineligible'].includes(region.eligibility)) issues.push(`${path}.eligibility is unsupported`);
    if (!['unknown', 'flat', 'complex'].includes(region.background)) issues.push(`${path}.background is unsupported`);
    if (!['candidate', 'approved', 'rejected'].includes(region.status)) issues.push(`${path}.status is unsupported`);
    if (!Array.isArray(region.unsupportedReasons)) {
      issues.push(`${path}.unsupportedReasons must be an array`);
    } else {
      region.unsupportedReasons.forEach((code, reasonIndex) => {
        if (!OCR_UNSUPPORTED_CONTENT_CODES.includes(code)) issues.push(`${path}.unsupportedReasons[${reasonIndex}] is unsupported`);
      });
    }
  }
}

export function validateOcrResultV2(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxResultBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['result must be an object'] };
  if (!validateSerializedSize(value, 'result', issues, maxSerializedBytes)) {
    return { ok: false, issues };
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'engine', 'document', 'page', 'text',
    'blocks', 'languages', 'warnings', 'unsupportedContentReasons', 'preprocessing',
    'pageTransform', 'metrics', 'reviewCorrections', 'visibleEditRegions',
  ]), 'result', issues);
  if (value.contract !== OCR_RESULT_CONTRACT) issues.push(`contract must be ${OCR_RESULT_CONTRACT}`);
  if (value.schemaVersion !== OCR_CURRENT_SCHEMA_VERSION) issues.push('schemaVersion must be 2');
  validateIdentifier(value.jobId, 'jobId', issues);
  validateEngineV2(value.engine, issues);
  validateDocument(value.document, issues);
  validatePage(value.page, issues);
  validateString(value.text, 'text', issues);

  const state = {
    blockIds: new Set(),
    lineIds: new Set(),
    wordIds: new Set(),
    totalLines: 0,
    totalWords: 0,
    hasWordPolygons: false,
    hasAlternatives: false,
    hasEngineLanguage: false,
    hasWritingDirection: false,
  };
  if (!Array.isArray(value.blocks)) {
    issues.push('blocks must be an array');
  } else {
    if (value.blocks.length > OCR_CONTRACT_LIMITS.maxBlocksPerPage) {
      issues.push(`blocks exceeds ${OCR_CONTRACT_LIMITS.maxBlocksPerPage} items`);
    }
    const count = Math.min(value.blocks.length, OCR_CONTRACT_LIMITS.maxBlocksPerPage);
    for (let index = 0; index < count; index += 1) {
      validateBlock(value.blocks[index], index, value.page?.raster, issues, state);
    }
  }
  if (state.totalLines > OCR_CONTRACT_LIMITS.maxLinesPerPage) {
    issues.push(`result exceeds ${OCR_CONTRACT_LIMITS.maxLinesPerPage} lines`);
  }
  if (state.totalWords > OCR_CONTRACT_LIMITS.maxWordsPerPage) {
    issues.push(`result exceeds ${OCR_CONTRACT_LIMITS.maxWordsPerPage} words`);
  }

  if (!Array.isArray(value.languages)) {
    issues.push('languages must be an array');
  } else {
    value.languages.forEach((language, index) => validateLanguage(language, `languages[${index}]`, issues, state));
  }
  validateWarnings(value.warnings, issues);
  validateUnsupportedReasons(value.unsupportedContentReasons, value.page?.raster, issues);
  if (value.page?.status === 'unsupported' && value.unsupportedContentReasons?.length === 0) {
    issues.push('unsupported pages require at least one unsupportedContentReason');
  }
  validatePreprocessing(value.preprocessing, issues);
  validatePageTransform(value.pageTransform, value.page?.raster, issues);
  validateMetrics(value.metrics, issues);
  validateCorrections(value.reviewCorrections, issues, state);
  validateEditRegions(value.visibleEditRegions, value.page?.raster, issues, state);

  const capabilities = value.engine?.capabilities;
  if (state.totalWords > 0 && capabilities?.wordResults !== true) issues.push('engine capabilities do not permit word results');
  if (state.hasWordPolygons && capabilities?.wordPolygons !== true) issues.push('engine capabilities do not permit word polygons');
  if (state.hasAlternatives && capabilities?.alternatives !== true) issues.push('engine capabilities do not permit alternatives');
  if (state.hasEngineLanguage && capabilities?.languageMetadata !== true) issues.push('engine capabilities do not permit engine language metadata');
  if (state.hasWritingDirection && capabilities?.writingDirectionMetadata !== true) {
    issues.push('engine capabilities do not permit writing-direction metadata');
  }
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

export function migrateOcrEngineToCurrent(value, { modelPack } = {}) {
  if (!isObject(value) || value.contract !== OCR_ENGINE_CONTRACT) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, [`contract must be ${OCR_ENGINE_CONTRACT}`]);
  }
  if (value.schemaVersion === OCR_CURRENT_SCHEMA_VERSION) return assertOcrEngineV2(value);
  if (value.schemaVersion !== 1) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, [`unsupported schemaVersion ${String(value.schemaVersion)}`]);
  }
  assertOcrEngineV1(value);
  if (modelPack === undefined) {
    throw new OcrContractError(OCR_ENGINE_CONTRACT, ['modelPack metadata is required to migrate engine v1']);
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
    capabilities: {
      textDetection: value.capabilities.textDetection,
      textRecognition: value.capabilities.textRecognition,
      blockResults: true,
      lineResults: true,
      wordResults: value.capabilities.wordBoxes,
      linePolygons: true,
      wordPolygons: value.capabilities.wordBoxes,
      alternatives: false,
      languageMetadata: false,
      writingDirectionMetadata: false,
      preprocessingMetadata: false,
      pdfWriting: value.capabilities.pdfWriting,
    },
  });
}

function migratedUnknownLanguage() {
  return { tag: 'und', source: 'unknown' };
}

export function migrateOcrResultToCurrent(value, {
  modelPack,
  documentId,
  pageId,
  jobId = value?.requestId,
  documentFingerprint,
  pageTransform = null,
} = {}) {
  if (!isObject(value) || value.contract !== OCR_RESULT_CONTRACT) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, [`contract must be ${OCR_RESULT_CONTRACT}`]);
  }
  if (value.schemaVersion === OCR_CURRENT_SCHEMA_VERSION) return toValidatedOcrResultV2Json(value);
  if (value.schemaVersion !== 1) {
    throw new OcrContractError(OCR_RESULT_CONTRACT, [`unsupported schemaVersion ${String(value.schemaVersion)}`]);
  }
  assertOcrResultV1(value);
  const identityIssues = [];
  validateIdentifier(documentId, 'migration.documentId', identityIssues);
  validateIdentifier(pageId, 'migration.pageId', identityIssues);
  validateIdentifier(jobId, 'migration.jobId', identityIssues);
  if (documentFingerprint !== undefined) validateFingerprint(documentFingerprint, 'migration.documentFingerprint', identityIssues);
  if (identityIssues.length > 0) throw new OcrContractError(OCR_RESULT_CONTRACT, identityIssues);
  const engine = migrateOcrEngineToCurrent(value.engine, { modelPack });
  const blocks = value.lines.map((line) => ({
    id: `block:${line.id}`,
    kind: 'text',
    text: line.text,
    confidence: line.confidence,
    polygon: line.polygon.map((point) => [...point]),
    lines: [{
      id: line.id,
      text: line.text,
      confidence: line.confidence,
      polygon: line.polygon.map((point) => [...point]),
      boundingBox: { ...line.boundingBox },
      alternatives: [],
      language: migratedUnknownLanguage(),
      writingDirection: 'unknown',
    }],
  }));
  const document = { id: documentId };
  if (documentFingerprint !== undefined) document.fingerprint = { ...documentFingerprint };
  return toValidatedOcrResultV2Json({
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    jobId,
    engine,
    document,
    page: {
      id: pageId,
      index: value.source.pageIndex,
      status: 'completed',
      raster: {
        widthPx: value.source.widthPx,
        heightPx: value.source.heightPx,
        scale: value.source.scale,
      },
    },
    text: value.text,
    blocks,
    languages: [],
    warnings: value.warnings.map((message) => ({
      code: 'phase-a-warning',
      message,
      severity: 'warning',
    })),
    unsupportedContentReasons: [],
    preprocessing: { status: 'unknown', operations: [] },
    pageTransform,
    metrics: { ...value.metrics },
    reviewCorrections: [],
    visibleEditRegions: [],
  });
}
