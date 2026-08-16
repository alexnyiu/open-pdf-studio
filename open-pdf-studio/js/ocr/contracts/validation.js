export const OCR_CONTRACT_LIMITS = Object.freeze({
  maxResultBytes: 16 * 1024 * 1024,
  maxJobBytes: 4 * 1024 * 1024,
  maxBlocksPerPage: 10_000,
  maxLinesPerPage: 100_000,
  maxWordsPerPage: 500_000,
  maxAlternativesPerItem: 16,
  maxPolygonPoints: 64,
  maxWarningsPerPage: 256,
  maxUnsupportedReasonsPerPage: 256,
  maxCorrectionsPerPage: 100_000,
  maxEditRegionsPerPage: 100_000,
  maxPagesPerJob: 100_000,
  maxTextCodeUnits: 4 * 1024 * 1024,
});

export class OcrContractError extends TypeError {
  constructor(contract, issues) {
    super(`${contract} validation failed: ${issues.join('; ')}`);
    this.name = 'OcrContractError';
    this.contract = contract;
    this.issues = issues;
  }
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidUnicode(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateString(value, path, issues, {
  nonEmpty = false,
  maxCodeUnits = OCR_CONTRACT_LIMITS.maxTextCodeUnits,
} = {}) {
  if (typeof value !== 'string') {
    issues.push(`${path} must be a string`);
    return false;
  }
  if (!isValidUnicode(value)) {
    issues.push(`${path} must contain valid Unicode`);
    return false;
  }
  if (nonEmpty && value.length === 0) issues.push(`${path} must be non-empty`);
  if (value.length > maxCodeUnits) issues.push(`${path} exceeds ${maxCodeUnits} UTF-16 code units`);
  return true;
}

export function validateIdentifier(value, path, issues) {
  const valid = validateString(value, path, issues, { nonEmpty: true, maxCodeUnits: 256 });
  if (valid && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    issues.push(`${path} contains unsupported identifier characters`);
  }
}

export function validateSemver(value, path, issues) {
  const valid = validateString(value, path, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (valid && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    issues.push(`${path} must be semver`);
  }
}

export function validateLanguageTag(value, path, issues) {
  const valid = validateString(value, path, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (valid && !/^(?:[A-Za-z]{2,8}|und)(?:-[A-Za-z0-9]{1,8})*$/.test(value)) {
    issues.push(`${path} must be a BCP 47 language tag`);
  }
}

export function validateIsoTimestamp(value, path, issues) {
  const valid = validateString(value, path, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (valid && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)))) {
    issues.push(`${path} must be an ISO 8601 UTC timestamp`);
  }
}

export function requireExactKeys(value, allowed, path, issues) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

export function validateConfidence(value, path, issues) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    issues.push(`${path} must be a finite number between 0 and 1`);
  }
}

export function validatePositiveNumber(value, path, issues) {
  if (!isFiniteNumber(value) || value <= 0) issues.push(`${path} must be a positive finite number`);
}

export function validateNonNegativeNumber(value, path, issues) {
  if (!isFiniteNumber(value) || value < 0) issues.push(`${path} must be a non-negative finite number`);
}

export function validateSerializedSize(value, path, issues, maxBytes) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      issues.push(`${path} must be JSON serializable`);
      return false;
    }
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > maxBytes) {
      issues.push(`${path} exceeds ${maxBytes} serialized UTF-8 bytes`);
      return false;
    }
  } catch {
    issues.push(`${path} must be acyclic JSON data`);
    return false;
  }
  return true;
}

function samePoint(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, point) {
  const epsilon = 1e-9;
  return Math.abs(orientation(a, b, point)) <= epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
      ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function validatePolygon(polygon, path, issues, {
  width = null,
  height = null,
  minPoints = 4,
  maxPoints = OCR_CONTRACT_LIMITS.maxPolygonPoints,
} = {}) {
  if (!Array.isArray(polygon)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (polygon.length < minPoints || polygon.length > maxPoints) {
    issues.push(`${path} must contain between ${minPoints} and ${maxPoints} points`);
    return;
  }
  const validPoints = [];
  polygon.forEach((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(isFiniteNumber)) {
      issues.push(`${path}[${index}] must be a finite [x, y] point`);
      return;
    }
    if (point[0] < 0 || point[1] < 0) issues.push(`${path}[${index}] must be non-negative`);
    if (isFiniteNumber(width) && point[0] > width + 0.5) issues.push(`${path}[${index}] exceeds page width`);
    if (isFiniteNumber(height) && point[1] > height + 0.5) issues.push(`${path}[${index}] exceeds page height`);
    validPoints.push(point);
  });
  if (validPoints.length !== polygon.length) return;

  const points = polygon.length > minPoints && samePoint(polygon[0], polygon.at(-1))
    ? polygon.slice(0, -1)
    : polygon;
  if (points.length < minPoints) {
    issues.push(`${path} must contain at least ${minPoints} distinct boundary points`);
    return;
  }
  for (let index = 0; index < points.length; index += 1) {
    if (samePoint(points[index], points[(index + 1) % points.length])) {
      issues.push(`${path} contains a zero-length edge`);
      return;
    }
  }

  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    doubledArea += points[index][0] * next[1] - next[0] * points[index][1];
  }
  if (!Number.isFinite(doubledArea) || Math.abs(doubledArea) <= 1e-9) {
    issues.push(`${path} must enclose a non-zero finite area`);
    return;
  }

  for (let left = 0; left < points.length; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(points[left], points[leftNext], points[right], points[rightNext])) {
        issues.push(`${path} must not self-intersect`);
        return;
      }
    }
  }
}

export function validateBoundingBox(box, path, issues, { width = null, height = null } = {}) {
  if (!isObject(box)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(box, new Set(['x', 'y', 'width', 'height']), path, issues);
  for (const key of ['x', 'y']) validateNonNegativeNumber(box[key], `${path}.${key}`, issues);
  for (const key of ['width', 'height']) validatePositiveNumber(box[key], `${path}.${key}`, issues);
  if (isFiniteNumber(width) && isFiniteNumber(box.x) && isFiniteNumber(box.width) && box.x + box.width > width + 0.5) {
    issues.push(`${path} exceeds page width`);
  }
  if (isFiniteNumber(height) && isFiniteNumber(box.y) && isFiniteNumber(box.height) && box.y + box.height > height + 0.5) {
    issues.push(`${path} exceeds page height`);
  }
}
