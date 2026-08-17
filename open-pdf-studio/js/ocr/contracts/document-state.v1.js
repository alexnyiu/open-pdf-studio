import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isObject,
  requireExactKeys,
  validateFingerprint,
  validateIdentifier,
  validateIsoTimestamp,
  validateJsonValue,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSerializedSize,
  validateString,
} from './validation.js';
import {
  OCR_PREPROCESSED_RASTER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  validateBaseline,
  validateCoordinatePolygon,
} from './geometry.js';
import { validateOcrModelPackIdentity } from './model-pack.v1.js';

export const OCR_DOCUMENT_STATE_CONTRACT = 'open-pdf-studio.ocr.document-state';
export const OCR_DOCUMENT_STATE_SCHEMA_VERSION = 1;

export const OCR_APPLICATION_PAGE_STATUSES = Object.freeze(['idle', 'applying', 'applied', 'skipped']);
export const OCR_REVIEW_STATUSES = Object.freeze(['unreviewed', 'in-review', 'accepted', 'rejected']);

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

function validateResultRef(value, path, issues) {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push(`${path} must be null or an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'jobId', 'requestId', 'engineId', 'modelPack', 'documentRevision',
    'documentGeneration', 'pageRevision', 'sourceRasterId',
    'sourceRasterFingerprint', 'recognitionConfigurationHash',
  ]), path, issues);
  for (const key of ['jobId', 'requestId', 'engineId', 'documentGeneration', 'sourceRasterId']) {
    validateIdentifier(value[key], `${path}.${key}`, issues);
  }
  const modelValidation = validateOcrModelPackIdentity(value.modelPack, `${path}.modelPack`);
  issues.push(...modelValidation.issues);
  validateNonNegativeInteger(value.documentRevision, `${path}.documentRevision`, issues);
  validateNonNegativeInteger(value.pageRevision, `${path}.pageRevision`, issues);
  validateFingerprint(value.sourceRasterFingerprint, `${path}.sourceRasterFingerprint`, issues);
  validateFingerprint(value.recognitionConfigurationHash, `${path}.recognitionConfigurationHash`, issues);
}

function validateCorrection(value, path, issues, ids) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'target', 'originalText', 'correctedText', 'status', 'createdAt', 'updatedAt',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (ids.has(value.id)) issues.push(`${path}.id must be unique`);
  ids.add(value.id);
  if (!isObject(value.target)) {
    issues.push(`${path}.target must be an object`);
  } else {
    requireExactKeys(value.target, new Set(['kind', 'id']), `${path}.target`, issues);
    if (!['line', 'word'].includes(value.target.kind)) issues.push(`${path}.target.kind is unsupported`);
    validateIdentifier(value.target.id, `${path}.target.id`, issues);
  }
  validateString(value.originalText, `${path}.originalText`, issues);
  validateString(value.correctedText, `${path}.correctedText`, issues);
  if (!['pending', 'accepted', 'rejected'].includes(value.status)) issues.push(`${path}.status is unsupported`);
  validateIsoTimestamp(value.createdAt, `${path}.createdAt`, issues);
  validateIsoTimestamp(value.updatedAt, `${path}.updatedAt`, issues);
  if (Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt)) &&
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push(`${path}.updatedAt must not precede createdAt`);
  }
}

function validateEstimatedBaseline(value, path, issues, ids) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['id', 'lineId', 'baseline', 'createdAt', 'updatedAt']), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (ids.has(value.id)) issues.push(`${path}.id must be unique`);
  ids.add(value.id);
  validateIdentifier(value.lineId, `${path}.lineId`, issues);
  validateBaseline(value.baseline, `${path}.baseline`, issues, {
    allowedSpaces: [OCR_SOURCE_RASTER_SPACE, OCR_PREPROCESSED_RASTER_SPACE],
    allowedProvenance: ['estimated'],
  });
  if (value.baseline?.status !== 'provided') issues.push(`${path}.baseline must contain an estimated baseline`);
  validateIsoTimestamp(value.createdAt, `${path}.createdAt`, issues);
  validateIsoTimestamp(value.updatedAt, `${path}.updatedAt`, issues);
  if (Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt)) &&
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push(`${path}.updatedAt must not precede createdAt`);
  }
}

function validateEditRegion(value, path, issues, ids) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'lineIds', 'polygon', 'eligibility', 'background', 'status', 'unsupportedReasons',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (ids.has(value.id)) issues.push(`${path}.id must be unique`);
  ids.add(value.id);
  if (!Array.isArray(value.lineIds) || value.lineIds.length === 0) {
    issues.push(`${path}.lineIds must be a non-empty array`);
  } else {
    const lineIds = new Set();
    value.lineIds.forEach((lineId, index) => {
      validateIdentifier(lineId, `${path}.lineIds[${index}]`, issues);
      if (lineIds.has(lineId)) issues.push(`${path}.lineIds[${index}] must be unique`);
      lineIds.add(lineId);
    });
  }
  validateCoordinatePolygon(value.polygon, `${path}.polygon`, issues, {
    allowedSpaces: [OCR_SOURCE_RASTER_SPACE, OCR_PREPROCESSED_RASTER_SPACE],
  });
  if (!['unknown', 'eligible', 'ineligible'].includes(value.eligibility)) issues.push(`${path}.eligibility is unsupported`);
  if (!['unknown', 'flat', 'complex'].includes(value.background)) issues.push(`${path}.background is unsupported`);
  if (!['candidate', 'approved', 'rejected'].includes(value.status)) issues.push(`${path}.status is unsupported`);
  if (!Array.isArray(value.unsupportedReasons)) {
    issues.push(`${path}.unsupportedReasons must be an array`);
  } else {
    const seen = new Set();
    value.unsupportedReasons.forEach((reason, index) => {
      validateIdentifier(reason, `${path}.unsupportedReasons[${index}]`, issues);
      if (seen.has(reason)) issues.push(`${path}.unsupportedReasons[${index}] must be unique`);
      seen.add(reason);
    });
  }
}

function validatePage(value, index, pageCount, issues, state) {
  const path = `pages[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'index', 'revision', 'resultRef', 'applicationStatus', 'reviewStatus',
    'corrections', 'estimatedBaselines', 'visibleEditRegions',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (state.pageIds.has(value.id)) issues.push(`${path}.id must be unique`);
  state.pageIds.add(value.id);
  validateNonNegativeInteger(value.index, `${path}.index`, issues);
  if (state.pageIndexes.has(value.index)) issues.push(`${path}.index must be unique`);
  state.pageIndexes.add(value.index);
  if (Number.isSafeInteger(value.index) && Number.isSafeInteger(pageCount) && value.index >= pageCount) {
    issues.push(`${path}.index must identify a page in document.pageCount`);
  }
  validateNonNegativeInteger(value.revision, `${path}.revision`, issues);
  validateResultRef(value.resultRef, `${path}.resultRef`, issues);
  if (!OCR_APPLICATION_PAGE_STATUSES.includes(value.applicationStatus)) issues.push(`${path}.applicationStatus is unsupported`);
  if (!OCR_REVIEW_STATUSES.includes(value.reviewStatus)) issues.push(`${path}.reviewStatus is unsupported`);
  if (['applying', 'applied'].includes(value.applicationStatus) && value.resultRef === null) {
    issues.push(`${path}.resultRef is required while applying or after applying OCR`);
  }
  if (['in-review', 'accepted', 'rejected'].includes(value.reviewStatus) && value.resultRef === null) {
    issues.push(`${path}.resultRef is required for reviewed OCR state`);
  }
  if (!Array.isArray(value.corrections)) {
    issues.push(`${path}.corrections must be an array`);
  } else {
    if (value.corrections.length > OCR_CONTRACT_LIMITS.maxCorrectionsPerPage) {
      issues.push(`${path}.corrections exceeds ${OCR_CONTRACT_LIMITS.maxCorrectionsPerPage} items`);
    }
    value.corrections.slice(0, OCR_CONTRACT_LIMITS.maxCorrectionsPerPage)
      .forEach((entry, correctionIndex) => validateCorrection(entry, `${path}.corrections[${correctionIndex}]`, issues, state.correctionIds));
  }
  if (!Array.isArray(value.estimatedBaselines)) {
    issues.push(`${path}.estimatedBaselines must be an array`);
  } else {
    value.estimatedBaselines.slice(0, OCR_CONTRACT_LIMITS.maxLinesPerPage)
      .forEach((entry, baselineIndex) => validateEstimatedBaseline(entry, `${path}.estimatedBaselines[${baselineIndex}]`, issues, state.baselineIds));
  }
  if (!Array.isArray(value.visibleEditRegions)) {
    issues.push(`${path}.visibleEditRegions must be an array`);
  } else {
    if (value.visibleEditRegions.length > OCR_CONTRACT_LIMITS.maxEditRegionsPerPage) {
      issues.push(`${path}.visibleEditRegions exceeds ${OCR_CONTRACT_LIMITS.maxEditRegionsPerPage} items`);
    }
    value.visibleEditRegions.slice(0, OCR_CONTRACT_LIMITS.maxEditRegionsPerPage)
      .forEach((entry, regionIndex) => validateEditRegion(entry, `${path}.visibleEditRegions[${regionIndex}]`, issues, state.regionIds));
  }
}

function validateUndo(value, issues) {
  if (!isObject(value)) {
    issues.push('undo must be an object');
    return;
  }
  requireExactKeys(value, new Set(['generation', 'undoDepth', 'redoDepth', 'lastOperationId']), 'undo', issues);
  validateNonNegativeInteger(value.generation, 'undo.generation', issues);
  validateNonNegativeInteger(value.undoDepth, 'undo.undoDepth', issues);
  validateNonNegativeInteger(value.redoDepth, 'undo.redoDepth', issues);
  if (value.lastOperationId !== null) validateIdentifier(value.lastOperationId, 'undo.lastOperationId', issues);
}

export function validateOcrDocumentStateV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxDocumentStateBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['document OCR state must be an object'] };
  validateJsonValue(value, 'documentState', issues);
  if (!validateSerializedSize(value, 'documentState', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'stateId', 'document', 'stateRevision', 'pages', 'undo', 'updatedAt',
  ]), 'documentState', issues);
  if (value.contract !== OCR_DOCUMENT_STATE_CONTRACT) issues.push(`contract must be ${OCR_DOCUMENT_STATE_CONTRACT}`);
  if (value.schemaVersion !== OCR_DOCUMENT_STATE_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.stateId, 'stateId', issues);
  validateDocument(value.document, issues);
  validateNonNegativeInteger(value.stateRevision, 'stateRevision', issues);
  if (!Array.isArray(value.pages)) {
    issues.push('pages must be an array');
  } else {
    if (value.pages.length > OCR_CONTRACT_LIMITS.maxPagesPerJob) {
      issues.push(`pages exceeds ${OCR_CONTRACT_LIMITS.maxPagesPerJob} items`);
    }
    const state = {
      pageIds: new Set(),
      pageIndexes: new Set(),
      correctionIds: new Set(),
      baselineIds: new Set(),
      regionIds: new Set(),
    };
    value.pages.slice(0, OCR_CONTRACT_LIMITS.maxPagesPerJob)
      .forEach((page, index) => validatePage(page, index, value.document?.pageCount, issues, state));
  }
  validateUndo(value.undo, issues);
  validateIsoTimestamp(value.updatedAt, 'updatedAt', issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrDocumentStateV1(value, options) {
  const validation = validateOcrDocumentStateV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_DOCUMENT_STATE_CONTRACT, validation.issues);
  return value;
}

export function toValidatedOcrDocumentStateV1Json(value, options) {
  assertOcrDocumentStateV1(value, options);
  const parsed = JSON.parse(JSON.stringify(value));
  assertOcrDocumentStateV1(parsed, options);
  return parsed;
}
