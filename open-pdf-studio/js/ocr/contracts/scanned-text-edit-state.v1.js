import {
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateConfidence,
  validateFingerprint,
  validateIdentifier,
  validateIsoTimestamp,
  validateJsonValue,
  validateNonNegativeInteger,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validatePositiveNumber,
  validateSerializedSize,
  validateString,
} from './validation.js';
import {
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  validateBaseline,
  validateCoordinateBoundingBox,
  validateCoordinatePolygon,
  validateHomographyInverse,
} from './geometry.js';
import { validateOcrPageGeometryV1 } from './page-geometry.v1.js';

export const SCANNED_TEXT_EDIT_STATE_CONTRACT = 'open-pdf-studio.scanned-text-edit-state';
export const SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION = 1;
export const SCANNED_TEXT_EDIT_OWNER = 'open-pdf-studio';
export const SCANNED_TEXT_EDIT_FEATURE = 'scanned-text-editing';
export const SCANNED_TEXT_EDIT_CLASSIFICATIONS = Object.freeze([
  'flat',
  'near-flat',
  'textured',
  'photographic',
  'table-line-art',
  'gradient',
  'unknown',
]);
export const SCANNED_TEXT_EDIT_REPAIRABLE_BACKGROUNDS = Object.freeze(['flat', 'near-flat']);
export const SCANNED_TEXT_EDIT_REPAIR_METHODS = Object.freeze([
  'flat-median-fill-v1',
  'near-flat-edge-interpolation-v1',
]);
export const SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD = 0.82;
export const SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE = 0.9;
export const SCANNED_TEXT_EDIT_MAX_ROUND_TRIP_ERROR_PX = 0.000001;
export const SCANNED_TEXT_EDIT_MIN_BACKGROUND_SAMPLES = 128;
export const SCANNED_TEXT_EDIT_MIN_BACKGROUND_COVERAGE = 0.2;
export const SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION = 0.995;
export const SCANNED_TEXT_EDIT_SCORE_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'background-safety', weight: 0.5 }),
  Object.freeze({ id: 'geometry-confidence', weight: 0.3 }),
  Object.freeze({ id: 'context-sufficiency', weight: 0.1 }),
  Object.freeze({ id: 'boundary-stability', weight: 0.1 }),
]);
export const SCANNED_TEXT_EDIT_REJECTION_CODES = Object.freeze([
  'BACKGROUND_NOT_REPAIRABLE',
  'GEOMETRY_CONFIDENCE_LOW',
  'GEOMETRY_CLIPPED',
  'TRANSFORM_ROUND_TRIP_EXCEEDED',
  'INSUFFICIENT_BACKGROUND_CONTEXT',
  'NON_OPAQUE_BACKGROUND',
  'ELIGIBILITY_SCORE_BELOW_THRESHOLD',
]);
export const SCANNED_TEXT_EDIT_MAX_STATE_BYTES = 64 * 1024 * 1024;
export const SCANNED_TEXT_EDIT_MAX_SELECTION_ID_CODE_UNITS = 1024;

const PATCH_ENCODING = 'rgba8-base64';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SELECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u;

/**
 * Length-prefix both caller-owned identifiers so delimiter characters inside a
 * valid OCR ID cannot make two distinct targets share one selection identity.
 */
export function deriveScannedTextEditSelectionId(pageId, kind, targetId) {
  if (typeof pageId !== 'string' || !['line', 'region'].includes(kind)
      || typeof targetId !== 'string') {
    throw new TypeError('Scanned-text selection identity requires valid page, target kind, and target identifiers');
  }
  return `scan-edit-v1:${pageId.length}:${pageId}:${kind}:${targetId.length}:${targetId}`;
}

function validateSelectionIdentifier(value, path, issues) {
  const valid = validateString(value, path, issues, {
    nonEmpty: true,
    maxCodeUnits: SCANNED_TEXT_EDIT_MAX_SELECTION_ID_CODE_UNITS,
  });
  if (valid && !SELECTION_ID.test(value)) {
    issues.push(`${path} contains unsupported identifier characters`);
  }
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
  validatePositiveInteger(value.pageCount, 'document.pageCount', issues, { maximum: 100_000 });
}

function validateOwner(value, issues) {
  if (!isObject(value)) {
    issues.push('owner must be an object');
    return;
  }
  requireExactKeys(value, new Set(['application', 'feature', 'instanceId']), 'owner', issues);
  if (value.application !== SCANNED_TEXT_EDIT_OWNER) {
    issues.push(`owner.application must be ${SCANNED_TEXT_EDIT_OWNER}`);
  }
  if (value.feature !== SCANNED_TEXT_EDIT_FEATURE) {
    issues.push(`owner.feature must be ${SCANNED_TEXT_EDIT_FEATURE}`);
  }
  validateIdentifier(value.instanceId, 'owner.instanceId', issues);
}

function validateSourceRaster(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'id', 'fingerprint', 'coordinateSpace', 'widthPx', 'heightPx', 'dpi', 'rgbaSha256',
  ]), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  validateFingerprint(value.fingerprint, `${path}.fingerprint`, issues);
  if (value.coordinateSpace !== OCR_SOURCE_RASTER_SPACE) {
    issues.push(`${path}.coordinateSpace must be ${OCR_SOURCE_RASTER_SPACE}`);
  }
  validatePositiveInteger(value.widthPx, `${path}.widthPx`, issues);
  validatePositiveInteger(value.heightPx, `${path}.heightPx`, issues);
  validatePositiveNumber(value.dpi, `${path}.dpi`, issues);
  if (typeof value.rgbaSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.rgbaSha256)) {
    issues.push(`${path}.rgbaSha256 must be a lowercase SHA-256 digest`);
  }
}

function decodedBase64Length(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validatePatch(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'encoding', 'coordinateSpace', 'originX', 'originY', 'widthPx', 'heightPx',
    'rowBytes', 'byteLength', 'sha256', 'data',
  ]), path, issues);
  if (value.encoding !== PATCH_ENCODING) issues.push(`${path}.encoding must be ${PATCH_ENCODING}`);
  if (value.coordinateSpace !== OCR_SOURCE_RASTER_SPACE) {
    issues.push(`${path}.coordinateSpace must be ${OCR_SOURCE_RASTER_SPACE}`);
  }
  validateNonNegativeInteger(value.originX, `${path}.originX`, issues);
  validateNonNegativeInteger(value.originY, `${path}.originY`, issues);
  validatePositiveInteger(value.widthPx, `${path}.widthPx`, issues);
  validatePositiveInteger(value.heightPx, `${path}.heightPx`, issues);
  validatePositiveInteger(value.rowBytes, `${path}.rowBytes`, issues);
  validatePositiveInteger(value.byteLength, `${path}.byteLength`, issues);
  if (Number.isSafeInteger(value.widthPx) && Number.isSafeInteger(value.rowBytes)
      && value.rowBytes !== value.widthPx * 4) {
    issues.push(`${path}.rowBytes must equal widthPx * 4`);
  }
  if (Number.isSafeInteger(value.rowBytes) && Number.isSafeInteger(value.heightPx)
      && Number.isSafeInteger(value.byteLength) && value.byteLength !== value.rowBytes * value.heightPx) {
    issues.push(`${path}.byteLength must equal rowBytes * heightPx`);
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    issues.push(`${path}.sha256 must be a lowercase SHA-256 digest`);
  }
  const decodedLength = decodedBase64Length(value.data);
  if (decodedLength === null) issues.push(`${path}.data must be canonical base64`);
  else if (Number.isSafeInteger(value.byteLength) && decodedLength !== value.byteLength) {
    issues.push(`${path}.data length must equal byteLength`);
  }
}

function validateTransform(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['fromSpace', 'toSpace', 'matrix', 'inverseMatrix']), path, issues);
  validateString(value.fromSpace, `${path}.fromSpace`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  if (value.toSpace !== OCR_SOURCE_RASTER_SPACE) {
    issues.push(`${path}.toSpace must be ${OCR_SOURCE_RASTER_SPACE}`);
  }
  for (const key of ['matrix', 'inverseMatrix']) {
    if (!Array.isArray(value[key]) || value[key].length !== 9 || !value[key].every(isFiniteNumber)) {
      issues.push(`${path}.${key} must contain nine finite numbers`);
    }
  }
  if (Array.isArray(value.matrix) && Array.isArray(value.inverseMatrix)
      && value.matrix.length === 9 && value.inverseMatrix.length === 9
      && value.matrix.every(isFiniteNumber) && value.inverseMatrix.every(isFiniteNumber)) {
    validateHomographyInverse(value.matrix, value.inverseMatrix, path, issues);
  }
}

function validateLineGeometry(value, path, issues, lineIds, raster) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'lineId', 'sourceSpace', 'originalPolygon', 'sourcePolygon', 'transform', 'roundTripMaxErrorPx',
  ]), path, issues);
  validateIdentifier(value.lineId, `${path}.lineId`, issues);
  if (!lineIds.has(value.lineId)) issues.push(`${path}.lineId must be present in target.lineIds`);
  validateString(value.sourceSpace, `${path}.sourceSpace`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  validateCoordinatePolygon(value.originalPolygon, `${path}.originalPolygon`, issues);
  if (value.originalPolygon?.coordinateSpace !== value.sourceSpace) {
    issues.push(`${path}.originalPolygon.coordinateSpace must equal sourceSpace`);
  }
  const rasters = raster ? { [OCR_SOURCE_RASTER_SPACE]: raster } : null;
  validateCoordinatePolygon(value.sourcePolygon, `${path}.sourcePolygon`, issues, {
    allowedSpaces: [OCR_SOURCE_RASTER_SPACE],
    rasters,
  });
  validateTransform(value.transform, `${path}.transform`, issues);
  if (value.transform?.fromSpace !== value.sourceSpace) {
    issues.push(`${path}.transform.fromSpace must equal sourceSpace`);
  }
  validateNonNegativeNumber(value.roundTripMaxErrorPx, `${path}.roundTripMaxErrorPx`, issues);
}

function validateGeometry(value, path, issues, lineIds, raster) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'coordinateSpace', 'lineGeometry', 'selectionPolygon', 'repairBounds', 'extractionBounds',
    'roundTripMaxErrorPx', 'clipped', 'confidence',
  ]), path, issues);
  if (value.coordinateSpace !== OCR_SOURCE_RASTER_SPACE) {
    issues.push(`${path}.coordinateSpace must be ${OCR_SOURCE_RASTER_SPACE}`);
  }
  if (!Array.isArray(value.lineGeometry) || value.lineGeometry.length !== lineIds.size) {
    issues.push(`${path}.lineGeometry must contain one entry per selected OCR line`);
  } else {
    const seen = new Set();
    value.lineGeometry.forEach((entry, index) => {
      validateLineGeometry(entry, `${path}.lineGeometry[${index}]`, issues, lineIds, raster);
      if (seen.has(entry?.lineId)) issues.push(`${path}.lineGeometry[${index}].lineId must be unique`);
      seen.add(entry?.lineId);
    });
  }
  const rasters = raster ? { [OCR_SOURCE_RASTER_SPACE]: raster } : null;
  validateCoordinatePolygon(value.selectionPolygon, `${path}.selectionPolygon`, issues, {
    allowedSpaces: [OCR_SOURCE_RASTER_SPACE],
    rasters,
  });
  for (const key of ['repairBounds', 'extractionBounds']) {
    validateCoordinateBoundingBox(value[key], `${path}.${key}`, issues, {
      allowedSpaces: [OCR_SOURCE_RASTER_SPACE],
      rasters,
    });
    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isSafeInteger(value[key]?.[field])) {
        issues.push(`${path}.${key}.${field} must be an integer pixel boundary`);
      }
    }
  }
  if (value.repairBounds && value.extractionBounds) {
    const contained = value.repairBounds.x >= value.extractionBounds.x
      && value.repairBounds.y >= value.extractionBounds.y
      && value.repairBounds.x + value.repairBounds.width
        <= value.extractionBounds.x + value.extractionBounds.width
      && value.repairBounds.y + value.repairBounds.height
        <= value.extractionBounds.y + value.extractionBounds.height;
    if (!contained) issues.push(`${path}.extractionBounds must contain repairBounds`);
    const expectedPolygon = {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      points: [
        [value.repairBounds.x, value.repairBounds.y],
        [value.repairBounds.x + value.repairBounds.width, value.repairBounds.y],
        [value.repairBounds.x + value.repairBounds.width, value.repairBounds.y + value.repairBounds.height],
        [value.repairBounds.x, value.repairBounds.y + value.repairBounds.height],
      ],
    };
    if (JSON.stringify(value.selectionPolygon) !== JSON.stringify(expectedPolygon)) {
      issues.push(`${path}.selectionPolygon must exactly describe repairBounds`);
    }
  }
  validateNonNegativeNumber(value.roundTripMaxErrorPx, `${path}.roundTripMaxErrorPx`, issues);
  if (Array.isArray(value.lineGeometry) && value.lineGeometry.length > 0
      && value.lineGeometry.every((entry) => isFiniteNumber(entry?.roundTripMaxErrorPx))) {
    const expected = Math.max(...value.lineGeometry.map((entry) => entry.roundTripMaxErrorPx));
    if (value.roundTripMaxErrorPx !== expected) {
      issues.push(`${path}.roundTripMaxErrorPx must equal the maximum line round-trip error`);
    }
  }
  if (typeof value.clipped !== 'boolean') issues.push(`${path}.clipped must be boolean`);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
}

function validateMetrics(value, path, issues) {
  const keys = [
    'sampleCount', 'sampleCoverage', 'meanRgb', 'channelStddev', 'channelRobustRange',
    'luminanceStddev', 'luminanceRobustRange', 'edgeDensity', 'strongEdgeDensity',
    'axisAlignedLineScore', 'colorBinCount', 'saturationStddev', 'gradientSpan',
    'gradientExplainedVariance', 'gradientResidualStddev', 'opaqueFraction',
  ];
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(keys), path, issues);
  validateNonNegativeInteger(value.sampleCount, `${path}.sampleCount`, issues);
  validateConfidence(value.sampleCoverage, `${path}.sampleCoverage`, issues);
  for (const key of ['meanRgb', 'channelStddev', 'channelRobustRange']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3 || !value[key].every(isFiniteNumber)) {
      issues.push(`${path}.${key} must contain three finite channel values`);
    }
  }
  for (const key of [
    'luminanceStddev', 'luminanceRobustRange', 'edgeDensity', 'strongEdgeDensity',
    'axisAlignedLineScore', 'saturationStddev', 'gradientSpan', 'gradientResidualStddev',
  ]) validateNonNegativeNumber(value[key], `${path}.${key}`, issues);
  validateNonNegativeInteger(value.colorBinCount, `${path}.colorBinCount`, issues);
  validateConfidence(value.gradientExplainedVariance, `${path}.gradientExplainedVariance`, issues);
  validateConfidence(value.opaqueFraction, `${path}.opaqueFraction`, issues);
}

function expectedRejectionCodes(classification, metrics, geometry, score) {
  const codes = [];
  if (!SCANNED_TEXT_EDIT_REPAIRABLE_BACKGROUNDS.includes(classification)) {
    codes.push('BACKGROUND_NOT_REPAIRABLE');
  }
  if (geometry?.confidence < SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE) {
    codes.push('GEOMETRY_CONFIDENCE_LOW');
  }
  if (geometry?.clipped === true) codes.push('GEOMETRY_CLIPPED');
  if (geometry?.roundTripMaxErrorPx > SCANNED_TEXT_EDIT_MAX_ROUND_TRIP_ERROR_PX) {
    codes.push('TRANSFORM_ROUND_TRIP_EXCEEDED');
  }
  if (metrics?.sampleCount < SCANNED_TEXT_EDIT_MIN_BACKGROUND_SAMPLES
      || metrics?.sampleCoverage < SCANNED_TEXT_EDIT_MIN_BACKGROUND_COVERAGE) {
    codes.push('INSUFFICIENT_BACKGROUND_CONTEXT');
  }
  if (metrics?.opaqueFraction < SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION) {
    codes.push('NON_OPAQUE_BACKGROUND');
  }
  if (score < SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD) {
    codes.push('ELIGIBILITY_SCORE_BELOW_THRESHOLD');
  }
  return codes;
}

function validateEligibility(value, path, issues, classification, metrics, geometry) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['score', 'threshold', 'eligible', 'components', 'rejectionReasons']), path, issues);
  validateConfidence(value.score, `${path}.score`, issues);
  if (value.threshold !== SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD) {
    issues.push(`${path}.threshold must be ${SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD}`);
  }
  if (typeof value.eligible !== 'boolean') issues.push(`${path}.eligible must be boolean`);
  if (!Array.isArray(value.components)
      || value.components.length !== SCANNED_TEXT_EDIT_SCORE_COMPONENTS.length) {
    issues.push(`${path}.components must contain the four canonical score components`);
  } else {
    const ids = new Set();
    let contribution = 0;
    value.components.forEach((entry, index) => {
      const itemPath = `${path}.components[${index}]`;
      if (!isObject(entry)) {
        issues.push(`${itemPath} must be an object`);
        return;
      }
      requireExactKeys(entry, new Set(['id', 'value', 'weight', 'contribution']), itemPath, issues);
      validateIdentifier(entry.id, `${itemPath}.id`, issues);
      const expected = SCANNED_TEXT_EDIT_SCORE_COMPONENTS[index];
      if (entry.id !== expected.id || entry.weight !== expected.weight) {
        issues.push(`${itemPath} must be ${expected.id} with weight ${expected.weight}`);
      }
      if (ids.has(entry.id)) issues.push(`${itemPath}.id must be unique`);
      ids.add(entry.id);
      validateConfidence(entry.value, `${itemPath}.value`, issues);
      validateConfidence(entry.weight, `${itemPath}.weight`, issues);
      validateConfidence(entry.contribution, `${itemPath}.contribution`, issues);
      if (isFiniteNumber(entry.value) && isFiniteNumber(entry.weight)
          && isFiniteNumber(entry.contribution)
          && Math.abs(entry.value * entry.weight - entry.contribution) > 1e-6) {
        issues.push(`${itemPath}.contribution must equal value * weight`);
      }
      if (isFiniteNumber(entry.contribution)) contribution += entry.contribution;
    });
    if (isFiniteNumber(value.score) && Math.abs(contribution - value.score) > 1e-6) {
      issues.push(`${path}.score must equal the component contribution sum`);
    }
  }
  if (!Array.isArray(value.rejectionReasons)) {
    issues.push(`${path}.rejectionReasons must be an array`);
  } else {
    const codes = new Set();
    value.rejectionReasons.forEach((entry, index) => {
      const itemPath = `${path}.rejectionReasons[${index}]`;
      if (!isObject(entry)) {
        issues.push(`${itemPath} must be an object`);
        return;
      }
      requireExactKeys(entry, new Set(['code', 'message', 'evidence']), itemPath, issues);
      validateIdentifier(entry.code, `${itemPath}.code`, issues);
      if (!SCANNED_TEXT_EDIT_REJECTION_CODES.includes(entry.code)) {
        issues.push(`${itemPath}.code is unsupported`);
      }
      if (codes.has(entry.code)) issues.push(`${itemPath}.code must be unique`);
      codes.add(entry.code);
      validateString(entry.message, `${itemPath}.message`, issues, { nonEmpty: true, maxCodeUnits: 1024 });
      validateString(entry.evidence, `${itemPath}.evidence`, issues, { nonEmpty: true, maxCodeUnits: 1024 });
    });
  }
  if (typeof value.eligible === 'boolean' && Array.isArray(value.rejectionReasons)) {
    const expectedCodes = expectedRejectionCodes(classification, metrics, geometry, value.score);
    const actualCodes = value.rejectionReasons.map((entry) => entry?.code);
    if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes)) {
      issues.push(`${path}.rejectionReasons must exactly explain the failed eligibility gates`);
    }
    if (value.eligible !== (expectedCodes.length === 0)) {
      issues.push(`${path}.eligible must equal whether every eligibility gate passed`);
    }
  }
}

function validateAnalysis(value, path, issues, geometry) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['classifier', 'classifierVersion', 'classification', 'metrics', 'eligibility']), path, issues);
  if (value.classifier !== 'deterministic-background-statistics') {
    issues.push(`${path}.classifier must identify the deterministic classifier`);
  }
  if (value.classifierVersion !== 1) issues.push(`${path}.classifierVersion must be 1`);
  if (!SCANNED_TEXT_EDIT_CLASSIFICATIONS.includes(value.classification)) {
    issues.push(`${path}.classification is unsupported`);
  }
  validateMetrics(value.metrics, `${path}.metrics`, issues);
  validateEligibility(
    value.eligibility,
    `${path}.eligibility`,
    issues,
    value.classification,
    value.metrics,
    geometry,
  );
}

function validateChangedRegion(value, path, issues, approvedRegion) {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push(`${path} must be null or an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'actualBounds', 'changedPixelCount', 'outsideApprovedChangedPixels', 'maxChannelDelta',
    'beforeSha256', 'afterSha256',
  ]), path, issues);
  if (value.actualBounds !== null) {
    validateCoordinateBoundingBox(value.actualBounds, `${path}.actualBounds`, issues, {
      allowedSpaces: [OCR_SOURCE_RASTER_SPACE],
    });
  }
  validateNonNegativeInteger(value.changedPixelCount, `${path}.changedPixelCount`, issues);
  if (value.outsideApprovedChangedPixels !== 0) {
    issues.push(`${path}.outsideApprovedChangedPixels must be zero`);
  }
  validateNonNegativeInteger(value.maxChannelDelta, `${path}.maxChannelDelta`, issues, { maximum: 255 });
  for (const key of ['beforeSha256', 'afterSha256']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(value[key])) {
      issues.push(`${path}.${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (value.changedPixelCount === 0 && value.actualBounds !== null) {
    issues.push(`${path}.actualBounds must be null when no pixels changed`);
  }
  if (value.changedPixelCount > 0 && value.actualBounds === null) {
    issues.push(`${path}.actualBounds is required when pixels changed`);
  }
  if (approvedRegion && Number.isSafeInteger(value.changedPixelCount)
      && value.changedPixelCount > approvedRegion.width * approvedRegion.height) {
    issues.push(`${path}.changedPixelCount must fit inside repair.approvedRegion`);
  }
  if (value.changedPixelCount === 0
      && (value.maxChannelDelta !== 0 || value.beforeSha256 !== value.afterSha256)) {
    issues.push(`${path} zero changed pixels require zero delta and identical region digests`);
  }
  if (value.changedPixelCount > 0
      && (value.maxChannelDelta === 0 || value.beforeSha256 === value.afterSha256)) {
    issues.push(`${path} changed pixels require a non-zero delta and different region digests`);
  }
  if (value.actualBounds && approvedRegion) {
    const inside = value.actualBounds.x >= approvedRegion.x
      && value.actualBounds.y >= approvedRegion.y
      && value.actualBounds.x + value.actualBounds.width <= approvedRegion.x + approvedRegion.width
      && value.actualBounds.y + value.actualBounds.height <= approvedRegion.y + approvedRegion.height;
    if (!inside) issues.push(`${path}.actualBounds must stay inside repair.approvedRegion`);
  }
}

function validateRepair(value, path, issues, geometry, analysis) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'status', 'method', 'approvedRegion', 'repairedPatch', 'changedRegion',
  ]), path, issues);
  if (!['rejected', 'applied', 'reverted'].includes(value.status)) issues.push(`${path}.status is unsupported`);
  if (value.method !== null && !SCANNED_TEXT_EDIT_REPAIR_METHODS.includes(value.method)) {
    issues.push(`${path}.method is unsupported`);
  }
  validateCoordinateBoundingBox(value.approvedRegion, `${path}.approvedRegion`, issues, {
    allowedSpaces: [OCR_SOURCE_RASTER_SPACE],
  });
  if (JSON.stringify(value.approvedRegion) !== JSON.stringify(geometry?.repairBounds)) {
    issues.push(`${path}.approvedRegion must equal geometry.repairBounds`);
  }
  if (value.repairedPatch !== null) validatePatch(value.repairedPatch, `${path}.repairedPatch`, issues);
  validateChangedRegion(value.changedRegion, `${path}.changedRegion`, issues, value.approvedRegion);
  if (value.status === 'rejected' && (value.method !== null || value.repairedPatch !== null || value.changedRegion !== null)) {
    issues.push(`${path} rejected repairs must not carry replacement pixels`);
  }
  if (['applied', 'reverted'].includes(value.status)
      && (value.method === null || value.repairedPatch === null || value.changedRegion === null)) {
    issues.push(`${path} applied or reverted repairs require method, patch, and changed-region metadata`);
  }
  if (value.repairedPatch && value.approvedRegion
      && (value.repairedPatch.originX !== value.approvedRegion.x
        || value.repairedPatch.originY !== value.approvedRegion.y
        || value.repairedPatch.widthPx !== value.approvedRegion.width
        || value.repairedPatch.heightPx !== value.approvedRegion.height)) {
    issues.push(`${path}.repairedPatch must exactly cover approvedRegion`);
  }
  if (value.repairedPatch && value.changedRegion
      && value.changedRegion.afterSha256 !== value.repairedPatch.sha256) {
    issues.push(`${path}.changedRegion.afterSha256 must equal repairedPatch.sha256`);
  }
  const expectedMethod = analysis?.classification === 'flat'
    ? 'flat-median-fill-v1'
    : analysis?.classification === 'near-flat'
      ? 'near-flat-edge-interpolation-v1'
      : null;
  if (['applied', 'reverted'].includes(value.status) && value.method !== expectedMethod) {
    issues.push(`${path}.method must match the eligible background classification`);
  }
}

function validateOperationOwnership(value, path, issues, revision) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'owner', 'operationId', 'revision', 'parentRevision', 'createdAt', 'updatedAt',
  ]), path, issues);
  if (value.owner !== SCANNED_TEXT_EDIT_OWNER) issues.push(`${path}.owner must be ${SCANNED_TEXT_EDIT_OWNER}`);
  validateIdentifier(value.operationId, `${path}.operationId`, issues);
  validatePositiveInteger(value.revision, `${path}.revision`, issues);
  validateNonNegativeInteger(value.parentRevision, `${path}.parentRevision`, issues);
  if (Number.isSafeInteger(revision) && value.revision !== revision) {
    issues.push(`${path}.revision must equal selection.revision`);
  }
  if (Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.parentRevision)
      && value.parentRevision !== value.revision - 1) {
    issues.push(`${path}.parentRevision must be the immediately preceding revision`);
  }
  validateIsoTimestamp(value.createdAt, `${path}.createdAt`, issues);
  validateIsoTimestamp(value.updatedAt, `${path}.updatedAt`, issues);
  if (Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt))
      && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push(`${path}.updatedAt must not precede createdAt`);
  }
}

function validateTarget(value, path, issues) {
  const lineIds = new Set();
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return lineIds;
  }
  requireExactKeys(value, new Set(['kind', 'targetId', 'lineIds', 'result']), path, issues);
  if (!['line', 'region'].includes(value.kind)) issues.push(`${path}.kind is unsupported`);
  validateIdentifier(value.targetId, `${path}.targetId`, issues);
  if (!Array.isArray(value.lineIds) || value.lineIds.length === 0) {
    issues.push(`${path}.lineIds must be a non-empty array`);
  } else {
    value.lineIds.forEach((lineId, index) => {
      validateIdentifier(lineId, `${path}.lineIds[${index}]`, issues);
      if (lineIds.has(lineId)) issues.push(`${path}.lineIds[${index}] must be unique`);
      lineIds.add(lineId);
    });
  }
  if (value.kind === 'line' && (value.lineIds?.length !== 1 || value.targetId !== value.lineIds?.[0])) {
    issues.push(`${path} line targets must identify exactly their one stable OCR line ID`);
  }
  if (!isObject(value.result)) {
    issues.push(`${path}.result must be an object`);
  } else {
    requireExactKeys(value.result, new Set([
      'jobId', 'requestId', 'pageId', 'pageRevision', 'sourceRasterId', 'sourceRasterFingerprint',
    ]), `${path}.result`, issues);
    for (const key of ['jobId', 'requestId', 'pageId', 'sourceRasterId']) {
      validateIdentifier(value.result[key], `${path}.result.${key}`, issues);
    }
    validateNonNegativeInteger(value.result.pageRevision, `${path}.result.pageRevision`, issues);
    validateFingerprint(value.result.sourceRasterFingerprint, `${path}.result.sourceRasterFingerprint`, issues);
  }
  return lineIds;
}

function validateEstimate(value, path, issues, validateValue) {
  if (!isObject(value)) {
    issues.push(`${path} must be an estimate object`);
    return;
  }
  requireExactKeys(value, new Set(['value', 'estimated', 'confidence', 'method']), path, issues);
  if (value.estimated !== true) issues.push(`${path}.estimated must be true`);
  validateConfidence(value.confidence, `${path}.confidence`, issues);
  validateIdentifier(value.method, `${path}.method`, issues);
  validateValue(value.value, `${path}.value`, issues);
}

function validateEstimatedStyle(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'fontClass', 'fontSize', 'weight', 'italic', 'textColor', 'alignment',
  ]), path, issues);
  validateEstimate(value.fontClass, `${path}.fontClass`, issues, (entry, entryPath, entryIssues) => {
    if (!['serif', 'sans-serif', 'monospace'].includes(entry)) entryIssues.push(`${entryPath} is unsupported`);
  });
  validateEstimate(value.fontSize, `${path}.fontSize`, issues, (entry, entryPath, entryIssues) => {
    validatePositiveNumber(entry, entryPath, entryIssues);
  });
  validateEstimate(value.weight, `${path}.weight`, issues, (entry, entryPath, entryIssues) => {
    if (!['normal', 'bold'].includes(entry)) entryIssues.push(`${entryPath} is unsupported`);
  });
  validateEstimate(value.italic, `${path}.italic`, issues, (entry, entryPath, entryIssues) => {
    if (typeof entry !== 'boolean') entryIssues.push(`${entryPath} must be boolean`);
  });
  validateEstimate(value.textColor, `${path}.textColor`, issues, (entry, entryPath, entryIssues) => {
    if (typeof entry !== 'string' || !/^#[0-9a-f]{6}$/u.test(entry)) entryIssues.push(`${entryPath} must be lowercase RGB hex`);
  });
  validateEstimate(value.alignment, `${path}.alignment`, issues, (entry, entryPath, entryIssues) => {
    if (!['left', 'center', 'right'].includes(entry)) entryIssues.push(`${entryPath} is unsupported`);
  });
}

function validateSingleLineSource(value, path, issues, lineIds) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'ocrIds', 'originalText', 'originalPolygon', 'canonicalPolygon', 'canonicalBaseline',
  ]), path, issues);
  if (!isObject(value.ocrIds)) {
    issues.push(`${path}.ocrIds must be an object`);
  } else {
    requireExactKeys(value.ocrIds, new Set(['lineId', 'wordIds']), `${path}.ocrIds`, issues);
    validateIdentifier(value.ocrIds.lineId, `${path}.ocrIds.lineId`, issues);
    if (!lineIds.has(value.ocrIds.lineId)) issues.push(`${path}.ocrIds.lineId must identify the selected OCR line`);
    if (!Array.isArray(value.ocrIds.wordIds)) issues.push(`${path}.ocrIds.wordIds must be an array`);
    else {
      const seen = new Set();
      value.ocrIds.wordIds.forEach((id, index) => {
        validateIdentifier(id, `${path}.ocrIds.wordIds[${index}]`, issues);
        if (seen.has(id)) issues.push(`${path}.ocrIds.wordIds[${index}] must be unique`);
        seen.add(id);
      });
    }
  }
  validateString(value.originalText, `${path}.originalText`, issues, { nonEmpty: true, maxCodeUnits: 4096 });
  validateCoordinatePolygon(value.originalPolygon, `${path}.originalPolygon`, issues);
  validateCoordinatePolygon(value.canonicalPolygon, `${path}.canonicalPolygon`, issues, {
    allowedSpaces: [OCR_PDF_USER_SPACE],
  });
  validateBaseline(value.canonicalBaseline, `${path}.canonicalBaseline`, issues, {
    allowedSpaces: [OCR_PDF_USER_SPACE],
    allowedProvenance: ['ocr-engine', 'engine', 'estimated-from-ocr-polygon'],
  });
}

function validateSingleLineLayout(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'fontName', 'direction', 'shaping', 'glyphCoverage', 'encodedGlyphCount',
    'encodedText', 'widthPt', 'heightPt', 'availableWidthPt', 'availableHeightPt',
    'origin', 'angleDegrees', 'baselineAligned', 'overflow',
  ]), path, issues);
  validateString(value.fontName, `${path}.fontName`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  if (value.direction !== 'ltr') issues.push(`${path}.direction must be ltr`);
  if (value.shaping !== 'pdf-lib-standard-font-winansi-v1') issues.push(`${path}.shaping is unsupported`);
  if (value.glyphCoverage !== 'complete') issues.push(`${path}.glyphCoverage must be complete`);
  validatePositiveInteger(value.encodedGlyphCount, `${path}.encodedGlyphCount`, issues);
  validateString(value.encodedText, `${path}.encodedText`, issues, { nonEmpty: true, maxCodeUnits: 16384 });
  for (const key of ['widthPt', 'heightPt', 'availableWidthPt', 'availableHeightPt']) {
    validatePositiveNumber(value[key], `${path}.${key}`, issues);
  }
  if (!isObject(value.origin)) issues.push(`${path}.origin must be an object`);
  else {
    requireExactKeys(value.origin, new Set(['coordinateSpace', 'point']), `${path}.origin`, issues);
    if (value.origin.coordinateSpace !== OCR_PDF_USER_SPACE) issues.push(`${path}.origin.coordinateSpace must be ${OCR_PDF_USER_SPACE}`);
    if (!Array.isArray(value.origin.point) || value.origin.point.length !== 2 || !value.origin.point.every(isFiniteNumber)) {
      issues.push(`${path}.origin.point must contain two finite numbers`);
    }
  }
  if (!isFiniteNumber(value.angleDegrees) || Math.abs(value.angleDegrees) > 3.000001) {
    issues.push(`${path}.angleDegrees must remain horizontal within three degrees`);
  }
  if (value.baselineAligned !== true) issues.push(`${path}.baselineAligned must be true`);
  if (value.overflow !== false) issues.push(`${path}.overflow must be false`);
}

function validateHalo(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'maxBoundaryChannelDelta', 'meanBoundaryChannelDelta', 'sampleCount', 'tolerance', 'passed',
  ]), path, issues);
  validateNonNegativeInteger(value.maxBoundaryChannelDelta, `${path}.maxBoundaryChannelDelta`, issues, { maximum: 255 });
  validateNonNegativeNumber(value.meanBoundaryChannelDelta, `${path}.meanBoundaryChannelDelta`, issues);
  validateNonNegativeInteger(value.sampleCount, `${path}.sampleCount`, issues);
  if (!isObject(value.tolerance)) issues.push(`${path}.tolerance must be an object`);
  else {
    requireExactKeys(value.tolerance, new Set(['maxBoundaryChannelDelta', 'meanBoundaryChannelDelta']), `${path}.tolerance`, issues);
    if (value.tolerance.maxBoundaryChannelDelta !== 72) issues.push(`${path}.tolerance.maxBoundaryChannelDelta must be 72`);
    if (value.tolerance.meanBoundaryChannelDelta !== 24) issues.push(`${path}.tolerance.meanBoundaryChannelDelta must be 24`);
  }
  if (value.passed !== true) issues.push(`${path}.passed must be true`);
}

function validateSingleLineContent(value, path, issues, selection, lineIds) {
  if (value === null) return;
  if (!isObject(value)) {
    issues.push(`${path} must be null or an object`);
    return;
  }
  requireExactKeys(value, new Set([
    'scope', 'source', 'replacementText', 'estimatedStyle', 'layout', 'repairPatch',
    'visibleReplacement', 'searchableText', 'undo',
  ]), path, issues);
  if (value.scope !== 'isolated-horizontal-line') issues.push(`${path}.scope must be isolated-horizontal-line`);
  if (selection?.target?.kind !== 'line' || lineIds.size !== 1) issues.push(`${path} may exist only for one OCR line target`);
  validateSingleLineSource(value.source, `${path}.source`, issues, lineIds);
  validateString(value.replacementText, `${path}.replacementText`, issues, { nonEmpty: true, maxCodeUnits: 4096 });
  if (typeof value.replacementText === 'string' && /[\r\n\u2028\u2029]/u.test(value.replacementText)) {
    issues.push(`${path}.replacementText must remain one line`);
  }
  validateEstimatedStyle(value.estimatedStyle, `${path}.estimatedStyle`, issues);
  validateSingleLineLayout(value.layout, `${path}.layout`, issues);
  validatePatch(value.repairPatch, `${path}.repairPatch`, issues);
  if (value.repairPatch?.sha256 !== selection?.repair?.repairedPatch?.sha256) {
    issues.push(`${path}.repairPatch must equal the owned background repair patch`);
  }
  if (!isObject(value.visibleReplacement)) issues.push(`${path}.visibleReplacement must be an object`);
  else {
    requireExactKeys(value.visibleReplacement, new Set([
      'text', 'patch', 'halo', 'outsideEditRegionChangedPixels',
    ]), `${path}.visibleReplacement`, issues);
    if (value.visibleReplacement.text !== value.replacementText) issues.push(`${path}.visibleReplacement.text must equal replacementText`);
    validatePatch(value.visibleReplacement.patch, `${path}.visibleReplacement.patch`, issues);
    validateHalo(value.visibleReplacement.halo, `${path}.visibleReplacement.halo`, issues);
    if (value.visibleReplacement.outsideEditRegionChangedPixels !== 0) {
      issues.push(`${path}.visibleReplacement.outsideEditRegionChangedPixels must be zero`);
    }
  }
  if (!isObject(value.searchableText)) issues.push(`${path}.searchableText must be an object`);
  else {
    requireExactKeys(value.searchableText, new Set(['text', 'renderingMode', 'synchronized']), `${path}.searchableText`, issues);
    if (value.searchableText.text !== value.replacementText) issues.push(`${path}.searchableText.text must equal replacementText`);
    if (value.searchableText.renderingMode !== 'owned-invisible-ocr') issues.push(`${path}.searchableText.renderingMode is unsupported`);
    if (value.searchableText.synchronized !== true) issues.push(`${path}.searchableText.synchronized must be true`);
  }
  if (!isObject(value.undo)) issues.push(`${path}.undo must be an object`);
  else {
    requireExactKeys(value.undo, new Set(['kind', 'before', 'after', 'revision', 'parentRevision']), `${path}.undo`, issues);
    if (value.undo.kind !== 'scanned-text-edit') issues.push(`${path}.undo.kind is unsupported`);
    for (const key of ['before', 'after']) {
      if (!isObject(value.undo[key])) issues.push(`${path}.undo.${key} must be an object`);
      else {
        requireExactKeys(value.undo[key], new Set(['text', 'repairStatus']), `${path}.undo.${key}`, issues);
        validateString(value.undo[key].text, `${path}.undo.${key}.text`, issues, { nonEmpty: true, maxCodeUnits: 4096 });
      }
    }
    if (!['original', 'applied'].includes(value.undo.before?.repairStatus)) issues.push(`${path}.undo.before.repairStatus is unsupported`);
    if (value.undo.after?.repairStatus !== 'applied') issues.push(`${path}.undo.after.repairStatus must be applied`);
    if (value.undo.parentRevision === 0
        && (value.undo.before?.repairStatus !== 'original' || value.undo.before?.text !== value.source?.originalText)) {
      issues.push(`${path}.undo first revision must begin with source.originalText`);
    }
    if (value.undo.parentRevision > 0 && value.undo.before?.repairStatus !== 'applied') {
      issues.push(`${path}.undo later revisions must begin with the preceding applied edit`);
    }
    if (value.undo.after?.text !== value.replacementText) issues.push(`${path}.undo.after.text must equal replacementText`);
    if (value.undo.revision !== selection?.revision || value.undo.parentRevision !== selection?.ownership?.parentRevision) {
      issues.push(`${path}.undo revisions must equal selection ownership revisions`);
    }
  }
}

function validateSelection(value, path, issues, page) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const selectionKeys = new Set([
    'id', 'revision', 'target', 'geometry', 'originalPatch', 'analysis', 'repair', 'ownership',
  ]);
  if (Object.hasOwn(value, 'content')) selectionKeys.add('content');
  requireExactKeys(value, selectionKeys, path, issues);
  validateSelectionIdentifier(value.id, `${path}.id`, issues);
  validatePositiveInteger(value.revision, `${path}.revision`, issues);
  const lineIds = validateTarget(value.target, `${path}.target`, issues);
  const expectedId = typeof page?.id === 'string'
    && ['line', 'region'].includes(value.target?.kind)
    && typeof value.target?.targetId === 'string'
    ? deriveScannedTextEditSelectionId(page.id, value.target.kind, value.target.targetId)
    : null;
  if (expectedId !== null && value.id !== expectedId) {
    issues.push(`${path}.id must be derived from the stable page and target IDs`);
  }
  if (value.target?.result?.pageId !== page?.id || value.target?.result?.pageRevision !== page?.revision
      || value.target?.result?.sourceRasterId !== page?.sourceRaster?.id
      || JSON.stringify(value.target?.result?.sourceRasterFingerprint) !== JSON.stringify(page?.sourceRaster?.fingerprint)) {
    issues.push(`${path}.target.result must match the owning page and source raster`);
  }
  validateGeometry(value.geometry, `${path}.geometry`, issues, lineIds, page?.sourceRaster);
  validatePatch(value.originalPatch, `${path}.originalPatch`, issues);
  if (value.originalPatch && value.geometry?.extractionBounds
      && (value.originalPatch.originX !== value.geometry.extractionBounds.x
        || value.originalPatch.originY !== value.geometry.extractionBounds.y
        || value.originalPatch.widthPx !== value.geometry.extractionBounds.width
        || value.originalPatch.heightPx !== value.geometry.extractionBounds.height)) {
    issues.push(`${path}.originalPatch must exactly cover geometry.extractionBounds`);
  }
  validateAnalysis(value.analysis, `${path}.analysis`, issues, value.geometry);
  validateRepair(value.repair, `${path}.repair`, issues, value.geometry, value.analysis);
  if (Object.hasOwn(value, 'content')) {
    validateSingleLineContent(value.content, `${path}.content`, issues, value, lineIds);
  }
  validateOperationOwnership(value.ownership, `${path}.ownership`, issues, value.revision);
  if (value.analysis?.eligibility?.eligible === true && value.repair?.status === 'rejected') {
    issues.push(`${path}.repair may not be rejected when eligibility is true`);
  }
  if (value.analysis?.eligibility?.eligible === false && value.repair?.status !== 'rejected') {
    issues.push(`${path}.repair must be rejected when eligibility is false`);
  }
}

function validateSearchableTextSnapshot(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  const ids = new Set();
  value.forEach((line, index) => {
    const linePath = `${path}[${index}]`;
    if (!isObject(line)) {
      issues.push(`${linePath} must be an object`);
      return;
    }
    const required = new Set(['lineId', 'text', 'confidence', 'readingOrder', 'direction', 'polygon', 'baseline']);
    if (Object.hasOwn(line, 'words')) required.add('words');
    requireExactKeys(line, required, linePath, issues);
    validateIdentifier(line.lineId, `${linePath}.lineId`, issues);
    if (ids.has(line.lineId)) issues.push(`${linePath}.lineId must be unique`);
    ids.add(line.lineId);
    validateString(line.text, `${linePath}.text`, issues, { nonEmpty: true, maxCodeUnits: 4096 });
    validateConfidence(line.confidence, `${linePath}.confidence`, issues);
    validateNonNegativeInteger(line.readingOrder, `${linePath}.readingOrder`, issues);
    if (line.direction !== null && !['ltr', 'rtl', 'ttb', 'btt'].includes(line.direction)) {
      issues.push(`${linePath}.direction must be null or a supported OCR direction`);
    }
    validateCoordinatePolygon(line.polygon, `${linePath}.polygon`, issues, { allowedSpaces: [OCR_PDF_USER_SPACE] });
    validateBaseline(line.baseline, `${linePath}.baseline`, issues, {
      allowedSpaces: [OCR_PDF_USER_SPACE],
      allowedProvenance: ['engine', 'ocr-engine', 'estimated-from-ocr-polygon'],
    });
    if (line.words !== undefined) {
      if (!Array.isArray(line.words)) issues.push(`${linePath}.words must be an array`);
      else line.words.forEach((word, wordIndex) => {
        const wordPath = `${linePath}.words[${wordIndex}]`;
        if (!isObject(word)) {
          issues.push(`${wordPath} must be an object`);
          return;
        }
        requireExactKeys(word, new Set(['id', 'text', 'direction', 'polygon']), wordPath, issues);
        validateIdentifier(word.id, `${wordPath}.id`, issues);
        validateString(word.text, `${wordPath}.text`, issues, { nonEmpty: true, maxCodeUnits: 4096 });
        if (word.direction !== null && !['ltr', 'rtl', 'ttb', 'btt'].includes(word.direction)) {
          issues.push(`${wordPath}.direction must be null or a supported OCR direction`);
        }
        validateCoordinatePolygon(word.polygon, `${wordPath}.polygon`, issues, { allowedSpaces: [OCR_PDF_USER_SPACE] });
      });
    }
  });
}

function validatePage(value, index, state, issues) {
  const path = `pages[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const pageKeys = new Set([
    'id', 'index', 'revision', 'sourceRaster', 'pageGeometry', 'selections',
  ]);
  if (Object.hasOwn(value, 'searchableTextSnapshot')) pageKeys.add('searchableTextSnapshot');
  requireExactKeys(value, pageKeys, path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  if (state.pageIds.has(value.id)) issues.push(`${path}.id must be unique`);
  state.pageIds.add(value.id);
  validateNonNegativeInteger(value.index, `${path}.index`, issues);
  if (state.pageIndexes.has(value.index)) issues.push(`${path}.index must be unique`);
  state.pageIndexes.add(value.index);
  if (Number.isSafeInteger(value.index) && value.index >= state.pageCount) {
    issues.push(`${path}.index must identify a document page`);
  }
  validateNonNegativeInteger(value.revision, `${path}.revision`, issues);
  validateSourceRaster(value.sourceRaster, `${path}.sourceRaster`, issues);
  if (!isObject(value.pageGeometry)) {
    issues.push(`${path}.pageGeometry must be an object`);
  } else if (Object.hasOwn(value.pageGeometry, 'transformChain')) {
    const geometryValidation = validateOcrPageGeometryV1(value.pageGeometry);
    issues.push(...geometryValidation.issues.map((issue) => `${path}.pageGeometry.${issue}`));
    if (value.pageGeometry.page?.id !== value.id
        || value.pageGeometry.page?.index !== value.index
        || value.pageGeometry.page?.revision !== value.revision
        || value.pageGeometry.sourceRaster?.id !== value.sourceRaster?.id
        || value.pageGeometry.document?.id !== state.document?.id
        || value.pageGeometry.document?.revision !== state.document?.revision
        || value.pageGeometry.document?.generation !== state.document?.generation) {
      issues.push(`${path}.pageGeometry must match the owning document, page, and source raster`);
    }
  } else {
    requireExactKeys(value.pageGeometry, new Set(['contract', 'schemaVersion', 'geometryId']), `${path}.pageGeometry`, issues);
    if (value.pageGeometry.contract !== 'open-pdf-studio.ocr.page-geometry') {
      issues.push(`${path}.pageGeometry.contract is unsupported`);
    }
    if (value.pageGeometry.schemaVersion !== 1) issues.push(`${path}.pageGeometry.schemaVersion must be 1`);
    validateIdentifier(value.pageGeometry.geometryId, `${path}.pageGeometry.geometryId`, issues);
  }
  if (Object.hasOwn(value, 'searchableTextSnapshot')) {
    validateSearchableTextSnapshot(value.searchableTextSnapshot, `${path}.searchableTextSnapshot`, issues);
  }
  if (!Array.isArray(value.selections)) {
    issues.push(`${path}.selections must be an array`);
  } else {
    if (value.selections.length === 0) issues.push(`${path}.selections must not be empty`);
    value.selections.forEach((selection, selectionIndex) => {
      validateSelection(selection, `${path}.selections[${selectionIndex}]`, issues, value);
      if (state.selectionIds.has(selection?.id)) {
        issues.push(`${path}.selections[${selectionIndex}].id must be unique across the document`);
      }
      state.selectionIds.add(selection?.id);
    });
  }
}

function validateHistory(value, issues) {
  if (!isObject(value)) {
    issues.push('history must be an object');
    return;
  }
  requireExactKeys(value, new Set(['generation', 'undoDepth', 'redoDepth', 'lastOperationId']), 'history', issues);
  validateNonNegativeInteger(value.generation, 'history.generation', issues);
  validateNonNegativeInteger(value.undoDepth, 'history.undoDepth', issues);
  validateNonNegativeInteger(value.redoDepth, 'history.redoDepth', issues);
  if (value.lastOperationId !== null) validateIdentifier(value.lastOperationId, 'history.lastOperationId', issues);
}

export function validateScannedTextEditStateV1(value, {
  maxSerializedBytes = SCANNED_TEXT_EDIT_MAX_STATE_BYTES,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['scanned-text edit state must be an object'] };
  validateJsonValue(value, 'scannedTextEditState', issues);
  if (!validateSerializedSize(value, 'scannedTextEditState', issues, maxSerializedBytes)) {
    return { ok: false, issues };
  }
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'stateId', 'owner', 'document', 'stateRevision',
    'pages', 'history', 'createdAt', 'updatedAt',
  ]), 'scannedTextEditState', issues);
  if (value.contract !== SCANNED_TEXT_EDIT_STATE_CONTRACT) {
    issues.push(`contract must be ${SCANNED_TEXT_EDIT_STATE_CONTRACT}`);
  }
  if (value.schemaVersion !== SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION}`);
  }
  validateIdentifier(value.stateId, 'stateId', issues);
  validateOwner(value.owner, issues);
  validateDocument(value.document, issues);
  validateNonNegativeInteger(value.stateRevision, 'stateRevision', issues);
  if (!Array.isArray(value.pages)) {
    issues.push('pages must be an array');
  } else {
    const state = {
      pageIds: new Set(),
      pageIndexes: new Set(),
      selectionIds: new Set(),
      pageCount: value.document?.pageCount,
      document: value.document,
    };
    value.pages.forEach((page, index) => validatePage(page, index, state, issues));
  }
  validateHistory(value.history, issues);
  if (Number.isSafeInteger(value.stateRevision) && Number.isSafeInteger(value.history?.generation)
      && value.stateRevision !== value.history.generation) {
    issues.push('stateRevision must equal history.generation');
  }
  if (Array.isArray(value.pages)) {
    const operations = value.pages.flatMap((page) => page?.selections ?? [])
      .map((selection) => selection?.ownership?.operationId)
      .filter((operationId) => typeof operationId === 'string');
    if (value.stateRevision === 0
        && (operations.length !== 0 || value.history?.lastOperationId !== null)) {
      issues.push('an initial state must not contain operations');
    }
    if (value.stateRevision > 0
        && (operations.length === 0 || !operations.includes(value.history?.lastOperationId))) {
      issues.push('history.lastOperationId must identify a retained selection operation');
    }
  }
  validateIsoTimestamp(value.createdAt, 'createdAt', issues);
  validateIsoTimestamp(value.updatedAt, 'updatedAt', issues);
  if (Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt))
      && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    issues.push('updatedAt must not precede createdAt');
  }
  return { ok: issues.length === 0, issues };
}

export function assertScannedTextEditStateV1(value, options) {
  const validation = validateScannedTextEditStateV1(value, options);
  if (!validation.ok) throw new OcrContractError(SCANNED_TEXT_EDIT_STATE_CONTRACT, validation.issues);
  return value;
}

export function toValidatedScannedTextEditStateV1Json(value, options) {
  assertScannedTextEditStateV1(value, options);
  const parsed = JSON.parse(JSON.stringify(value));
  assertScannedTextEditStateV1(parsed, options);
  return parsed;
}
