import {
  OCR_JOB_CONTRACT,
  OCR_JOB_SCHEMA_VERSION,
  assertOcrJobV1,
} from './job.v1.js';
import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isObject,
  requireExactKeys,
  validateIdentifier,
  validateJsonValue,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validateSerializedSize,
  validateString,
} from './validation.js';
import { assertOcrResultMatchesJob } from './worker-message.v1.js';

export const OCR_NATIVE_PAGE_REQUEST_CONTRACT = 'open-pdf-studio.ocr.native-page-request';
export const OCR_NATIVE_JOB_CONTRACT = 'open-pdf-studio.ocr.native-job';
export const OCR_NATIVE_RESULT_CONTRACT = 'open-pdf-studio.ocr.native-result';
export const OCR_NATIVE_SCHEMA_VERSION = 1;

export const OCR_NATIVE_LIMITS = Object.freeze({
  maxWidthPx: 8192,
  maxHeightPx: 8192,
  maxPixels: 16_000_000,
  maxMetadataBytes: 1024 * 1024,
  maxRasterBytes: (64 * 1024 * 1024) - 32,
  maxResultBytes: OCR_CONTRACT_LIMITS.maxResultBytes,
  maxTimeoutMs: 120_000,
});

const ZERO_SHA256 = '0'.repeat(64);
const REQUEST_KEYS = new Set([
  'contract', 'schemaVersion', 'jobId', 'requestId', 'engineId', 'modelPack',
  'document', 'page', 'recognitionConfigurationHash', 'recognitionOptions',
  'documentPolicy', 'scheduler', 'createdAt',
]);
const PAGE_REQUEST_KEYS = new Set(['id', 'index', 'revision', 'sourceRasterId']);
const NATIVE_JOB_KEYS = new Set([
  'contract', 'schemaVersion', 'job', 'raster', 'rasterMs', 'preprocessingRequest',
  'limits', 'resultFile',
]);
const RASTER_KEYS = new Set(['format', 'widthPx', 'heightPx', 'rowBytes', 'byteLength']);
const LIMIT_KEYS = new Set([
  'maxWidthPx', 'maxHeightPx', 'maxPixels', 'maxMetadataBytes', 'maxRasterBytes',
  'maxResultBytes', 'timeoutMs',
]);
const RESULT_FILE_KEYS = new Set(['id']);
const NATIVE_RESULT_KEYS = new Set([
  'contract', 'schemaVersion', 'status', 'jobId', 'requestId', 'documentId',
  'documentRevision', 'documentGeneration', 'pageId', 'pageIndex', 'pageRevision',
  'engineId', 'modelPack', 'recognitionConfigurationHash', 'sourceRaster',
  'resultFileId', 'result', 'failure', 'lifecycle', 'resources',
]);

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function addNestedIssues(issues, prefix, error) {
  if (Array.isArray(error?.issues)) {
    issues.push(...error.issues.map((issue) => `${prefix}.${issue}`));
  } else {
    issues.push(`${prefix} is invalid`);
  }
}

function syntheticSourceRaster(request) {
  return {
    id: request?.page?.sourceRasterId,
    fingerprint: { algorithm: 'sha256', value: ZERO_SHA256 },
    coordinateSpace: 'source-raster-pixels',
    widthPx: 1,
    heightPx: 1,
    dpi: request?.recognitionOptions?.rasterDpi,
  };
}

export function materializeNativeOcrJobV1(request, sourceRaster) {
  return {
    contract: OCR_JOB_CONTRACT,
    schemaVersion: OCR_JOB_SCHEMA_VERSION,
    jobId: request.jobId,
    requestId: request.requestId,
    engineId: request.engineId,
    modelPack: structuredClone(request.modelPack),
    document: structuredClone(request.document),
    page: {
      id: request.page.id,
      index: request.page.index,
      revision: request.page.revision,
      sourceRaster: structuredClone(sourceRaster),
    },
    recognitionConfigurationHash: structuredClone(request.recognitionConfigurationHash),
    recognitionOptions: structuredClone(request.recognitionOptions),
    documentPolicy: structuredClone(request.documentPolicy),
    scheduler: structuredClone(request.scheduler),
    createdAt: request.createdAt,
  };
}

export function validateNativeOcrPageRequestV1(value) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['request must be an object'] };
  validateJsonValue(value, 'request', issues);
  validateSerializedSize(value, 'request', issues, OCR_NATIVE_LIMITS.maxMetadataBytes);
  requireExactKeys(value, REQUEST_KEYS, 'request', issues);
  if (value.contract !== OCR_NATIVE_PAGE_REQUEST_CONTRACT) {
    issues.push(`request.contract must be ${OCR_NATIVE_PAGE_REQUEST_CONTRACT}`);
  }
  if (value.schemaVersion !== OCR_NATIVE_SCHEMA_VERSION) issues.push('request.schemaVersion must be 1');
  if (!isObject(value.page)) {
    issues.push('request.page must be an object');
  } else {
    requireExactKeys(value.page, PAGE_REQUEST_KEYS, 'request.page', issues);
    validateIdentifier(value.page.sourceRasterId, 'request.page.sourceRasterId', issues);
  }
  if (issues.length === 0) {
    try {
      assertOcrJobV1(materializeNativeOcrJobV1(value, syntheticSourceRaster(value)));
    } catch (error) {
      addNestedIssues(issues, 'request', error);
    }
  }
  if (value.recognitionOptions?.maximumSide > OCR_NATIVE_LIMITS.maxWidthPx ||
      value.recognitionOptions?.maximumSide > OCR_NATIVE_LIMITS.maxHeightPx) {
    issues.push(`request.recognitionOptions.maximumSide exceeds ${OCR_NATIVE_LIMITS.maxWidthPx}`);
  }
  if (value.recognitionOptions?.maximumPixels > OCR_NATIVE_LIMITS.maxPixels) {
    issues.push(`request.recognitionOptions.maximumPixels exceeds ${OCR_NATIVE_LIMITS.maxPixels}`);
  }
  if (value.recognitionOptions?.timeoutMs > OCR_NATIVE_LIMITS.maxTimeoutMs) {
    issues.push(`request.recognitionOptions.timeoutMs exceeds ${OCR_NATIVE_LIMITS.maxTimeoutMs}`);
  }
  return { ok: issues.length === 0, issues };
}

export function assertNativeOcrPageRequestV1(value) {
  const validation = validateNativeOcrPageRequestV1(value);
  if (!validation.ok) throw new OcrContractError(OCR_NATIVE_PAGE_REQUEST_CONTRACT, validation.issues);
  return value;
}

function validateNativeLimits(value, job, issues) {
  if (!isObject(value)) {
    issues.push('limits must be an object');
    return;
  }
  requireExactKeys(value, LIMIT_KEYS, 'limits', issues);
  for (const key of LIMIT_KEYS) validatePositiveInteger(value[key], `limits.${key}`, issues);
  for (const key of [
    'maxWidthPx', 'maxHeightPx', 'maxPixels', 'maxMetadataBytes', 'maxRasterBytes',
    'maxResultBytes',
  ]) {
    if (Number.isSafeInteger(value[key]) && value[key] > OCR_NATIVE_LIMITS[key]) {
      issues.push(`limits.${key} exceeds the native controller limit`);
    }
  }
  if (value.timeoutMs !== job?.recognitionOptions?.timeoutMs) {
    issues.push('limits.timeoutMs must match job.recognitionOptions.timeoutMs');
  }
  const expected = {
    maxWidthPx: Math.min(job?.recognitionOptions?.maximumSide, OCR_NATIVE_LIMITS.maxWidthPx),
    maxHeightPx: Math.min(job?.recognitionOptions?.maximumSide, OCR_NATIVE_LIMITS.maxHeightPx),
    maxPixels: Math.min(job?.recognitionOptions?.maximumPixels, OCR_NATIVE_LIMITS.maxPixels),
    maxMetadataBytes: OCR_NATIVE_LIMITS.maxMetadataBytes,
    maxRasterBytes: OCR_NATIVE_LIMITS.maxRasterBytes,
    maxResultBytes: OCR_NATIVE_LIMITS.maxResultBytes,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) issues.push(`limits.${key} must match the production job limit`);
  }
}

export function validateNativeOcrJobEnvelopeV1(value, {
  serializedMetadataBytes = null,
  totalEnvelopeBytes = null,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['native job must be an object'] };
  validateJsonValue(value, 'nativeJob', issues);
  requireExactKeys(value, NATIVE_JOB_KEYS, 'nativeJob', issues);
  if (value.contract !== OCR_NATIVE_JOB_CONTRACT) issues.push(`contract must be ${OCR_NATIVE_JOB_CONTRACT}`);
  if (value.schemaVersion !== OCR_NATIVE_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  try {
    assertOcrJobV1(value.job);
  } catch (error) {
    addNestedIssues(issues, 'job', error);
  }
  validateNonNegativeNumber(value.rasterMs, 'rasterMs', issues);
  if (!isObject(value.raster)) {
    issues.push('raster must be an object');
  } else {
    requireExactKeys(value.raster, RASTER_KEYS, 'raster', issues);
    if (value.raster.format !== 'rgba8') issues.push('raster.format must be rgba8');
    for (const key of ['widthPx', 'heightPx', 'rowBytes', 'byteLength']) {
      validatePositiveInteger(value.raster[key], `raster.${key}`, issues);
    }
    const expectedRowBytes = value.raster.widthPx * 4;
    const expectedBytes = expectedRowBytes * value.raster.heightPx;
    if (!Number.isSafeInteger(expectedBytes) || value.raster.rowBytes !== expectedRowBytes ||
        value.raster.byteLength !== expectedBytes) {
      issues.push('raster dimensions and byte lengths are inconsistent');
    }
    if (value.raster.widthPx !== value.job?.page?.sourceRaster?.widthPx ||
        value.raster.heightPx !== value.job?.page?.sourceRaster?.heightPx) {
      issues.push('raster dimensions must match job.page.sourceRaster');
    }
  }
  if (!sameJson(value.preprocessingRequest, value.job?.recognitionOptions?.preprocessing)) {
    issues.push('preprocessingRequest must match job.recognitionOptions.preprocessing');
  }
  validateNativeLimits(value.limits, value.job, issues);
  if (value.raster?.widthPx > value.limits?.maxWidthPx ||
      value.raster?.heightPx > value.limits?.maxHeightPx ||
      value.raster?.widthPx * value.raster?.heightPx > value.limits?.maxPixels ||
      value.raster?.byteLength > value.limits?.maxRasterBytes) {
    issues.push('raster exceeds the native job limits');
  }
  if (!isObject(value.resultFile)) {
    issues.push('resultFile must be an object');
  } else {
    requireExactKeys(value.resultFile, RESULT_FILE_KEYS, 'resultFile', issues);
    validateIdentifier(value.resultFile.id, 'resultFile.id', issues);
  }
  if (serializedMetadataBytes !== null &&
      (!Number.isSafeInteger(serializedMetadataBytes) || serializedMetadataBytes <= 0 ||
       serializedMetadataBytes > value.limits?.maxMetadataBytes)) {
    issues.push('serialized native job metadata exceeds its limit');
  }
  if (totalEnvelopeBytes !== null) {
    const expected = 12 + serializedMetadataBytes + value.raster?.byteLength;
    if (!Number.isSafeInteger(expected) || totalEnvelopeBytes !== expected) {
      issues.push('native job envelope byte length is inconsistent');
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertNativeOcrJobEnvelopeV1(value, options) {
  const validation = validateNativeOcrJobEnvelopeV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_NATIVE_JOB_CONTRACT, validation.issues);
  return value;
}

function validateNativeFailure(value, issues) {
  if (!isObject(value)) {
    issues.push('failure must be an object');
    return;
  }
  requireExactKeys(value, new Set(['code', 'stage', 'message', 'retryable']), 'failure', issues);
  validateIdentifier(value.code, 'failure.code', issues);
  validateIdentifier(value.stage, 'failure.stage', issues);
  validateString(value.message, 'failure.message', issues, { nonEmpty: true, maxCodeUnits: 4096 });
  if (typeof value.retryable !== 'boolean') issues.push('failure.retryable must be boolean');
}

export function validateNativeOcrResultEnvelopeV1(value, { job, resultFileId } = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['native result must be an object'] };
  validateJsonValue(value, 'nativeResult', issues);
  validateSerializedSize(value, 'nativeResult', issues, OCR_NATIVE_LIMITS.maxResultBytes);
  requireExactKeys(value, NATIVE_RESULT_KEYS, 'nativeResult', issues);
  if (value.contract !== OCR_NATIVE_RESULT_CONTRACT) issues.push(`contract must be ${OCR_NATIVE_RESULT_CONTRACT}`);
  if (value.schemaVersion !== OCR_NATIVE_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  if (!['completed', 'failed'].includes(value.status)) issues.push('status must be completed or failed');
  for (const key of [
    'jobId', 'requestId', 'documentId', 'documentGeneration', 'pageId', 'engineId',
    'resultFileId',
  ]) validateIdentifier(value[key], key, issues);
  for (const key of ['documentRevision', 'pageIndex', 'pageRevision']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) issues.push(`${key} must be a non-negative integer`);
  }
  if (!Array.isArray(value.lifecycle)) issues.push('lifecycle must be an array');
  if (!isObject(value.resources)) issues.push('resources must be an object');
  if (value.status === 'completed') {
    if (value.failure !== null) issues.push('completed native result must not contain failure');
    try {
      assertOcrResultMatchesJob(value.result, job);
    } catch (error) {
      addNestedIssues(issues, 'result', error);
    }
  } else {
    if (value.result !== null) issues.push('failed native result must not contain a recognition result');
    validateNativeFailure(value.failure, issues);
  }
  if (job) {
    const expected = {
      jobId: job.jobId,
      requestId: job.requestId,
      documentId: job.document.id,
      documentRevision: job.document.revision,
      documentGeneration: job.document.generation,
      pageId: job.page.id,
      pageIndex: job.page.index,
      pageRevision: job.page.revision,
      engineId: job.engineId,
      modelPack: job.modelPack,
      recognitionConfigurationHash: job.recognitionConfigurationHash,
      sourceRaster: job.page.sourceRaster,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (!sameJson(value[key], expectedValue)) issues.push(`${key} does not match the native job`);
    }
  }
  if (resultFileId !== undefined && value.resultFileId !== resultFileId) {
    issues.push('resultFileId does not match the native job');
  }
  return { ok: issues.length === 0, issues };
}

export function assertNativeOcrResultEnvelopeV1(value, options) {
  const validation = validateNativeOcrResultEnvelopeV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_NATIVE_RESULT_CONTRACT, validation.issues);
  return value;
}
