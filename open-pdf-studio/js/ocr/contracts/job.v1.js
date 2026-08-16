import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateIdentifier,
  validateIsoTimestamp,
  validateLanguageTag,
  validateSerializedSize,
  validateString,
} from './validation.js';
import {
  OCR_MODEL_PACK_CONTRACT,
  OCR_MODEL_PACK_SCHEMA_VERSION,
} from './model-pack.v1.js';

export const OCR_JOB_CONTRACT = 'open-pdf-studio.ocr.job';
export const OCR_PROGRESS_CONTRACT = 'open-pdf-studio.ocr.progress';
export const OCR_JOB_SCHEMA_VERSION = 1;
export const OCR_PROGRESS_SCHEMA_VERSION = 1;

export const OCR_PAGE_STATUSES = Object.freeze([
  'queued',
  'rasterizing',
  'preprocessing',
  'recognizing',
  'completed',
  'partial',
  'unsupported',
  'failed',
  'cancelled',
]);

export const OCR_PROGRESS_STAGES = Object.freeze([
  'queued',
  'rasterizing',
  'preprocessing',
  'recognizing',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
]);

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

function validateModelPackIdentity(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['contract', 'schemaVersion', 'packId', 'packVersion']), path, issues);
  if (value.contract !== OCR_MODEL_PACK_CONTRACT) issues.push(`${path}.contract must be ${OCR_MODEL_PACK_CONTRACT}`);
  if (value.schemaVersion !== OCR_MODEL_PACK_SCHEMA_VERSION) issues.push(`${path}.schemaVersion must be 1`);
  validateIdentifier(value.packId, `${path}.packId`, issues);
  const valid = validateString(value.packVersion, `${path}.packVersion`, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (valid && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.packVersion)) {
    issues.push(`${path}.packVersion must be semver`);
  }
}

function validateDocument(value, issues) {
  if (!isObject(value)) {
    issues.push('document must be an object');
    return;
  }
  requireExactKeys(value, new Set(['id', 'fingerprint', 'pageCount']), 'document', issues);
  validateIdentifier(value.id, 'document.id', issues);
  if (value.fingerprint !== undefined) validateFingerprint(value.fingerprint, 'document.fingerprint', issues);
  if (!Number.isInteger(value.pageCount) || value.pageCount <= 0 || value.pageCount > OCR_CONTRACT_LIMITS.maxPagesPerJob) {
    issues.push(`document.pageCount must be between 1 and ${OCR_CONTRACT_LIMITS.maxPagesPerJob}`);
  }
}

function validatePageError(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['code', 'message', 'retryable']), path, issues);
  validateIdentifier(value.code, `${path}.code`, issues);
  validateString(value.message, `${path}.message`, issues, { nonEmpty: true });
  if (typeof value.retryable !== 'boolean') issues.push(`${path}.retryable must be boolean`);
}

function validateJobPage(value, index, pageCount, issues) {
  const path = `pages[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['id', 'index', 'status', 'attempts', 'lastError']), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (!Number.isInteger(value.index) || value.index < 0 ||
      (Number.isInteger(pageCount) && value.index >= pageCount)) {
    issues.push(`${path}.index must identify a page in document.pageCount`);
  }
  if (!OCR_PAGE_STATUSES.includes(value.status)) issues.push(`${path}.status is unsupported`);
  if (!Number.isInteger(value.attempts) || value.attempts < 0) issues.push(`${path}.attempts must be a non-negative integer`);
  if (value.lastError !== undefined) validatePageError(value.lastError, `${path}.lastError`, issues);
  if (['failed', 'unsupported'].includes(value.status) && value.lastError === undefined) {
    issues.push(`${path}.lastError is required for ${value.status} status`);
  }
}

function validateOptions(value, issues) {
  if (!isObject(value)) {
    issues.push('options must be an object');
    return;
  }
  requireExactKeys(value, new Set(['languages', 'includeWords']), 'options', issues);
  if (!Array.isArray(value.languages)) {
    issues.push('options.languages must be an array');
  } else {
    const seen = new Set();
    value.languages.forEach((language, index) => {
      validateLanguageTag(language, `options.languages[${index}]`, issues);
      if (seen.has(language)) issues.push(`options.languages[${index}] must be unique`);
      seen.add(language);
    });
  }
  if (typeof value.includeWords !== 'boolean') issues.push('options.includeWords must be boolean');
}

export function validateOcrJobV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxJobBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['job must be an object'] };
  if (!validateSerializedSize(value, 'job', issues, maxSerializedBytes)) {
    return { ok: false, issues };
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'engineId', 'modelPack', 'document',
    'pages', 'options', 'createdAt', 'updatedAt',
  ]), 'job', issues);
  if (value.contract !== OCR_JOB_CONTRACT) issues.push(`contract must be ${OCR_JOB_CONTRACT}`);
  if (value.schemaVersion !== OCR_JOB_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.jobId, 'jobId', issues);
  validateIdentifier(value.engineId, 'engineId', issues);
  validateModelPackIdentity(value.modelPack, 'modelPack', issues);
  validateDocument(value.document, issues);
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    issues.push('pages must be a non-empty array');
  } else {
    if (value.pages.length > OCR_CONTRACT_LIMITS.maxPagesPerJob) {
      issues.push(`pages exceeds ${OCR_CONTRACT_LIMITS.maxPagesPerJob} items`);
    }
    const ids = new Set();
    const indexes = new Set();
    const count = Math.min(value.pages.length, OCR_CONTRACT_LIMITS.maxPagesPerJob);
    for (let index = 0; index < count; index += 1) {
      const page = value.pages[index];
      validateJobPage(page, index, value.document?.pageCount, issues);
      if (typeof page?.id === 'string' && ids.has(page.id)) issues.push(`pages[${index}].id must be unique`);
      if (Number.isInteger(page?.index) && indexes.has(page.index)) issues.push(`pages[${index}].index must be unique`);
      ids.add(page?.id);
      indexes.add(page?.index);
    }
  }
  validateOptions(value.options, issues);
  validateIsoTimestamp(value.createdAt, 'createdAt', issues);
  validateIsoTimestamp(value.updatedAt, 'updatedAt', issues);
  if (Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt)) &&
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push('updatedAt must not precede createdAt');
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrJobV1(value, options) {
  const validation = validateOcrJobV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_JOB_CONTRACT, validation.issues);
  return value;
}

export function validateOcrProgressV1(value) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['progress must be an object'] };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'jobId', 'documentId', 'pageId', 'pageIndex',
    'pageStatus', 'stage', 'completedPages', 'totalPages', 'fraction', 'message',
    'timestamp',
  ]), 'progress', issues);
  if (value.contract !== OCR_PROGRESS_CONTRACT) issues.push(`contract must be ${OCR_PROGRESS_CONTRACT}`);
  if (value.schemaVersion !== OCR_PROGRESS_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.jobId, 'jobId', issues);
  validateIdentifier(value.documentId, 'documentId', issues);
  if (value.pageId !== null) validateIdentifier(value.pageId, 'pageId', issues);
  if (value.pageIndex !== null && (!Number.isInteger(value.pageIndex) || value.pageIndex < 0)) {
    issues.push('pageIndex must be null or a non-negative integer');
  }
  if ((value.pageId === null) !== (value.pageIndex === null)) issues.push('pageId and pageIndex must both be null or both identify a page');
  if (value.pageStatus !== null && !OCR_PAGE_STATUSES.includes(value.pageStatus)) issues.push('pageStatus is unsupported');
  if (value.pageId === null && value.pageStatus !== null) issues.push('pageStatus must be null when no page is identified');
  if (!OCR_PROGRESS_STAGES.includes(value.stage)) issues.push('stage is unsupported');
  if (!Number.isInteger(value.totalPages) || value.totalPages <= 0 || value.totalPages > OCR_CONTRACT_LIMITS.maxPagesPerJob) {
    issues.push(`totalPages must be between 1 and ${OCR_CONTRACT_LIMITS.maxPagesPerJob}`);
  }
  if (!Number.isInteger(value.completedPages) || value.completedPages < 0 ||
      (Number.isInteger(value.totalPages) && value.completedPages > value.totalPages)) {
    issues.push('completedPages must be between 0 and totalPages');
  }
  if (!isFiniteNumber(value.fraction) || value.fraction < 0 || value.fraction > 1) {
    issues.push('fraction must be a finite number between 0 and 1');
  }
  if (value.message !== undefined) validateString(value.message, 'message', issues, { maxCodeUnits: 4096 });
  validateIsoTimestamp(value.timestamp, 'timestamp', issues);
  if (value.stage === 'completed' && (value.fraction !== 1 || value.completedPages !== value.totalPages)) {
    issues.push('completed progress must have fraction 1 and all pages completed');
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrProgressV1(value) {
  const validation = validateOcrProgressV1(value);
  if (!validation.ok) throw new OcrContractError(OCR_PROGRESS_CONTRACT, validation.issues);
  return value;
}
