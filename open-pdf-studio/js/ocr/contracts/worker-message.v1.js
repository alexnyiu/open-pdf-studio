import { assertOcrJobV1, validateOcrJobV1 } from './job.v1.js';
import { assertOcrResultV2, validateOcrResultV2 } from './v2.js';
import {
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateIdentifier,
  validateJsonValue,
  validateNonNegativeNumber,
  validateSerializedSize,
  validateString,
} from './validation.js';

export const OCR_WORKER_MESSAGE_CONTRACT = 'open-pdf-studio.ocr.worker-message';
export const OCR_WORKER_MESSAGE_SCHEMA_VERSION = 1;

export const OCR_WORKER_MESSAGE_LIMITS = Object.freeze({
  maxMetadataBytes: 17 * 1024 * 1024,
  maxLifecycleDetailBytes: 64 * 1024,
  maxRasterPixels: 100_000_000,
  maxRasterSide: 32_768,
});

const PARENT_TO_WORKER_TYPES = new Set(['recognize', 'dispose']);
const WORKER_TO_PARENT_TYPES = new Set(['ready', 'lifecycle', 'result', 'error', 'disposed']);

function addNestedIssues(issues, prefix, validation) {
  for (const issue of validation.issues) issues.push(`${prefix}: ${issue}`);
}

function validateMessageHeader(value, issues) {
  if (value.contract !== OCR_WORKER_MESSAGE_CONTRACT) {
    issues.push(`contract must be ${OCR_WORKER_MESSAGE_CONTRACT}`);
  }
  if (value.schemaVersion !== OCR_WORKER_MESSAGE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${OCR_WORKER_MESSAGE_SCHEMA_VERSION}`);
  }
  validateIdentifier(value.type, 'type', issues);
}

function validateJsonDetail(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  validateJsonValue(value, path, issues, { maxDepth: 16, maxNodes: 10_000 });
  validateSerializedSize(value, path, issues, OCR_WORKER_MESSAGE_LIMITS.maxLifecycleDetailBytes);
}

function validateRecognizeMessage(value, issues) {
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'type', 'requestId', 'job', 'image',
    'rasterMs', 'workerStartupMs',
  ]), 'message', issues);
  validateIdentifier(value.requestId, 'requestId', issues);
  const jobValidation = validateOcrJobV1(value.job);
  addNestedIssues(issues, 'job', jobValidation);
  if (value.requestId !== value.job?.requestId) {
    issues.push('requestId must match job.requestId');
  }
  validateNonNegativeNumber(value.rasterMs, 'rasterMs', issues);
  validateNonNegativeNumber(value.workerStartupMs, 'workerStartupMs', issues);
  if (!isObject(value.image)) {
    issues.push('image must be an object');
    return;
  }
  requireExactKeys(value.image, new Set(['width', 'height', 'rgba']), 'image', issues);
  const { width, height, rgba } = value.image;
  if (!Number.isSafeInteger(width) || width <= 0 || width > OCR_WORKER_MESSAGE_LIMITS.maxRasterSide) {
    issues.push(`image.width must be a positive safe integer no greater than ${OCR_WORKER_MESSAGE_LIMITS.maxRasterSide}`);
  }
  if (!Number.isSafeInteger(height) || height <= 0 || height > OCR_WORKER_MESSAGE_LIMITS.maxRasterSide) {
    issues.push(`image.height must be a positive safe integer no greater than ${OCR_WORKER_MESSAGE_LIMITS.maxRasterSide}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > OCR_WORKER_MESSAGE_LIMITS.maxRasterPixels) {
    issues.push(`image dimensions exceed ${OCR_WORKER_MESSAGE_LIMITS.maxRasterPixels} pixels`);
  }
  if (!(rgba instanceof ArrayBuffer)) {
    issues.push('image.rgba must be an ArrayBuffer');
  } else if (Number.isSafeInteger(pixels) && rgba.byteLength !== pixels * 4) {
    issues.push(`image.rgba must contain exactly ${pixels * 4} bytes`);
  }
  if (width !== value.job?.page?.sourceRaster?.widthPx ||
      height !== value.job?.page?.sourceRaster?.heightPx) {
    issues.push('image dimensions must match job.page.sourceRaster');
  }
}

function validateReadyMessage(value, issues) {
  requireExactKeys(value, new Set(['contract', 'schemaVersion', 'type']), 'message', issues);
}

function validateLifecycleMessage(value, issues) {
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'type', 'stage', 'atEpochMs', 'detail',
  ]), 'message', issues);
  validateIdentifier(value.stage, 'stage', issues);
  if (!isFiniteNumber(value.atEpochMs) || value.atEpochMs < 0) {
    issues.push('atEpochMs must be a non-negative finite number');
  }
  validateJsonDetail(value.detail, 'detail', issues);
}

function validateResultMessage(value, issues) {
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'type', 'requestId', 'result',
  ]), 'message', issues);
  validateIdentifier(value.requestId, 'requestId', issues);
  const resultValidation = validateOcrResultV2(value.result);
  addNestedIssues(issues, 'result', resultValidation);
  if (value.requestId !== value.result?.requestId) {
    issues.push('requestId must match result.requestId');
  }
}

function validateErrorMessage(value, issues) {
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'type', 'requestId', 'error',
  ]), 'message', issues);
  validateIdentifier(value.requestId, 'requestId', issues);
  if (!isObject(value.error)) {
    issues.push('error must be an object');
    return;
  }
  requireExactKeys(value.error, new Set(['name', 'code', 'message', 'retryable']), 'error', issues);
  validateIdentifier(value.error.name, 'error.name', issues);
  validateIdentifier(value.error.code, 'error.code', issues);
  validateString(value.error.message, 'error.message', issues, {
    nonEmpty: true,
    maxCodeUnits: 4096,
  });
  if (typeof value.error.retryable !== 'boolean') issues.push('error.retryable must be boolean');
}

function validateDisposedMessage(value, issues) {
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'type', 'detail',
  ]), 'message', issues);
  validateJsonDetail(value.detail, 'detail', issues);
}

function metadataForSize(value) {
  if (value?.type !== 'recognize' || !isObject(value.image)) return value;
  return {
    ...value,
    image: {
      ...value.image,
      rgba: value.image.rgba instanceof ArrayBuffer
        ? { byteLength: value.image.rgba.byteLength }
        : value.image.rgba,
    },
  };
}

export function validateOcrWorkerMessageV1(value, {
  direction = 'either',
  maxMetadataBytes = OCR_WORKER_MESSAGE_LIMITS.maxMetadataBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['message must be an object'] };
  validateMessageHeader(value, issues);
  const knownType = PARENT_TO_WORKER_TYPES.has(value.type) || WORKER_TO_PARENT_TYPES.has(value.type);
  if (!knownType) issues.push('type is unsupported');
  if (direction === 'parent-to-worker' && !PARENT_TO_WORKER_TYPES.has(value.type)) {
    issues.push('type is not valid from parent to Worker');
  } else if (direction === 'worker-to-parent' && !WORKER_TO_PARENT_TYPES.has(value.type)) {
    issues.push('type is not valid from Worker to parent');
  } else if (!['either', 'parent-to-worker', 'worker-to-parent'].includes(direction)) {
    issues.push('validation direction is unsupported');
  }

  if (value.type === 'recognize') validateRecognizeMessage(value, issues);
  else if (value.type === 'dispose') {
    requireExactKeys(value, new Set(['contract', 'schemaVersion', 'type']), 'message', issues);
  } else if (value.type === 'ready') validateReadyMessage(value, issues);
  else if (value.type === 'lifecycle') validateLifecycleMessage(value, issues);
  else if (value.type === 'result') validateResultMessage(value, issues);
  else if (value.type === 'error') validateErrorMessage(value, issues);
  else if (value.type === 'disposed') validateDisposedMessage(value, issues);

  const metadata = metadataForSize(value);
  validateJsonValue(metadata, 'message', issues, { maxDepth: 64, maxNodes: 1_000_000 });
  validateSerializedSize(metadata, 'message', issues, maxMetadataBytes);
  return { ok: issues.length === 0, issues };
}

export function assertOcrWorkerMessageV1(value, options) {
  const validation = validateOcrWorkerMessageV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_WORKER_MESSAGE_CONTRACT, validation.issues);
  return value;
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
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

export function validateOcrResultMatchesJob(result, job) {
  const issues = [];
  const jobValidation = validateOcrJobV1(job);
  addNestedIssues(issues, 'job', jobValidation);
  const resultValidation = validateOcrResultV2(result);
  addNestedIssues(issues, 'result', resultValidation);
  if (!jobValidation.ok || !resultValidation.ok) return { ok: false, issues };

  const equal = (path, left, right) => {
    if (!sameJson(left, right)) issues.push(`${path} does not match the recognition job`);
  };
  equal('result.jobId', result.jobId, job.jobId);
  equal('result.requestId', result.requestId, job.requestId);
  equal('result.engine.engineId', result.engine.engineId, job.engineId);
  equal('result.engine.modelPack', result.engine.modelPack, job.modelPack);
  equal('result.document', result.document, job.document);
  equal('result.page.id', result.page.id, job.page.id);
  equal('result.page.index', result.page.index, job.page.index);
  equal('result.page.revision', result.page.revision, job.page.revision);
  equal('result.sourceRaster', result.sourceRaster, job.page.sourceRaster);
  equal(
    'result.recognitionConfigurationHash',
    result.recognitionConfigurationHash,
    job.recognitionConfigurationHash,
  );
  if (job.recognitionOptions.preprocessing.mode === 'none' && result.preprocessing.status !== 'none') {
    issues.push('result.preprocessing.status must be none when the job disables preprocessing');
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrResultMatchesJob(result, job) {
  assertOcrJobV1(job);
  assertOcrResultV2(result);
  const validation = validateOcrResultMatchesJob(result, job);
  if (!validation.ok) throw new OcrContractError(OCR_WORKER_MESSAGE_CONTRACT, validation.issues);
  return result;
}
