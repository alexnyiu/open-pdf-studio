import {
  OCR_CONTRACT_LIMITS,
  OcrContractError,
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateFingerprint,
  validateIdentifier,
  validateJsonValue,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validatePositiveNumber,
  validateSerializedSize,
  validateString,
} from './validation.js';
import {
  OCR_CROPPED_DISPLAY_PDF_SPACE,
  OCR_ENGINE_GEOMETRY_SPACE,
  OCR_ORIENTATION_ADJUSTED_SPACE,
  OCR_PDF_USER_SPACE,
  OCR_PREPROCESSED_RASTER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  createHomographyOperation,
  mapBaselineBetweenSpaces,
  mapPointBetweenSpaces,
  mapPolygonBetweenSpaces,
  validateHomographyInverse,
  validatePdfBox,
  validateRasterIdentity,
} from './geometry.js';

export const OCR_PAGE_GEOMETRY_CONTRACT = 'open-pdf-studio.ocr.page-geometry';
export const OCR_PAGE_GEOMETRY_SCHEMA_VERSION = 1;
export const OCR_TRANSFORM_CHAIN_CONTRACT = 'open-pdf-studio.ocr.transform-chain';
export const OCR_TRANSFORM_CHAIN_SCHEMA_VERSION = 1;
export const PDFIUM_PAGE_GEOMETRY_CONTRACT = 'open-pdf-studio.pdfium.page-geometry';
export const PDFIUM_PAGE_GEOMETRY_SCHEMA_VERSION = 1;

export const OCR_PAGE_GEOMETRY_SPACES = Object.freeze([
  Object.freeze({ id: OCR_PDF_USER_SPACE, unit: 'pdf-user-unit', origin: 'pdf-user-space-zero', xAxis: 'right', yAxis: 'up' }),
  Object.freeze({ id: OCR_CROPPED_DISPLAY_PDF_SPACE, unit: 'pdf-point', origin: 'displayed-crop-top-left', xAxis: 'right', yAxis: 'down' }),
  Object.freeze({ id: OCR_SOURCE_RASTER_SPACE, unit: 'pixel', origin: 'top-left-pixel-edge', xAxis: 'right', yAxis: 'down' }),
  Object.freeze({ id: OCR_ORIENTATION_ADJUSTED_SPACE, unit: 'pixel', origin: 'top-left-pixel-edge', xAxis: 'right', yAxis: 'down' }),
  Object.freeze({ id: OCR_PREPROCESSED_RASTER_SPACE, unit: 'pixel', origin: 'top-left-pixel-edge', xAxis: 'right', yAxis: 'down' }),
  Object.freeze({ id: OCR_ENGINE_GEOMETRY_SPACE, unit: 'engine-pixel', origin: 'top-left-pixel-edge', xAxis: 'right', yAxis: 'down' }),
]);

const ROTATIONS = Object.freeze([0, 90, 180, 270]);
const OPERATION_SPECS = Object.freeze([
  Object.freeze({ id: 'raw-pdf-to-cropped-display', kind: 'crop-user-unit-display-rotation', fromSpace: OCR_PDF_USER_SPACE, toSpace: OCR_CROPPED_DISPLAY_PDF_SPACE }),
  Object.freeze({ id: 'cropped-display-to-rendered-raster', kind: 'pdfium-rasterization', fromSpace: OCR_CROPPED_DISPLAY_PDF_SPACE, toSpace: OCR_SOURCE_RASTER_SPACE }),
  Object.freeze({ id: 'rendered-raster-to-orientation-adjusted', kind: 'orientation-preprocessing', fromSpace: OCR_SOURCE_RASTER_SPACE, toSpace: OCR_ORIENTATION_ADJUSTED_SPACE }),
  Object.freeze({ id: 'orientation-adjusted-to-preprocessed-ocr', kind: 'deskew-preprocessing', fromSpace: OCR_ORIENTATION_ADJUSTED_SPACE, toSpace: OCR_PREPROCESSED_RASTER_SPACE }),
  Object.freeze({ id: 'preprocessed-ocr-to-engine-geometry', kind: 'engine-geometry-mapping', fromSpace: OCR_PREPROCESSED_RASTER_SPACE, toSpace: OCR_ENGINE_GEOMETRY_SPACE }),
]);
const PROVENANCE_SOURCES = Object.freeze([
  'pdf-page-dictionary', 'application-state', 'pdfium-render', 'ocr-preprocessing', 'ocr-engine-adapter',
]);

const clone = (value) => structuredClone(value);
const clockwiseRotation = (value) => ((value % 360) + 360) % 360;
const approximatelyEqual = (left, right, tolerance = 1e-7) =>
  Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
const matricesEqual = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === 9 &&
  right.length === 9 && left.every((entry, index) => isFiniteNumber(entry) &&
    isFiniteNumber(right[index]) && approximatelyEqual(entry, right[index]));

function rawPdfToDisplayMatrix(cropBox, userUnit, rotation) {
  const { x, y, width, height } = cropBox;
  switch (rotation) {
    case 0: return [userUnit, 0, -x * userUnit, 0, -userUnit, (y + height) * userUnit, 0, 0, 1];
    case 90: return [0, userUnit, -y * userUnit, userUnit, 0, -x * userUnit, 0, 0, 1];
    case 180: return [-userUnit, 0, (x + width) * userUnit, 0, userUnit, -y * userUnit, 0, 0, 1];
    case 270: return [0, -userUnit, (y + height) * userUnit, -userUnit, 0, (x + width) * userUnit, 0, 0, 1];
    default: throw new RangeError('display rotation must be 0, 90, 180, or 270 degrees');
  }
}

function orientationMatrix(width, height, rotation) {
  switch (rotation) {
    case 0: return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    case 90: return [0, -1, height, 1, 0, 0, 0, 0, 1];
    case 180: return [-1, 0, width, 0, -1, height, 0, 0, 1];
    case 270: return [0, 1, 0, -1, 0, width, 0, 0, 1];
    default: throw new RangeError('orientation rotation must be 0, 90, 180, or 270 degrees');
  }
}

function deskewMatrix(inputWidth, inputHeight, outputWidth, outputHeight, degreesClockwise) {
  const radians = degreesClockwise * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const inputCenterX = inputWidth / 2;
  const inputCenterY = inputHeight / 2;
  const outputCenterX = outputWidth / 2;
  const outputCenterY = outputHeight / 2;
  return [
    cosine, -sine, outputCenterX - cosine * inputCenterX + sine * inputCenterY,
    sine, cosine, outputCenterY - sine * inputCenterX - cosine * inputCenterY,
    0, 0, 1,
  ];
}

function displayDimensions(cropBox, userUnit, totalRotation) {
  const width = cropBox.width * userUnit;
  const height = cropBox.height * userUnit;
  return totalRotation === 90 || totalRotation === 270 ? { width: height, height: width } : { width, height };
}

function orientationDimensions(width, height, rotation) {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

function validateDocument(value, issues) {
  if (!isObject(value)) { issues.push('document must be an object'); return; }
  requireExactKeys(value, new Set(['id', 'fingerprint', 'revision', 'generation', 'pageCount']), 'document', issues);
  validateIdentifier(value.id, 'document.id', issues);
  validateFingerprint(value.fingerprint, 'document.fingerprint', issues);
  validateNonNegativeInteger(value.revision, 'document.revision', issues);
  validateIdentifier(value.generation, 'document.generation', issues);
  validatePositiveInteger(value.pageCount, 'document.pageCount', issues, { maximum: OCR_CONTRACT_LIMITS.maxPagesPerJob });
}

function validatePage(value, pageCount, issues) {
  if (!isObject(value)) { issues.push('page must be an object'); return; }
  requireExactKeys(value, new Set(['id', 'index', 'revision']), 'page', issues);
  validateIdentifier(value.id, 'page.id', issues);
  validateNonNegativeInteger(value.index, 'page.index', issues);
  validateNonNegativeInteger(value.revision, 'page.revision', issues);
  if (Number.isSafeInteger(value.index) && Number.isSafeInteger(pageCount) && value.index >= pageCount) {
    issues.push('page.index must identify a page in document.pageCount');
  }
}

function containsBox(outer, inner) {
  if (![outer?.x, outer?.y, outer?.width, outer?.height, inner?.x, inner?.y, inner?.width, inner?.height].every(isFiniteNumber)) return true;
  const epsilon = 1e-6;
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon;
}

function validateBoxes(value, issues) {
  if (!isObject(value)) { issues.push('boxes must be an object'); return; }
  const names = ['mediaBox', 'cropBox', 'bleedBox', 'trimBox', 'artBox'];
  requireExactKeys(value, new Set(names), 'boxes', issues);
  validatePdfBox(value.mediaBox, 'boxes.mediaBox', issues);
  validatePdfBox(value.cropBox, 'boxes.cropBox', issues);
  for (const name of ['bleedBox', 'trimBox', 'artBox']) if (value[name] !== null) validatePdfBox(value[name], `boxes.${name}`, issues);
  for (const name of ['cropBox', 'bleedBox', 'trimBox', 'artBox']) {
    if (value[name] !== null && !containsBox(value.mediaBox, value[name])) issues.push(`boxes.${name} must be contained by boxes.mediaBox`);
  }
}

function validateCoordinateSpaces(value, issues) {
  if (!Array.isArray(value) || value.length !== OCR_PAGE_GEOMETRY_SPACES.length) {
    issues.push(`coordinateSpaces must contain ${OCR_PAGE_GEOMETRY_SPACES.length} authoritative spaces`);
    return;
  }
  const byId = new Map();
  value.forEach((space, index) => {
    if (!isObject(space)) { issues.push(`coordinateSpaces[${index}] must be an object`); return; }
    requireExactKeys(space, new Set(['id', 'unit', 'origin', 'xAxis', 'yAxis']), `coordinateSpaces[${index}]`, issues);
    if (byId.has(space.id)) issues.push(`coordinateSpaces[${index}].id must be unique`);
    byId.set(space.id, space);
  });
  for (const expected of OCR_PAGE_GEOMETRY_SPACES) {
    const actual = byId.get(expected.id);
    if (!actual || Object.entries(expected).some(([key, entry]) => actual[key] !== entry)) {
      issues.push(`coordinateSpaces must define ${expected.id} with its canonical unit, origin, and axes`);
    }
  }
}

function validateUserUnit(value, issues) {
  if (!isObject(value)) { issues.push('userUnit must be an object'); return; }
  requireExactKeys(value, new Set(['value', 'pointsPerUnit', 'provenance']), 'userUnit', issues);
  validatePositiveNumber(value.value, 'userUnit.value', issues);
  validatePositiveNumber(value.pointsPerUnit, 'userUnit.pointsPerUnit', issues);
  if (isFiniteNumber(value.value) && value.value > 75_000) issues.push('userUnit.value must not exceed 75000');
  if (isFiniteNumber(value.value) && isFiniteNumber(value.pointsPerUnit) && !approximatelyEqual(value.value, value.pointsPerUnit)) {
    issues.push('userUnit.pointsPerUnit must equal userUnit.value');
  }
  if (!['pdf-page-dictionary', 'pdf-default'].includes(value.provenance)) issues.push('userUnit.provenance is unsupported');
}

function validateRotations(value, issues) {
  if (!isObject(value)) { issues.push('rotations must be an object'); return; }
  requireExactKeys(value, new Set(['intrinsicDegreesClockwise', 'applicationDegreesClockwise', 'totalDegreesClockwise']), 'rotations', issues);
  for (const key of ['intrinsicDegreesClockwise', 'applicationDegreesClockwise', 'totalDegreesClockwise']) {
    if (!ROTATIONS.includes(value[key])) issues.push(`rotations.${key} is unsupported`);
  }
  if (ROTATIONS.includes(value.intrinsicDegreesClockwise) && ROTATIONS.includes(value.applicationDegreesClockwise) &&
      value.totalDegreesClockwise !== clockwiseRotation(value.intrinsicDegreesClockwise + value.applicationDegreesClockwise)) {
    issues.push('rotations.totalDegreesClockwise must combine intrinsic and application rotation');
  }
}

function validateDisplayedPage(value, cropBox, userUnit, rotations, issues) {
  if (!isObject(value)) { issues.push('displayedPage must be an object'); return; }
  requireExactKeys(value, new Set(['coordinateSpace', 'width', 'height']), 'displayedPage', issues);
  if (value.coordinateSpace !== OCR_CROPPED_DISPLAY_PDF_SPACE) issues.push(`displayedPage.coordinateSpace must be ${OCR_CROPPED_DISPLAY_PDF_SPACE}`);
  validatePositiveNumber(value.width, 'displayedPage.width', issues);
  validatePositiveNumber(value.height, 'displayedPage.height', issues);
  if (isObject(cropBox) && isFiniteNumber(userUnit?.value) && ROTATIONS.includes(rotations?.totalDegreesClockwise)) {
    const expected = displayDimensions(cropBox, userUnit.value, rotations.totalDegreesClockwise);
    if (!approximatelyEqual(value.width, expected.width) || !approximatelyEqual(value.height, expected.height)) {
      issues.push('displayedPage dimensions must equal the rotated CropBox dimensions in PDF points');
    }
  }
}

function validateRendering(value, displayedPage, sourceRaster, issues) {
  if (!isObject(value)) { issues.push('rendering must be an object'); return; }
  requireExactKeys(value, new Set(['requested', 'exclusions', 'rounding']), 'rendering', issues);
  if (!isObject(value.requested)) issues.push('rendering.requested must be an object');
  else {
    requireExactKeys(value.requested, new Set(['dpi', 'scale']), 'rendering.requested', issues);
    validatePositiveNumber(value.requested.dpi, 'rendering.requested.dpi', issues);
    validatePositiveNumber(value.requested.scale, 'rendering.requested.scale', issues);
    if (isFiniteNumber(value.requested.dpi) && isFiniteNumber(value.requested.scale) && !approximatelyEqual(value.requested.dpi, value.requested.scale * 72)) {
      issues.push('rendering.requested.dpi must equal rendering.requested.scale * 72');
    }
  }
  if (!isObject(value.exclusions)) issues.push('rendering.exclusions must be an object');
  else {
    requireExactKeys(value.exclusions, new Set(['annotationsExcluded', 'formsExcluded']), 'rendering.exclusions', issues);
    for (const key of ['annotationsExcluded', 'formsExcluded']) if (typeof value.exclusions[key] !== 'boolean') issues.push(`rendering.exclusions.${key} must be boolean`);
  }
  const rounding = value.rounding;
  if (!isObject(rounding)) { issues.push('rendering.rounding must be an object'); return; }
  requireExactKeys(rounding, new Set([
    'idealWidthPx', 'idealHeightPx', 'requestedWidthPx', 'requestedHeightPx', 'actualWidthPx', 'actualHeightPx',
    'widthDeltaPx', 'heightDeltaPx', 'pdfiumAdjusted', 'method',
  ]), 'rendering.rounding', issues);
  for (const key of ['idealWidthPx', 'idealHeightPx']) validatePositiveNumber(rounding[key], `rendering.rounding.${key}`, issues);
  for (const key of ['requestedWidthPx', 'requestedHeightPx', 'actualWidthPx', 'actualHeightPx']) validatePositiveInteger(rounding[key], `rendering.rounding.${key}`, issues);
  for (const key of ['widthDeltaPx', 'heightDeltaPx']) if (!isFiniteNumber(rounding[key])) issues.push(`rendering.rounding.${key} must be a finite number`);
  if (typeof rounding.pdfiumAdjusted !== 'boolean') issues.push('rendering.rounding.pdfiumAdjusted must be boolean');
  if (rounding.method !== 'ceil-target-then-pdfium') issues.push('rendering.rounding.method is unsupported');
  if (isFiniteNumber(displayedPage?.width) && isFiniteNumber(displayedPage?.height) && isFiniteNumber(value.requested?.scale)) {
    const idealWidth = displayedPage.width * value.requested.scale;
    const idealHeight = displayedPage.height * value.requested.scale;
    if (!approximatelyEqual(rounding.idealWidthPx, idealWidth) || !approximatelyEqual(rounding.idealHeightPx, idealHeight) ||
        rounding.requestedWidthPx !== Math.ceil(idealWidth) || rounding.requestedHeightPx !== Math.ceil(idealHeight)) {
      issues.push('rendering.rounding must describe the requested displayed-page raster dimensions');
    }
  }
  if (rounding.actualWidthPx !== sourceRaster?.widthPx || rounding.actualHeightPx !== sourceRaster?.heightPx) {
    issues.push('rendering.rounding actual dimensions must match sourceRaster');
  }
  if (isFiniteNumber(rounding.actualWidthPx) && isFiniteNumber(rounding.idealWidthPx) && !approximatelyEqual(rounding.widthDeltaPx, rounding.actualWidthPx - rounding.idealWidthPx)) {
    issues.push('rendering.rounding.widthDeltaPx is inconsistent');
  }
  if (isFiniteNumber(rounding.actualHeightPx) && isFiniteNumber(rounding.idealHeightPx) && !approximatelyEqual(rounding.heightDeltaPx, rounding.actualHeightPx - rounding.idealHeightPx)) {
    issues.push('rendering.rounding.heightDeltaPx is inconsistent');
  }
  if (Number.isSafeInteger(rounding.actualWidthPx) && Number.isSafeInteger(rounding.requestedWidthPx) &&
      Number.isSafeInteger(rounding.actualHeightPx) && Number.isSafeInteger(rounding.requestedHeightPx) &&
      rounding.pdfiumAdjusted !== (rounding.actualWidthPx !== rounding.requestedWidthPx || rounding.actualHeightPx !== rounding.requestedHeightPx)) {
    issues.push('rendering.rounding.pdfiumAdjusted is inconsistent');
  }
}

function validatePreprocessing(value, sourceRaster, issues) {
  if (!isObject(value)) { issues.push('preprocessing must be an object'); return; }
  requireExactKeys(value, new Set(['orientation', 'deskew', 'output']), 'preprocessing', issues);
  if (!isObject(value.orientation)) issues.push('preprocessing.orientation must be an object');
  else {
    requireExactKeys(value.orientation, new Set(['degreesClockwise', 'provenance']), 'preprocessing.orientation', issues);
    if (!ROTATIONS.includes(value.orientation.degreesClockwise)) issues.push('preprocessing.orientation.degreesClockwise is unsupported');
    if (!['none', 'requested', 'engine-detected'].includes(value.orientation.provenance)) issues.push('preprocessing.orientation.provenance is unsupported');
    if (value.orientation.provenance === 'none' && value.orientation.degreesClockwise !== 0) issues.push('preprocessing.orientation provenance none requires zero degrees');
  }
  if (!isObject(value.deskew)) issues.push('preprocessing.deskew must be an object');
  else {
    requireExactKeys(value.deskew, new Set(['degreesClockwise', 'provenance']), 'preprocessing.deskew', issues);
    if (!isFiniteNumber(value.deskew.degreesClockwise) || Math.abs(value.deskew.degreesClockwise) >= 45) issues.push('preprocessing.deskew.degreesClockwise must be finite and between -45 and 45');
    if (!['none', 'requested', 'engine-detected'].includes(value.deskew.provenance)) issues.push('preprocessing.deskew.provenance is unsupported');
    if (value.deskew.provenance === 'none' && value.deskew.degreesClockwise !== 0) issues.push('preprocessing.deskew provenance none requires zero degrees');
  }
  if (!isObject(value.output)) issues.push('preprocessing.output must be an object');
  else {
    requireExactKeys(value.output, new Set(['coordinateSpace', 'widthPx', 'heightPx']), 'preprocessing.output', issues);
    if (value.output.coordinateSpace !== OCR_PREPROCESSED_RASTER_SPACE) issues.push(`preprocessing.output.coordinateSpace must be ${OCR_PREPROCESSED_RASTER_SPACE}`);
    validatePositiveInteger(value.output.widthPx, 'preprocessing.output.widthPx', issues);
    validatePositiveInteger(value.output.heightPx, 'preprocessing.output.heightPx', issues);
  }
  if (ROTATIONS.includes(value.orientation?.degreesClockwise) && sourceRaster) {
    const oriented = orientationDimensions(sourceRaster.widthPx, sourceRaster.heightPx, value.orientation.degreesClockwise);
    if (value.deskew?.degreesClockwise === 0 && (value.output?.widthPx !== oriented.width || value.output?.heightPx !== oriented.height)) {
      issues.push('preprocessing.output dimensions must match orientation dimensions when deskew is zero');
    }
  }
}

function validateEngineGeometry(value, issues) {
  if (!isObject(value)) { issues.push('engineGeometry must be an object'); return; }
  requireExactKeys(value, new Set(['coordinateSpace', 'width', 'height']), 'engineGeometry', issues);
  if (value.coordinateSpace !== OCR_ENGINE_GEOMETRY_SPACE) issues.push(`engineGeometry.coordinateSpace must be ${OCR_ENGINE_GEOMETRY_SPACE}`);
  validatePositiveNumber(value.width, 'engineGeometry.width', issues);
  validatePositiveNumber(value.height, 'engineGeometry.height', issues);
}

function validateProvenance(value, path, expectedSource, issues) {
  if (!isObject(value)) { issues.push(`${path} must be an object`); return; }
  requireExactKeys(value, new Set(['source', 'detail']), path, issues);
  if (!PROVENANCE_SOURCES.includes(value.source)) issues.push(`${path}.source is unsupported`);
  if (expectedSource && value.source !== expectedSource) issues.push(`${path}.source must be ${expectedSource}`);
  validateString(value.detail, `${path}.detail`, issues, { nonEmpty: true, maxCodeUnits: 256 });
}

function expectedOperationMatrices(value) {
  const orientation = value.preprocessing.orientation.degreesClockwise;
  const oriented = orientationDimensions(value.sourceRaster.widthPx, value.sourceRaster.heightPx, orientation);
  return [
    rawPdfToDisplayMatrix(value.boxes.cropBox, value.userUnit.value, value.rotations.totalDegreesClockwise),
    [value.sourceRaster.widthPx / value.displayedPage.width, 0, 0, 0, value.sourceRaster.heightPx / value.displayedPage.height, 0, 0, 0, 1],
    orientationMatrix(value.sourceRaster.widthPx, value.sourceRaster.heightPx, orientation),
    deskewMatrix(oriented.width, oriented.height, value.preprocessing.output.widthPx, value.preprocessing.output.heightPx, value.preprocessing.deskew.degreesClockwise),
    [value.engineGeometry.width / value.preprocessing.output.widthPx, 0, 0, 0, value.engineGeometry.height / value.preprocessing.output.heightPx, 0, 0, 0, 1],
  ];
}

function validateTransformChain(value, geometry, issues) {
  if (!isObject(value)) { issues.push('transformChain must be an object'); return; }
  requireExactKeys(value, new Set(['contract', 'schemaVersion', 'operations']), 'transformChain', issues);
  if (value.contract !== OCR_TRANSFORM_CHAIN_CONTRACT) issues.push(`transformChain.contract must be ${OCR_TRANSFORM_CHAIN_CONTRACT}`);
  if (value.schemaVersion !== OCR_TRANSFORM_CHAIN_SCHEMA_VERSION) issues.push(`transformChain.schemaVersion must be ${OCR_TRANSFORM_CHAIN_SCHEMA_VERSION}`);
  if (!Array.isArray(value.operations) || value.operations.length !== OPERATION_SPECS.length) {
    issues.push(`transformChain.operations must contain ${OPERATION_SPECS.length} operations`);
    return;
  }
  let expectedMatrices = null;
  try { expectedMatrices = expectedOperationMatrices(geometry); } catch { /* Field validators report incomplete metadata. */ }
  const expectedProvenance = ['pdf-page-dictionary', 'pdfium-render', 'ocr-preprocessing', 'ocr-preprocessing', 'ocr-engine-adapter'];
  value.operations.forEach((operation, index) => {
    const path = `transformChain.operations[${index}]`;
    const spec = OPERATION_SPECS[index];
    if (!isObject(operation)) { issues.push(`${path} must be an object`); return; }
    requireExactKeys(operation, new Set(['id', 'kind', 'fromSpace', 'toSpace', 'matrix', 'inverseMatrix', 'provenance']), path, issues);
    for (const key of ['id', 'kind', 'fromSpace', 'toSpace']) if (operation[key] !== spec[key]) issues.push(`${path}.${key} must be ${spec[key]}`);
    validateHomographyInverse(operation.matrix, operation.inverseMatrix, path, issues);
    validateProvenance(operation.provenance, `${path}.provenance`, expectedProvenance[index], issues);
    if (expectedMatrices && !matricesEqual(operation.matrix, expectedMatrices[index])) issues.push(`${path}.matrix is inconsistent with authoritative page geometry metadata`);
  });
}

function validatePdfiumBoundaryBox(value, path, issues) {
  if (!isObject(value)) { issues.push(`${path} must be an object`); return; }
  requireExactKeys(value, new Set(['coordinateSpace', 'unit', 'origin', 'x', 'y', 'width', 'height']), path, issues);
  if (value.coordinateSpace !== OCR_PDF_USER_SPACE) issues.push(`${path}.coordinateSpace must be ${OCR_PDF_USER_SPACE}`);
  if (value.unit !== 'pdf-user-unit') issues.push(`${path}.unit must be pdf-user-unit`);
  if (value.origin !== 'pdf-user-space-zero') issues.push(`${path}.origin must be pdf-user-space-zero`);
  for (const key of ['x', 'y']) if (!isFiniteNumber(value[key])) issues.push(`${path}.${key} must be a finite number`);
  validatePositiveNumber(value.width, `${path}.width`, issues);
  validatePositiveNumber(value.height, `${path}.height`, issues);
}

export function validatePdfiumPageGeometryV1(value, {
  maxSerializedBytes = OCR_CONTRACT_LIMITS.maxPageGeometryBytes,
} = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['PDFium page geometry must be an object'] };
  validateJsonValue(value, 'pdfiumPageGeometry', issues);
  if (!validateSerializedSize(value, 'pdfiumPageGeometry', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'pageIndex', 'mediaBox', 'cropBox', 'bleedBox', 'trimBox', 'artBox',
    'userUnit', 'userUnitProvenance', 'intrinsicRotationDegreesClockwise',
    'applicationRotationDegreesClockwise', 'totalRotationDegreesClockwise', 'displayedPage', 'raster',
  ]), 'pdfiumPageGeometry', issues);
  if (value.contract !== PDFIUM_PAGE_GEOMETRY_CONTRACT) issues.push(`contract must be ${PDFIUM_PAGE_GEOMETRY_CONTRACT}`);
  if (value.schemaVersion !== PDFIUM_PAGE_GEOMETRY_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateNonNegativeInteger(value.pageIndex, 'pageIndex', issues);
  validatePdfiumBoundaryBox(value.mediaBox, 'mediaBox', issues);
  validatePdfiumBoundaryBox(value.cropBox, 'cropBox', issues);
  for (const name of ['bleedBox', 'trimBox', 'artBox']) {
    if (value[name] !== null) validatePdfiumBoundaryBox(value[name], name, issues);
  }
  for (const name of ['cropBox', 'bleedBox', 'trimBox', 'artBox']) {
    if (value[name] !== null && !containsBox(value.mediaBox, value[name])) issues.push(`${name} must be contained by mediaBox`);
  }
  validatePositiveNumber(value.userUnit, 'userUnit', issues);
  if (isFiniteNumber(value.userUnit) && value.userUnit > 75_000) issues.push('userUnit must not exceed 75000');
  if (!['pdf-page-dictionary', 'pdf-default'].includes(value.userUnitProvenance)) issues.push('userUnitProvenance is unsupported');
  for (const key of [
    'intrinsicRotationDegreesClockwise', 'applicationRotationDegreesClockwise', 'totalRotationDegreesClockwise',
  ]) {
    if (!ROTATIONS.includes(value[key])) issues.push(`${key} is unsupported`);
  }
  if (ROTATIONS.includes(value.intrinsicRotationDegreesClockwise) &&
      ROTATIONS.includes(value.applicationRotationDegreesClockwise) &&
      value.totalRotationDegreesClockwise !== clockwiseRotation(
        value.intrinsicRotationDegreesClockwise + value.applicationRotationDegreesClockwise,
      )) issues.push('totalRotationDegreesClockwise is inconsistent');
  if (!isObject(value.displayedPage)) issues.push('displayedPage must be an object');
  else {
    requireExactKeys(value.displayedPage, new Set(['coordinateSpace', 'unit', 'origin', 'width', 'height']), 'displayedPage', issues);
    if (value.displayedPage.coordinateSpace !== OCR_CROPPED_DISPLAY_PDF_SPACE) issues.push(`displayedPage.coordinateSpace must be ${OCR_CROPPED_DISPLAY_PDF_SPACE}`);
    if (value.displayedPage.unit !== 'pdf-point') issues.push('displayedPage.unit must be pdf-point');
    if (value.displayedPage.origin !== 'displayed-crop-top-left') issues.push('displayedPage.origin must be displayed-crop-top-left');
    validatePositiveNumber(value.displayedPage.width, 'displayedPage.width', issues);
    validatePositiveNumber(value.displayedPage.height, 'displayedPage.height', issues);
    if (isObject(value.cropBox) && isFiniteNumber(value.userUnit) && ROTATIONS.includes(value.totalRotationDegreesClockwise)) {
      const expected = displayDimensions(value.cropBox, value.userUnit, value.totalRotationDegreesClockwise);
      if (!approximatelyEqual(value.displayedPage.width, expected.width) ||
          !approximatelyEqual(value.displayedPage.height, expected.height)) {
        issues.push('displayedPage dimensions are inconsistent with CropBox, UserUnit, and rotations');
      }
    }
  }
  const raster = value.raster;
  if (!isObject(raster)) issues.push('raster must be an object');
  else {
    requireExactKeys(raster, new Set([
      'coordinateSpace', 'unit', 'origin', 'requestedDpi', 'requestedScale', 'idealWidthPx',
      'idealHeightPx', 'requestedWidthPx', 'requestedHeightPx', 'actualWidthPx', 'actualHeightPx',
      'widthDeltaPx', 'heightDeltaPx', 'pdfiumAdjusted', 'roundingMethod',
      'annotationsExcluded', 'formsExcluded',
    ]), 'raster', issues);
    if (raster.coordinateSpace !== OCR_SOURCE_RASTER_SPACE) issues.push(`raster.coordinateSpace must be ${OCR_SOURCE_RASTER_SPACE}`);
    if (raster.unit !== 'pixel') issues.push('raster.unit must be pixel');
    if (raster.origin !== 'top-left-pixel-edge') issues.push('raster.origin must be top-left-pixel-edge');
    for (const key of ['requestedDpi', 'requestedScale', 'idealWidthPx', 'idealHeightPx']) validatePositiveNumber(raster[key], `raster.${key}`, issues);
    for (const key of ['requestedWidthPx', 'requestedHeightPx', 'actualWidthPx', 'actualHeightPx']) validatePositiveInteger(raster[key], `raster.${key}`, issues);
    for (const key of ['widthDeltaPx', 'heightDeltaPx']) if (!isFiniteNumber(raster[key])) issues.push(`raster.${key} must be finite`);
    if (typeof raster.pdfiumAdjusted !== 'boolean') issues.push('raster.pdfiumAdjusted must be boolean');
    if (raster.roundingMethod !== 'ceil-target-then-pdfium') issues.push('raster.roundingMethod is unsupported');
    for (const key of ['annotationsExcluded', 'formsExcluded']) if (typeof raster[key] !== 'boolean') issues.push(`raster.${key} must be boolean`);
    if (isFiniteNumber(raster.requestedDpi) && isFiniteNumber(raster.requestedScale) &&
        !approximatelyEqual(raster.requestedDpi, raster.requestedScale * 72)) issues.push('raster requested DPI and scale are inconsistent');
    if (isFiniteNumber(value.displayedPage?.width) && isFiniteNumber(value.displayedPage?.height) && isFiniteNumber(raster.requestedScale)) {
      const idealWidth = value.displayedPage.width * raster.requestedScale;
      const idealHeight = value.displayedPage.height * raster.requestedScale;
      if (!approximatelyEqual(raster.idealWidthPx, idealWidth) || !approximatelyEqual(raster.idealHeightPx, idealHeight) ||
          raster.requestedWidthPx !== Math.ceil(idealWidth) || raster.requestedHeightPx !== Math.ceil(idealHeight)) {
        issues.push('raster ideal and requested dimensions are inconsistent');
      }
    }
    if (isFiniteNumber(raster.actualWidthPx) && isFiniteNumber(raster.idealWidthPx) &&
        !approximatelyEqual(raster.widthDeltaPx, raster.actualWidthPx - raster.idealWidthPx)) issues.push('raster.widthDeltaPx is inconsistent');
    if (isFiniteNumber(raster.actualHeightPx) && isFiniteNumber(raster.idealHeightPx) &&
        !approximatelyEqual(raster.heightDeltaPx, raster.actualHeightPx - raster.idealHeightPx)) issues.push('raster.heightDeltaPx is inconsistent');
    if (Number.isSafeInteger(raster.actualWidthPx) && Number.isSafeInteger(raster.requestedWidthPx) &&
        Number.isSafeInteger(raster.actualHeightPx) && Number.isSafeInteger(raster.requestedHeightPx) &&
        raster.pdfiumAdjusted !== (raster.actualWidthPx !== raster.requestedWidthPx || raster.actualHeightPx !== raster.requestedHeightPx)) {
      issues.push('raster.pdfiumAdjusted is inconsistent');
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertPdfiumPageGeometryV1(value, options) {
  const validation = validatePdfiumPageGeometryV1(value, options);
  if (!validation.ok) throw new OcrContractError(PDFIUM_PAGE_GEOMETRY_CONTRACT, validation.issues);
  return value;
}

export function validateOcrPageGeometryV1(value, { maxSerializedBytes = OCR_CONTRACT_LIMITS.maxPageGeometryBytes } = {}) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['page geometry must be an object'] };
  validateJsonValue(value, 'pageGeometry', issues);
  if (!validateSerializedSize(value, 'pageGeometry', issues, maxSerializedBytes)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'geometryId', 'document', 'page', 'coordinateSpaces', 'boxes', 'userUnit',
    'rotations', 'displayedPage', 'sourceRaster', 'rendering', 'preprocessing', 'engineGeometry', 'transformChain',
  ]), 'pageGeometry', issues);
  if (value.contract !== OCR_PAGE_GEOMETRY_CONTRACT) issues.push(`contract must be ${OCR_PAGE_GEOMETRY_CONTRACT}`);
  if (value.schemaVersion !== OCR_PAGE_GEOMETRY_SCHEMA_VERSION) issues.push(`schemaVersion must be ${OCR_PAGE_GEOMETRY_SCHEMA_VERSION}`);
  validateIdentifier(value.geometryId, 'geometryId', issues);
  validateDocument(value.document, issues);
  validatePage(value.page, value.document?.pageCount, issues);
  validateCoordinateSpaces(value.coordinateSpaces, issues);
  validateBoxes(value.boxes, issues);
  validateUserUnit(value.userUnit, issues);
  validateRotations(value.rotations, issues);
  validateDisplayedPage(value.displayedPage, value.boxes?.cropBox, value.userUnit, value.rotations, issues);
  validateRasterIdentity(value.sourceRaster, 'sourceRaster', issues, { coordinateSpace: OCR_SOURCE_RASTER_SPACE });
  validateRendering(value.rendering, value.displayedPage, value.sourceRaster, issues);
  if (isFiniteNumber(value.sourceRaster?.dpi) && isFiniteNumber(value.rendering?.requested?.dpi) && !approximatelyEqual(value.sourceRaster.dpi, value.rendering.requested.dpi)) {
    issues.push('sourceRaster.dpi must match rendering.requested.dpi');
  }
  validatePreprocessing(value.preprocessing, value.sourceRaster, issues);
  validateEngineGeometry(value.engineGeometry, issues);
  validateTransformChain(value.transformChain, value, issues);
  return { ok: issues.length === 0, issues };
}

export function assertOcrPageGeometryV1(value, options) {
  const validation = validateOcrPageGeometryV1(value, options);
  if (!validation.ok) throw new OcrContractError(OCR_PAGE_GEOMETRY_CONTRACT, validation.issues);
  return value;
}

export function toValidatedOcrPageGeometryV1Json(value, options) {
  assertOcrPageGeometryV1(value, options);
  const parsed = JSON.parse(JSON.stringify(value));
  assertOcrPageGeometryV1(parsed, options);
  return parsed;
}

export function createOcrPageGeometryV1({
  geometryId, document, page, boxes, userUnit, userUnitProvenance = 'pdf-page-dictionary',
  intrinsicRotationDegrees = 0, applicationRotationDegrees = 0, requestedDpi,
  requestedScale = requestedDpi / 72, sourceRaster, annotationsExcluded, formsExcluded,
  preprocessing = {}, engineGeometry = {},
}) {
  const totalRotation = clockwiseRotation(intrinsicRotationDegrees + applicationRotationDegrees);
  const displayedPage = { coordinateSpace: OCR_CROPPED_DISPLAY_PDF_SPACE, ...displayDimensions(boxes.cropBox, userUnit, totalRotation) };
  const orientationDegrees = preprocessing.orientationDegrees ?? 0;
  const oriented = orientationDimensions(sourceRaster.widthPx, sourceRaster.heightPx, orientationDegrees);
  const outputWidthPx = preprocessing.outputWidthPx ?? oriented.width;
  const outputHeightPx = preprocessing.outputHeightPx ?? oriented.height;
  const deskewDegrees = preprocessing.deskewDegrees ?? 0;
  const idealWidthPx = displayedPage.width * requestedScale;
  const idealHeightPx = displayedPage.height * requestedScale;
  const requestedWidthPx = Math.ceil(idealWidthPx);
  const requestedHeightPx = Math.ceil(idealHeightPx);
  const geometry = {
    contract: OCR_PAGE_GEOMETRY_CONTRACT,
    schemaVersion: OCR_PAGE_GEOMETRY_SCHEMA_VERSION,
    geometryId,
    document: clone(document),
    page: clone(page),
    coordinateSpaces: OCR_PAGE_GEOMETRY_SPACES.map(clone),
    boxes: clone(boxes),
    userUnit: { value: userUnit, pointsPerUnit: userUnit, provenance: userUnitProvenance },
    rotations: {
      intrinsicDegreesClockwise: intrinsicRotationDegrees,
      applicationDegreesClockwise: applicationRotationDegrees,
      totalDegreesClockwise: totalRotation,
    },
    displayedPage,
    sourceRaster: clone(sourceRaster),
    rendering: {
      requested: { dpi: requestedDpi, scale: requestedScale },
      exclusions: { annotationsExcluded, formsExcluded },
      rounding: {
        idealWidthPx, idealHeightPx, requestedWidthPx, requestedHeightPx,
        actualWidthPx: sourceRaster.widthPx,
        actualHeightPx: sourceRaster.heightPx,
        widthDeltaPx: sourceRaster.widthPx - idealWidthPx,
        heightDeltaPx: sourceRaster.heightPx - idealHeightPx,
        pdfiumAdjusted: sourceRaster.widthPx !== requestedWidthPx || sourceRaster.heightPx !== requestedHeightPx,
        method: 'ceil-target-then-pdfium',
      },
    },
    preprocessing: {
      orientation: {
        degreesClockwise: orientationDegrees,
        provenance: preprocessing.orientationProvenance ?? (orientationDegrees === 0 ? 'none' : 'requested'),
      },
      deskew: {
        degreesClockwise: deskewDegrees,
        provenance: preprocessing.deskewProvenance ?? (deskewDegrees === 0 ? 'none' : 'requested'),
      },
      output: { coordinateSpace: OCR_PREPROCESSED_RASTER_SPACE, widthPx: outputWidthPx, heightPx: outputHeightPx },
    },
    engineGeometry: {
      coordinateSpace: OCR_ENGINE_GEOMETRY_SPACE,
      width: engineGeometry.width ?? outputWidthPx,
      height: engineGeometry.height ?? outputHeightPx,
    },
    transformChain: null,
  };
  const matrices = expectedOperationMatrices(geometry);
  const provenance = [
    { source: 'pdf-page-dictionary', detail: 'CropBox, UserUnit, and combined display rotation' },
    { source: 'pdfium-render', detail: 'Actual PDFium raster width and height' },
    { source: 'ocr-preprocessing', detail: 'Orientation preprocessing' },
    { source: 'ocr-preprocessing', detail: 'Deskew around source and output centers' },
    { source: 'ocr-engine-adapter', detail: 'Engine input geometry normalization' },
  ];
  geometry.transformChain = {
    contract: OCR_TRANSFORM_CHAIN_CONTRACT,
    schemaVersion: OCR_TRANSFORM_CHAIN_SCHEMA_VERSION,
    operations: OPERATION_SPECS.map((spec, index) => createHomographyOperation({ ...spec, matrix: matrices[index], provenance: provenance[index] })),
  };
  return toValidatedOcrPageGeometryV1Json(geometry);
}

export function createOcrPageGeometryFromPdfiumV1(boundary, {
  geometryId,
  document,
  page,
  sourceRasterId,
  sourceRasterFingerprint,
  preprocessing = {},
  engineGeometry = {},
} = {}) {
  assertPdfiumPageGeometryV1(boundary);
  if (page?.index !== boundary.pageIndex) {
    throw new OcrContractError(OCR_PAGE_GEOMETRY_CONTRACT, [
      'page.index must match the PDFium page geometry response',
    ]);
  }
  const toContractBox = (value) => value === null ? null : ({
    coordinateSpace: value.coordinateSpace,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  });
  return createOcrPageGeometryV1({
    geometryId,
    document,
    page,
    boxes: {
      mediaBox: toContractBox(boundary.mediaBox),
      cropBox: toContractBox(boundary.cropBox),
      bleedBox: toContractBox(boundary.bleedBox),
      trimBox: toContractBox(boundary.trimBox),
      artBox: toContractBox(boundary.artBox),
    },
    userUnit: boundary.userUnit,
    userUnitProvenance: boundary.userUnitProvenance,
    intrinsicRotationDegrees: boundary.intrinsicRotationDegreesClockwise,
    applicationRotationDegrees: boundary.applicationRotationDegreesClockwise,
    requestedDpi: boundary.raster.requestedDpi,
    requestedScale: boundary.raster.requestedScale,
    sourceRaster: {
      id: sourceRasterId,
      fingerprint: clone(sourceRasterFingerprint),
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      widthPx: boundary.raster.actualWidthPx,
      heightPx: boundary.raster.actualHeightPx,
      dpi: boundary.raster.requestedDpi,
    },
    annotationsExcluded: boundary.raster.annotationsExcluded,
    formsExcluded: boundary.raster.formsExcluded,
    preprocessing,
    engineGeometry,
  });
}

export function mapOcrPageGeometryPoint(geometry, point, fromSpace, toSpace) {
  assertOcrPageGeometryV1(geometry);
  return mapPointBetweenSpaces(geometry.transformChain, point, fromSpace, toSpace);
}

export function mapOcrPageGeometryPolygon(geometry, polygon, toSpace) {
  assertOcrPageGeometryV1(geometry);
  return mapPolygonBetweenSpaces(geometry.transformChain, polygon, toSpace);
}

export function mapOcrPageGeometryBaseline(geometry, baseline, toSpace) {
  assertOcrPageGeometryV1(geometry);
  return mapBaselineBetweenSpaces(geometry.transformChain, baseline, toSpace);
}
