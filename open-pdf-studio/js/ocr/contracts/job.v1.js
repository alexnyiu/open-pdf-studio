import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateFingerprint,
  validateIdentifier,
  validateIsoTimestamp,
  validateJsonValue,
  validateLanguageTag,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validatePositiveNumber,
  validateSerializedSize,
  validateString,
} from './validation.js';
import { OCR_SOURCE_RASTER_SPACE, validateRasterIdentity } from './geometry.js';
import { validateOcrModelPackIdentity } from './model-pack.v1.js';

export const OCR_JOB_CONTRACT = 'open-pdf-studio.ocr.job';
export const OCR_PROGRESS_CONTRACT = 'open-pdf-studio.ocr.progress';
export const OCR_JOB_SCHEMA_VERSION = 1;
export const OCR_PROGRESS_SCHEMA_VERSION = 1;

export const OCR_PROGRESS_STAGES = Object.freeze([
  'queued',
  'rasterizing',
  'preprocessing',
  'recognizing',
  'validating',
  'completed',
  'partial',
  'unsupported',
  'failed',
  'cancelled',
]);

const TERMINAL_PROGRESS_STAGES = new Set(['completed', 'partial', 'unsupported', 'failed', 'cancelled']);
const PREPROCESSING_OPERATIONS = new Set(['denoise', 'contrast', 'binarize', 'grayscale']);

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
  requireExactKeys(value, new Set(['id', 'index', 'revision', 'sourceRaster']), 'page', issues);
  validateIdentifier(value.id, 'page.id', issues);
  validateNonNegativeInteger(value.index, 'page.index', issues);
  validateNonNegativeInteger(value.revision, 'page.revision', issues);
  if (Number.isSafeInteger(value.index) && Number.isSafeInteger(pageCount) && value.index >= pageCount) {
    issues.push('page.index must identify a page in document.pageCount');
  }
  validateRasterIdentity(value.sourceRaster, 'page.sourceRaster', issues, {
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
  });
}

function validateLanguagePolicy(value, issues) {
  if (!isObject(value)) {
    issues.push('recognitionOptions.languagePolicy must be an object');
    return;
  }
  requireExactKeys(value, new Set(['mode', 'languages', 'scripts']), 'recognitionOptions.languagePolicy', issues);
  if (!['automatic', 'prefer', 'restrict'].includes(value.mode)) {
    issues.push('recognitionOptions.languagePolicy.mode is unsupported');
  }
  if (!Array.isArray(value.languages)) {
    issues.push('recognitionOptions.languagePolicy.languages must be an array');
  } else {
    const seen = new Set();
    value.languages.forEach((language, index) => {
      validateLanguageTag(language, `recognitionOptions.languagePolicy.languages[${index}]`, issues);
      if (language === 'und') {
        issues.push(`recognitionOptions.languagePolicy.languages[${index}] must not use und as a selector`);
      }
      if (seen.has(language)) issues.push(`recognitionOptions.languagePolicy.languages[${index}] must be unique`);
      seen.add(language);
    });
  }
  if (!Array.isArray(value.scripts)) {
    issues.push('recognitionOptions.languagePolicy.scripts must be an array');
  } else {
    const seen = new Set();
    value.scripts.forEach((script, index) => {
      const valid = validateString(script, `recognitionOptions.languagePolicy.scripts[${index}]`, issues, {
        nonEmpty: true,
        maxCodeUnits: 4,
      });
      if (valid && !/^[A-Z][a-z]{3}$/.test(script)) {
        issues.push(`recognitionOptions.languagePolicy.scripts[${index}] must be an ISO 15924 code`);
      }
      if (seen.has(script)) issues.push(`recognitionOptions.languagePolicy.scripts[${index}] must be unique`);
      seen.add(script);
    });
  }
  if (value.mode === 'automatic' && (value.languages?.length > 0 || value.scripts?.length > 0)) {
    issues.push('automatic language policy must not contain requested languages or scripts');
  }
  if (['prefer', 'restrict'].includes(value.mode) && value.languages?.length === 0 && value.scripts?.length === 0) {
    issues.push(`${value.mode} language policy requires a language or script`);
  }
}

function validateOrientation(value, issues) {
  if (!isObject(value)) {
    issues.push('recognitionOptions.orientation must be an object');
    return;
  }
  requireExactKeys(value, new Set(['mode', 'degrees']), 'recognitionOptions.orientation', issues);
  if (!['none', 'detect', 'fixed'].includes(value.mode)) issues.push('recognitionOptions.orientation.mode is unsupported');
  if (value.mode === 'fixed') {
    if (![0, 90, 180, 270].includes(value.degrees)) {
      issues.push('recognitionOptions.orientation.degrees must be 0, 90, 180, or 270 for fixed orientation');
    }
  } else if (value.degrees !== null) {
    issues.push('recognitionOptions.orientation.degrees must be null unless orientation is fixed');
  }
}

function validatePreprocessingOptions(value, issues) {
  if (!isObject(value)) {
    issues.push('recognitionOptions.preprocessing must be an object');
    return;
  }
  requireExactKeys(value, new Set(['mode', 'operations']), 'recognitionOptions.preprocessing', issues);
  if (!['none', 'standard', 'custom'].includes(value.mode)) issues.push('recognitionOptions.preprocessing.mode is unsupported');
  if (!Array.isArray(value.operations)) {
    issues.push('recognitionOptions.preprocessing.operations must be an array');
    return;
  }
  if (value.operations.length > OCR_CONTRACT_LIMITS.maxPreprocessingOperations) {
    issues.push(`recognitionOptions.preprocessing.operations exceeds ${OCR_CONTRACT_LIMITS.maxPreprocessingOperations} items`);
  }
  const seen = new Set();
  value.operations.forEach((operation, index) => {
    if (!PREPROCESSING_OPERATIONS.has(operation)) {
      issues.push(`recognitionOptions.preprocessing.operations[${index}] is unsupported`);
    }
    if (seen.has(operation)) issues.push(`recognitionOptions.preprocessing.operations[${index}] must be unique`);
    seen.add(operation);
  });
  if (value.mode === 'none' && value.operations.length > 0) {
    issues.push('recognitionOptions.preprocessing.operations must be empty when mode is none');
  }
  if (value.mode === 'custom' && value.operations.length === 0) {
    issues.push('custom preprocessing requires at least one operation');
  }
}

function validateRecognitionOptions(value, page, issues) {
  if (!isObject(value)) {
    issues.push('recognitionOptions must be an object');
    return;
  }
  requireExactKeys(value, new Set([
    'languagePolicy', 'includeWords', 'orientation', 'deskew', 'preprocessing',
    'rasterDpi', 'maximumPixels', 'maximumSide', 'timeoutMs',
  ]), 'recognitionOptions', issues);
  validateLanguagePolicy(value.languagePolicy, issues);
  if (typeof value.includeWords !== 'boolean') issues.push('recognitionOptions.includeWords must be boolean');
  validateOrientation(value.orientation, issues);
  if (typeof value.deskew !== 'boolean') issues.push('recognitionOptions.deskew must be boolean');
  validatePreprocessingOptions(value.preprocessing, issues);
  validatePositiveNumber(value.rasterDpi, 'recognitionOptions.rasterDpi', issues);
  validatePositiveInteger(value.maximumPixels, 'recognitionOptions.maximumPixels', issues);
  validatePositiveInteger(value.maximumSide, 'recognitionOptions.maximumSide', issues);
  validatePositiveInteger(value.timeoutMs, 'recognitionOptions.timeoutMs', issues);
  const raster = page?.sourceRaster;
  if (isFiniteNumber(value.rasterDpi) && isFiniteNumber(raster?.dpi) && value.rasterDpi !== raster.dpi) {
    issues.push('recognitionOptions.rasterDpi must match page.sourceRaster.dpi');
  }
  if (Number.isSafeInteger(raster?.widthPx) && Number.isSafeInteger(raster?.heightPx) &&
      Number.isSafeInteger(value.maximumPixels) && raster.widthPx * raster.heightPx > value.maximumPixels) {
    issues.push('page.sourceRaster dimensions exceed recognitionOptions.maximumPixels');
  }
  if (Number.isSafeInteger(value.maximumSide) &&
      Math.max(raster?.widthPx ?? 0, raster?.heightPx ?? 0) > value.maximumSide) {
    issues.push('page.sourceRaster dimensions exceed recognitionOptions.maximumSide');
  }
}

function validateDocumentPolicy(value, issues) {
  if (!isObject(value)) {
    issues.push('documentPolicy must be an object');
    return;
  }
  const keys = [
    'skipMeaningfulExistingText', 'forceRerun', 'replaceApplicationOwnedOcrOnly', 'keepCompletedPages',
  ];
  requireExactKeys(value, new Set(keys), 'documentPolicy', issues);
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') issues.push(`documentPolicy.${key} must be boolean`);
  }
  if (value.skipMeaningfulExistingText === true && value.forceRerun === true) {
    issues.push('documentPolicy.skipMeaningfulExistingText and forceRerun cannot both be true');
  }
}

function validateScheduler(value, issues) {
  if (!isObject(value)) {
    issues.push('scheduler must be an object');
    return;
  }
  requireExactKeys(value, new Set(['priority', 'execution']), 'scheduler', issues);
  if (!['background', 'normal', 'interactive'].includes(value.priority)) issues.push('scheduler.priority is unsupported');
  if (value.execution !== 'one-page-child') issues.push('scheduler.execution must be one-page-child');
}

export function validateOcrJobV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxJobBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['job must be an object'] };
  validateJsonValue(value, 'job', issues);
  if (!validateSerializedSize(value, 'job', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'requestId', 'engineId', 'modelPack',
    'document', 'page', 'recognitionConfigurationHash', 'recognitionOptions',
    'documentPolicy', 'scheduler', 'createdAt',
  ]), 'job', issues);
  if (value.contract !== OCR_JOB_CONTRACT) issues.push(`contract must be ${OCR_JOB_CONTRACT}`);
  if (value.schemaVersion !== OCR_JOB_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.jobId, 'jobId', issues);
  validateIdentifier(value.requestId, 'requestId', issues);
  validateIdentifier(value.engineId, 'engineId', issues);
  const modelValidation = validateOcrModelPackIdentity(value.modelPack, 'modelPack');
  issues.push(...modelValidation.issues);
  validateDocument(value.document, issues);
  validatePage(value.page, value.document?.pageCount, issues);
  validateFingerprint(value.recognitionConfigurationHash, 'recognitionConfigurationHash', issues);
  validateRecognitionOptions(value.recognitionOptions, value.page, issues);
  validateDocumentPolicy(value.documentPolicy, issues);
  validateScheduler(value.scheduler, issues);
  validateIsoTimestamp(value.createdAt, 'createdAt', issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrJobV1(value, options) {
  const validation = validateOcrJobV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_JOB_CONTRACT, validation.issues);
  return value;
}

export function toValidatedOcrJobV1Json(value, options) {
  assertOcrJobV1(value, options);
  const parsed = JSON.parse(JSON.stringify(value));
  assertOcrJobV1(parsed, options);
  return parsed;
}

function validateProgressError(value, issues) {
  if (!isObject(value)) {
    issues.push('error must be null or an object');
    return;
  }
  requireExactKeys(value, new Set(['code', 'message', 'retryable']), 'error', issues);
  validateIdentifier(value.code, 'error.code', issues);
  validateString(value.message, 'error.message', issues, { nonEmpty: true, maxCodeUnits: 4096 });
  if (typeof value.retryable !== 'boolean') issues.push('error.retryable must be boolean');
}

export function validateOcrProgressV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxProgressBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['progress must be an object'] };
  validateJsonValue(value, 'progress', issues);
  if (!validateSerializedSize(value, 'progress', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'eventId', 'sequence', 'jobId', 'requestId',
    'documentId', 'documentRevision', 'documentGeneration', 'pageId', 'pageIndex',
    'pageRevision', 'sourceRasterId', 'recognitionConfigurationHash', 'stage',
    'fraction', 'message', 'error', 'timestamp',
  ]), 'progress', issues);
  if (value.contract !== OCR_PROGRESS_CONTRACT) issues.push(`contract must be ${OCR_PROGRESS_CONTRACT}`);
  if (value.schemaVersion !== OCR_PROGRESS_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  for (const key of ['eventId', 'jobId', 'requestId', 'documentId', 'documentGeneration', 'pageId', 'sourceRasterId']) {
    validateIdentifier(value[key], key, issues);
  }
  validateNonNegativeInteger(value.sequence, 'sequence', issues);
  validateNonNegativeInteger(value.documentRevision, 'documentRevision', issues);
  validateNonNegativeInteger(value.pageIndex, 'pageIndex', issues);
  validateNonNegativeInteger(value.pageRevision, 'pageRevision', issues);
  validateFingerprint(value.recognitionConfigurationHash, 'recognitionConfigurationHash', issues);
  if (!OCR_PROGRESS_STAGES.includes(value.stage)) issues.push('stage is unsupported');
  if (!isFiniteNumber(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    issues.push('fraction must be a finite number between 0 and 1');
  }
  if (value.message !== undefined) validateString(value.message, 'message', issues, { maxCodeUnits: 4096 });
  if (value.error !== null) validateProgressError(value.error, issues);
  validateIsoTimestamp(value.timestamp, 'timestamp', issues);
  if (['completed', 'partial', 'unsupported'].includes(value.stage) && value.fraction !== 1) {
    issues.push(`${value.stage} progress must have fraction 1`);
  }
  if (value.stage === 'failed' && value.error === null) issues.push('failed progress requires error metadata');
  if (value.stage !== 'failed' && value.error !== null) issues.push('error metadata is allowed only for failed progress');
  if (!TERMINAL_PROGRESS_STAGES.has(value.stage) && value.fraction === 1) {
    issues.push('non-terminal progress must have fraction less than 1');
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrProgressV1(value, options) {
  const validation = validateOcrProgressV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_PROGRESS_CONTRACT, validation.issues);
  return value;
}
