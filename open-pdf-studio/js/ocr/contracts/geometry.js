import {
  isFiniteNumber,
  isObject,
  requireExactKeys,
  validateAffineInverse,
  validateBoundingBox,
  validateFingerprint,
  validateIdentifier,
  validatePolygon,
  validatePolyline,
  validatePositiveInteger,
  validatePositiveNumber,
} from './validation.js';

export const OCR_PDF_USER_SPACE = 'pdf-default-user-space';
export const OCR_RAW_PDF_USER_SPACE = OCR_PDF_USER_SPACE;
export const OCR_CROPPED_DISPLAY_PDF_SPACE = 'cropped-display-pdf-points';
export const OCR_SOURCE_RASTER_SPACE = 'source-raster-pixels';
export const OCR_RENDERED_RASTER_SPACE = OCR_SOURCE_RASTER_SPACE;
export const OCR_ORIENTATION_ADJUSTED_SPACE = 'orientation-adjusted-ocr-pixels';
export const OCR_PREPROCESSED_RASTER_SPACE = 'preprocessed-raster-pixels';
export const OCR_PREPROCESSED_OCR_SPACE = OCR_PREPROCESSED_RASTER_SPACE;
export const OCR_ENGINE_GEOMETRY_SPACE = 'ocr-engine-geometry';
export const OCR_COORDINATE_SPACES = Object.freeze([
  OCR_PDF_USER_SPACE,
  OCR_CROPPED_DISPLAY_PDF_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  OCR_ORIENTATION_ADJUSTED_SPACE,
  OCR_PREPROCESSED_RASTER_SPACE,
  OCR_ENGINE_GEOMETRY_SPACE,
]);

export const OCR_HOMOGRAPHY_IDENTITY = Object.freeze([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
]);

const MAX_HOMOGRAPHY_CONDITION = 1e16;
const HOMOGRAPHY_EPSILON = 1e-10;

export function multiplyHomographies(left, right) {
  if (!Array.isArray(left) || left.length !== 9 || !Array.isArray(right) || right.length !== 9) {
    throw new TypeError('homography multiplication needs two 3x3 matrices');
  }
  const result = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let inner = 0; inner < 3; inner += 1) {
        result[row * 3 + column] += left[row * 3 + inner] * right[inner * 3 + column];
      }
    }
  }
  return result;
}

export function invertHomography(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(isFiniteNumber)) {
    throw new TypeError('homography must contain nine finite numbers');
  }
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const cofactor00 = e * i - f * h;
  const cofactor01 = f * g - d * i;
  const cofactor02 = d * h - e * g;
  const determinant = a * cofactor00 + b * cofactor01 + c * cofactor02;
  const scale = Math.max(...matrix.map(Math.abs), 1);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= HOMOGRAPHY_EPSILON * scale) {
    throw new RangeError('homography is singular or numerically unstable');
  }
  const inverse = [
    cofactor00, c * h - b * i, b * f - c * e,
    cofactor01, a * i - c * g, c * d - a * f,
    cofactor02, b * g - a * h, a * e - b * d,
  ].map((entry) => entry / determinant);
  const infinityNorm = (value) => Math.max(
    Math.abs(value[0]) + Math.abs(value[1]) + Math.abs(value[2]),
    Math.abs(value[3]) + Math.abs(value[4]) + Math.abs(value[5]),
    Math.abs(value[6]) + Math.abs(value[7]) + Math.abs(value[8]),
  );
  const condition = infinityNorm(matrix) * infinityNorm(inverse);
  if (!Number.isFinite(condition) || condition > MAX_HOMOGRAPHY_CONDITION) {
    throw new RangeError('homography is numerically unstable');
  }
  return inverse;
}

export function applyHomography(matrix, point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(isFiniteNumber)) {
    throw new TypeError('homography point must contain two finite numbers');
  }
  const [x, y] = point;
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= HOMOGRAPHY_EPSILON) {
    throw new RangeError('homography maps the point to infinity');
  }
  const mapped = [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
  ];
  if (!mapped.every(isFiniteNumber)) throw new RangeError('homography produced a non-finite point');
  return mapped;
}

export function validateHomographyInverse(matrix, inverseMatrix, path, issues) {
  let calculated;
  try {
    calculated = invertHomography(matrix);
    invertHomography(inverseMatrix);
  } catch (error) {
    issues.push(`${path} must contain invertible, numerically stable 3x3 matrices: ${error.message}`);
    return;
  }
  const tolerance = 1e-7;
  if (calculated.some((entry, index) => Math.abs(entry - inverseMatrix[index]) >
      tolerance * Math.max(1, Math.abs(entry), Math.abs(inverseMatrix[index])))) {
    issues.push(`${path}.inverseMatrix must invert ${path}.matrix`);
    return;
  }
  for (const product of [
    multiplyHomographies(matrix, inverseMatrix),
    multiplyHomographies(inverseMatrix, matrix),
  ]) {
    if (product.some((entry, index) => Math.abs(entry - OCR_HOMOGRAPHY_IDENTITY[index]) > tolerance)) {
      issues.push(`${path}.inverseMatrix must invert ${path}.matrix`);
      return;
    }
  }
}

export function createHomographyOperation({
  id,
  kind,
  fromSpace,
  toSpace,
  matrix,
  provenance,
}) {
  return {
    id,
    kind,
    fromSpace,
    toSpace,
    matrix: [...matrix],
    inverseMatrix: invertHomography(matrix),
    provenance: structuredClone(provenance),
  };
}

function chainOperations(transformChain) {
  if (!isObject(transformChain) || !Array.isArray(transformChain.operations)) {
    throw new TypeError('transform chain must contain operations');
  }
  return transformChain.operations;
}

export function composeTransformBetweenSpaces(transformChain, fromSpace, toSpace) {
  if (fromSpace === toSpace) return [...OCR_HOMOGRAPHY_IDENTITY];
  const operations = chainOperations(transformChain);
  const adjacency = new Map();
  const connect = (from, to, matrix) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, matrix });
  };
  for (const operation of operations) {
    connect(operation.fromSpace, operation.toSpace, operation.matrix);
    connect(operation.toSpace, operation.fromSpace, operation.inverseMatrix);
  }
  const queue = [{ space: fromSpace, matrix: [...OCR_HOMOGRAPHY_IDENTITY] }];
  const visited = new Set([fromSpace]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of adjacency.get(current.space) ?? []) {
      if (visited.has(edge.to)) continue;
      const matrix = multiplyHomographies(edge.matrix, current.matrix);
      if (edge.to === toSpace) return matrix;
      visited.add(edge.to);
      queue.push({ space: edge.to, matrix });
    }
  }
  throw new RangeError(`transform chain does not connect ${fromSpace} to ${toSpace}`);
}

export function mapPointBetweenSpaces(transformChain, point, fromSpace, toSpace) {
  return applyHomography(composeTransformBetweenSpaces(transformChain, fromSpace, toSpace), point);
}

export function mapPolygonBetweenSpaces(transformChain, polygon, toSpace) {
  if (!isObject(polygon) || !Array.isArray(polygon.points)) {
    throw new TypeError('polygon must identify its coordinate space and points');
  }
  return {
    coordinateSpace: toSpace,
    points: polygon.points.map((point) => mapPointBetweenSpaces(
      transformChain,
      point,
      polygon.coordinateSpace,
      toSpace,
    )),
  };
}

export function mapBaselineBetweenSpaces(transformChain, baseline, toSpace) {
  if (!isObject(baseline)) throw new TypeError('baseline must be an object');
  if (baseline.status === 'unavailable') {
    return { ...structuredClone(baseline), coordinateSpace: toSpace };
  }
  if (baseline.status !== 'provided' || !Array.isArray(baseline.points)) {
    throw new TypeError('baseline must be provided or unavailable');
  }
  return {
    ...structuredClone(baseline),
    coordinateSpace: toSpace,
    points: baseline.points.map((point) => mapPointBetweenSpaces(
      transformChain,
      point,
      baseline.coordinateSpace,
      toSpace,
    )),
  };
}

export function deriveAxisAlignedBounds(polygon) {
  if (!isObject(polygon) || !Array.isArray(polygon.points) || polygon.points.length === 0) {
    throw new TypeError('polygon must contain points');
  }
  const xs = polygon.points.map((point) => point[0]);
  const ys = polygon.points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    coordinateSpace: polygon.coordinateSpace,
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

export function validateCoordinateSpace(value, path, issues, allowed = OCR_COORDINATE_SPACES) {
  if (!allowed.includes(value)) issues.push(`${path} is unsupported`);
}

export function validateRasterIdentity(value, path, issues, {
  coordinateSpace,
  requireDpi = true,
} = {}) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const keys = ['id', 'fingerprint', 'coordinateSpace', 'widthPx', 'heightPx'];
  if (requireDpi) keys.push('dpi');
  requireExactKeys(value, new Set(keys), path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  validateFingerprint(value.fingerprint, `${path}.fingerprint`, issues);
  if (coordinateSpace !== undefined && value.coordinateSpace !== coordinateSpace) {
    issues.push(`${path}.coordinateSpace must be ${coordinateSpace}`);
  } else {
    validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues);
  }
  validatePositiveInteger(value.widthPx, `${path}.widthPx`, issues);
  validatePositiveInteger(value.heightPx, `${path}.heightPx`, issues);
  if (requireDpi) validatePositiveNumber(value.dpi, `${path}.dpi`, issues);
}

function rasterBounds(space, rasters) {
  const raster = rasters?.[space];
  return raster ? { width: raster.widthPx, height: raster.heightPx } : {};
}

export function validateCoordinatePolygon(value, path, issues, {
  allowedSpaces = [OCR_SOURCE_RASTER_SPACE, OCR_PREPROCESSED_RASTER_SPACE],
  rasters = null,
} = {}) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['coordinateSpace', 'points']), path, issues);
  validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues, allowedSpaces);
  if (rasters !== null && !rasters[value.coordinateSpace]) {
    issues.push(`${path}.coordinateSpace does not identify a declared raster`);
  }
  validatePolygon(value.points, `${path}.points`, issues, rasterBounds(value.coordinateSpace, rasters));
}

export function validateCoordinateBoundingBox(value, path, issues, {
  allowedSpaces = [OCR_SOURCE_RASTER_SPACE, OCR_PREPROCESSED_RASTER_SPACE],
  rasters = null,
} = {}) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['coordinateSpace', 'x', 'y', 'width', 'height']), path, issues);
  validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues, allowedSpaces);
  if (rasters !== null && !rasters[value.coordinateSpace]) {
    issues.push(`${path}.coordinateSpace does not identify a declared raster`);
  }
  validateBoundingBox({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  }, path, issues, rasterBounds(value.coordinateSpace, rasters));
}

export function validateBaseline(value, path, issues, {
  allowedSpaces = [OCR_SOURCE_RASTER_SPACE, OCR_PREPROCESSED_RASTER_SPACE],
  rasters = null,
  allowedProvenance = ['engine'],
} = {}) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  if (value.status === 'provided') {
    requireExactKeys(value, new Set(['status', 'coordinateSpace', 'provenance', 'points']), path, issues);
    validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues, allowedSpaces);
    if (rasters !== null && !rasters[value.coordinateSpace]) {
      issues.push(`${path}.coordinateSpace does not identify a declared raster`);
    }
    if (!allowedProvenance.includes(value.provenance)) issues.push(`${path}.provenance is unsupported`);
    validatePolyline(value.points, `${path}.points`, issues, rasterBounds(value.coordinateSpace, rasters));
    return;
  }
  if (value.status === 'unavailable') {
    requireExactKeys(value, new Set(['status', 'coordinateSpace', 'reason']), path, issues);
    validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues, allowedSpaces);
    if (rasters !== null && !rasters[value.coordinateSpace]) {
      issues.push(`${path}.coordinateSpace does not identify a declared raster`);
    }
    if (!['engine-did-not-provide', 'not-applicable'].includes(value.reason)) {
      issues.push(`${path}.reason is unsupported`);
    }
    return;
  }
  issues.push(`${path}.status is unsupported`);
}

export function validateAffineTransform(value, path, issues, {
  fromSpace = null,
  toSpace = null,
} = {}) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['fromSpace', 'toSpace', 'matrix', 'inverseMatrix']), path, issues);
  validateCoordinateSpace(value.fromSpace, `${path}.fromSpace`, issues);
  validateCoordinateSpace(value.toSpace, `${path}.toSpace`, issues);
  if (fromSpace !== null && value.fromSpace !== fromSpace) issues.push(`${path}.fromSpace must be ${fromSpace}`);
  if (toSpace !== null && value.toSpace !== toSpace) issues.push(`${path}.toSpace must be ${toSpace}`);
  if (value.fromSpace === value.toSpace) issues.push(`${path} must connect distinct coordinate spaces`);
  validateAffineInverse(value.matrix, value.inverseMatrix, path, issues);
}

export function validatePdfBox(value, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(value, new Set(['coordinateSpace', 'x', 'y', 'width', 'height']), path, issues);
  if (value.coordinateSpace !== OCR_PDF_USER_SPACE) {
    issues.push(`${path}.coordinateSpace must be ${OCR_PDF_USER_SPACE}`);
  }
  for (const key of ['x', 'y']) {
    if (!isFiniteNumber(value[key])) issues.push(`${path}.${key} must be a finite number`);
  }
  validatePositiveNumber(value.width, `${path}.width`, issues);
  validatePositiveNumber(value.height, `${path}.height`, issues);
}
