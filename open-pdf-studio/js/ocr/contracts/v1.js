import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateBoundingBox,
  validateConfidence,
  validateIdentifier,
  validateNonNegativeNumber,
  validatePolygon,
  validatePositiveNumber,
  validateSemver,
  validateSerializedSize,
  validateString,
} from './validation.js';

export const OCR_ENGINE_CONTRACT = 'open-pdf-studio.ocr.engine';
export const OCR_RESULT_CONTRACT = 'open-pdf-studio.ocr.result';
export const OCR_WORKER_MESSAGE_CONTRACT = 'open-pdf-studio.ocr.worker-message';
export const OCR_SCHEMA_VERSION = 1;

export { OcrContractError };

function validateEngine(value, issues, path = 'engine') {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'engineId', 'adapterVersion', 'provider',
    'model', 'runtime', 'capabilities',
  ]), path, issues);
  if (value.contract !== OCR_ENGINE_CONTRACT) issues.push(`${path}.contract must be ${OCR_ENGINE_CONTRACT}`);
  if (value.schemaVersion !== OCR_SCHEMA_VERSION) issues.push(`${path}.schemaVersion must be 1`);
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

  if (!isObject(value.runtime)) {
    issues.push(`${path}.runtime must be an object`);
  } else {
    requireExactKeys(value.runtime, new Set(['name', 'version', 'executionProvider', 'offline']), `${path}.runtime`, issues);
    for (const key of ['name', 'version', 'executionProvider']) {
      validateString(value.runtime[key], `${path}.runtime.${key}`, issues, { nonEmpty: true, maxCodeUnits: 128 });
    }
    if (typeof value.runtime.offline !== 'boolean') issues.push(`${path}.runtime.offline must be boolean`);
  }

  if (!isObject(value.capabilities)) {
    issues.push(`${path}.capabilities must be an object`);
  } else {
    const keys = ['textDetection', 'textRecognition', 'wordBoxes', 'pdfWriting'];
    requireExactKeys(value.capabilities, new Set(keys), `${path}.capabilities`, issues);
    for (const key of keys) {
      if (typeof value.capabilities[key] !== 'boolean') issues.push(`${path}.capabilities.${key} must be boolean`);
    }
  }
}

export function validateOcrEngineV1(value) {
  const issues = [];
  validateEngine(value, issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrEngineV1(value) {
  const validation = validateOcrEngineV1(value);
  if (!validation.ok) throw new OcrContractError(OCR_ENGINE_CONTRACT, validation.issues);
  return value;
}

function validateSource(source, issues) {
  if (!isObject(source)) {
    issues.push('source must be an object');
    return;
  }
  requireExactKeys(source, new Set(['kind', 'path', 'pageIndex', 'widthPx', 'heightPx', 'scale']), 'source', issues);
  if (source.kind !== 'pdf-page') issues.push('source.kind must be pdf-page');
  validateString(source.path, 'source.path', issues, { nonEmpty: true, maxCodeUnits: 4096 });
  if (!Number.isInteger(source.pageIndex) || source.pageIndex < 0) issues.push('source.pageIndex must be a non-negative integer');
  if (!Number.isInteger(source.widthPx) || source.widthPx <= 0) issues.push('source.widthPx must be a positive integer');
  if (!Number.isInteger(source.heightPx) || source.heightPx <= 0) issues.push('source.heightPx must be a positive integer');
  validatePositiveNumber(source.scale, 'source.scale', issues);
}

function validateLine(line, index, source, issues) {
  const path = `lines[${index}]`;
  if (!isObject(line)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(line, new Set(['id', 'text', 'confidence', 'boundingBox', 'polygon']), path, issues);
  validateIdentifier(line.id, `${path}.id`, issues);
  validateString(line.text, `${path}.text`, issues);
  validateConfidence(line.confidence, `${path}.confidence`, issues);
  validateBoundingBox(line.boundingBox, `${path}.boundingBox`, issues, {
    width: source?.widthPx,
    height: source?.heightPx,
  });
  const box = line.boundingBox;
  if (isObject(box) && isFiniteNumber(box.x) && isFiniteNumber(box.width) &&
      isFiniteNumber(source?.widthPx) && box.x + box.width > source.widthPx + 0.5) {
    issues.push(`${path}.boundingBox exceeds source width`);
  }
  if (isObject(box) && isFiniteNumber(box.y) && isFiniteNumber(box.height) &&
      isFiniteNumber(source?.heightPx) && box.y + box.height > source.heightPx + 0.5) {
    issues.push(`${path}.boundingBox exceeds source height`);
  }
  validatePolygon(line.polygon, `${path}.polygon`, issues, {
    width: source?.widthPx,
    height: source?.heightPx,
  });
}

export function validateOcrResultV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxResultBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['result must be an object'] };
  if (!validateSerializedSize(value, 'result', issues, maxSerializedBytes)) {
    return { ok: false, issues };
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'requestId', 'engine', 'source', 'text',
    'lines', 'metrics', 'warnings',
  ]), 'result', issues);
  if (value.contract !== OCR_RESULT_CONTRACT) issues.push(`contract must be ${OCR_RESULT_CONTRACT}`);
  if (value.schemaVersion !== OCR_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.requestId, 'requestId', issues);
  validateEngine(value.engine, issues);
  validateSource(value.source, issues);
  validateString(value.text, 'text', issues);
  if (!Array.isArray(value.lines)) {
    issues.push('lines must be an array');
  } else {
    if (value.lines.length > OCR_CONTRACT_LIMITS.maxLinesPerPage) {
      issues.push(`lines exceeds ${OCR_CONTRACT_LIMITS.maxLinesPerPage} items`);
    }
    const seen = new Set();
    const count = Math.min(value.lines.length, OCR_CONTRACT_LIMITS.maxLinesPerPage);
    for (let index = 0; index < count; index += 1) {
      validateLine(value.lines[index], index, value.source, issues);
      const id = value.lines[index]?.id;
      if (typeof id === 'string' && seen.has(id)) issues.push(`lines[${index}].id must be unique`);
      seen.add(id);
    }
  }
  if (!isObject(value.metrics)) {
    issues.push('metrics must be an object');
  } else {
    const keys = ['workerStartupMs', 'modelStartupMs', 'rasterMs', 'detectionMs', 'recognitionMs', 'totalOcrMs'];
    requireExactKeys(value.metrics, new Set(keys), 'metrics', issues);
    for (const key of keys) validateNonNegativeNumber(value.metrics[key], `metrics.${key}`, issues);
  }
  if (!Array.isArray(value.warnings)) {
    issues.push('warnings must be an array of strings');
  } else {
    if (value.warnings.length > OCR_CONTRACT_LIMITS.maxWarningsPerPage) {
      issues.push(`warnings exceeds ${OCR_CONTRACT_LIMITS.maxWarningsPerPage} items`);
    }
    value.warnings.slice(0, OCR_CONTRACT_LIMITS.maxWarningsPerPage)
      .forEach((warning, index) => validateString(warning, `warnings[${index}]`, issues));
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrResultV1(value, options) {
  const validation = validateOcrResultV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_RESULT_CONTRACT, validation.issues);
  return value;
}

export function toValidatedOcrResultJson(value, options) {
  assertOcrResultV1(value, options);
  const json = JSON.stringify(value);
  const parsed = JSON.parse(json);
  assertOcrResultV1(parsed, options);
  return parsed;
}
