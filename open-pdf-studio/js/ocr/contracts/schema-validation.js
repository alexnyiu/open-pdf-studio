import { validateOcrPageGeometryV1 } from './page-geometry.v1.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validUnicode(value) {
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

function jsonSafetyIssues(value, path = '$', { allowArrayBuffers = false } = {}) {
  const issues = [];
  const ancestors = new Set();
  let nodes = 0;
  function visit(current, currentPath, depth) {
    nodes += 1;
    if (nodes > 1_000_000) {
      issues.push(`${path} exceeds 1000000 JSON values`);
      return;
    }
    if (depth > 64) {
      issues.push(`${currentPath} exceeds maximum JSON depth 64`);
      return;
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) issues.push(`${currentPath} must be a finite JSON number`);
      return;
    }
    if (typeof current === 'string') {
      if (!validUnicode(current)) issues.push(`${currentPath} must contain valid Unicode`);
      return;
    }
    if (typeof current !== 'object') {
      issues.push(`${currentPath} contains a non-JSON ${typeof current} value`);
      return;
    }
    if (current instanceof ArrayBuffer) {
      if (!allowArrayBuffers) issues.push(`${currentPath} must be JSON data`);
      return;
    }
    if (!Array.isArray(current) && !isPlainObject(current)) {
      issues.push(`${currentPath} must be a plain JSON object`);
      return;
    }
    if (ancestors.has(current)) {
      issues.push(`${currentPath} must not contain a cyclic reference`);
      return;
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`, depth + 1));
    } else {
      for (const [key, entry] of Object.entries(current)) {
        if (!validUnicode(key)) issues.push(`${currentPath} contains an invalid Unicode property name`);
        visit(entry, `${currentPath}.${key}`, depth + 1);
      }
    }
    ancestors.delete(current);
  }
  visit(value, path, 0);
  return issues;
}

function equalJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => equalJson(entry, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]));
}

function compareSemver(left, right) {
  const split = (value) => {
    const [core, prerelease = ''] = value.split('-', 2);
    return { numbers: core.split('.').map(Number), prerelease };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function valueMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, point) {
  const epsilon = 1e-9;
  return Math.abs(orientation(a, b, point)) <= epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;
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

function polygonIssues(points, path) {
  const issues = [];
  if (!Array.isArray(points) || points.length < 4 || points.length > 64) return issues;
  if (!points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return issues;
  const boundary = points.length > 4 && equalJson(points[0], points.at(-1)) ? points.slice(0, -1) : points;
  let area = 0;
  for (let index = 0; index < boundary.length; index += 1) {
    const current = boundary[index];
    const next = boundary[(index + 1) % boundary.length];
    if (equalJson(current, next)) issues.push(`${path} contains a zero-length edge`);
    area += current[0] * next[1] - next[0] * current[1];
  }
  if (!Number.isFinite(area) || Math.abs(area) <= 1e-9) issues.push(`${path} must enclose a non-zero finite area`);
  for (let left = 0; left < boundary.length; left += 1) {
    const leftNext = (left + 1) % boundary.length;
    for (let right = left + 1; right < boundary.length; right += 1) {
      const rightNext = (right + 1) % boundary.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(boundary[left], boundary[leftNext], boundary[right], boundary[rightNext])) {
        issues.push(`${path} must not self-intersect`);
        return issues;
      }
    }
  }
  return issues;
}

function polylineIssues(points, path) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 64) return [];
  if (!points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return [];
  if (!points.some((point, index) => index > 0 && !equalJson(point, points[index - 1]))) {
    return [`${path} must contain a non-zero-length segment`];
  }
  return [];
}

function affineProduct(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function affineIssues(value, path) {
  const matrix = value?.matrix;
  const inverse = value?.inverseMatrix;
  if (![matrix, inverse].every((entry) => Array.isArray(entry) && entry.length === 6 && entry.every(Number.isFinite))) return [];
  const determinants = [matrix, inverse].map((entry) => entry[0] * entry[3] - entry[1] * entry[2]);
  if (determinants.some((entry) => Math.abs(entry) <= 1e-12)) return [`${path} must contain invertible matrices`];
  const identity = [1, 0, 0, 1, 0, 0];
  for (const product of [affineProduct(matrix, inverse), affineProduct(inverse, matrix)]) {
    if (product.some((entry, index) => Math.abs(entry - identity[index]) > 1e-6)) {
      return [`${path}.inverseMatrix must invert ${path}.matrix`];
    }
  }
  return [];
}

function homographyProduct(left, right) {
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

function homographyIssues(value, path) {
  const matrix = value?.matrix;
  const inverse = value?.inverseMatrix;
  if (![matrix, inverse].every((entry) => Array.isArray(entry) && entry.length === 9 && entry.every(Number.isFinite))) return [];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const product of [homographyProduct(matrix, inverse), homographyProduct(inverse, matrix)]) {
    if (product.some((entry, index) => Math.abs(entry - identity[index]) > 1e-7)) {
      return [`${path}.inverseMatrix must invert ${path}.matrix`];
    }
  }
  return [];
}

function resolvePointer(root, pointer) {
  if (!pointer || pointer === '#') return root;
  return pointer.replace(/^#\//, '').split('/').reduce((current, part) =>
    current?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function registryLookup(ref, registry) {
  for (const [key, schema] of registry.entries()) {
    if (key === ref || key.endsWith(`/${ref}`) || schema.$id === ref || schema.$id?.endsWith(`/${ref}`)) return schema;
  }
  return null;
}

function resolveRef(ref, root, registry) {
  if (ref.startsWith('#')) return { schema: resolvePointer(root, ref), root };
  const [file, fragment = ''] = ref.split('#', 2);
  const external = registryLookup(file, registry);
  if (!external) return { schema: null, root };
  return { schema: fragment ? resolvePointer(external, `#${fragment}`) : external, root: external };
}

function boundsForSpace(value) {
  const map = new Map();
  if (value?.sourceRaster) map.set(value.sourceRaster.coordinateSpace, value.sourceRaster);
  if (value?.preprocessing?.outputRaster) {
    map.set(value.preprocessing.outputRaster.coordinateSpace, value.preprocessing.outputRaster);
  }
  return map;
}

function checkCoordinateGeometry(geometry, path, bounds, issues, { polyline = false } = {}) {
  if (!isPlainObject(geometry)) return;
  const raster = bounds.get(geometry.coordinateSpace);
  if (!raster) {
    issues.push(`${path}.coordinateSpace does not identify a declared raster`);
    return;
  }
  const points = geometry.points;
  if (polyline && !Array.isArray(points)) return;
  for (const [index, point] of (points ?? []).entries()) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) continue;
    if (point[0] < 0 || point[1] < 0 || point[0] > raster.widthPx + 0.5 || point[1] > raster.heightPx + 0.5) {
      issues.push(`${path}.points[${index}] exceeds declared raster bounds`);
    }
  }
}

function checkCoordinateBox(box, path, bounds, issues) {
  if (!isPlainObject(box)) return;
  const raster = bounds.get(box.coordinateSpace);
  if (!raster) {
    issues.push(`${path}.coordinateSpace does not identify a declared raster`);
    return;
  }
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  if (box.x + box.width > raster.widthPx + 0.5 || box.y + box.height > raster.heightPx + 0.5) {
    issues.push(`${path} exceeds declared raster bounds`);
  }
}

function semanticEngine(value, path) {
  const issues = [];
  const caps = value?.capabilities;
  if (!isPlainObject(caps)) return issues;
  for (const key of ['textDetection', 'textRecognition', 'lineResults', 'linePolygons']) {
    if (caps[key] !== true) issues.push(`${path}.capabilities.${key} must be true`);
  }
  if (caps.wordPolygons === true && caps.wordResults !== true) issues.push(`${path}.capabilities.wordPolygons requires wordResults`);
  if (value.engineId === 'paddleocr-pp-ocrv6-small-onnx-wasm') {
    for (const key of ['lineBaselines', 'wordResults', 'wordPolygons', 'alternatives', 'languageDetection',
      'writingDirectionDetection', 'preprocessingMetadata', 'nativePdfWriting']) {
      if (caps[key] !== false) issues.push(`${path}.capabilities.${key} must be false for the current Paddle adapter`);
    }
  }
  return issues;
}

function semanticResult(value, path) {
  const issues = [];
  if (Number.isSafeInteger(value?.page?.index) && Number.isSafeInteger(value?.document?.pageCount) &&
      value.page.index >= value.document.pageCount) issues.push(`${path}.page.index is outside document.pageCount`);
  const bounds = boundsForSpace(value);
  const ids = new Set();
  let words = 0;
  let wordPolygons = false;
  let alternatives = false;
  let languages = value?.detectedLanguages?.length > 0;
  let directions = false;
  let baselines = false;
  for (const [lineIndex, line] of (value?.lines ?? []).entries()) {
    if (ids.has(line?.id)) issues.push(`${path}.lines[${lineIndex}].id must be unique`);
    ids.add(line?.id);
    checkCoordinateGeometry(line?.polygon, `${path}.lines[${lineIndex}].polygon`, bounds, issues);
    if (line?.boundingBox) checkCoordinateBox(line.boundingBox, `${path}.lines[${lineIndex}].boundingBox`, bounds, issues);
    if (line?.baseline?.status === 'provided') {
      baselines = true;
      checkCoordinateGeometry(line.baseline, `${path}.lines[${lineIndex}].baseline`, bounds, issues, { polyline: true });
    } else if (line?.baseline) {
      checkCoordinateGeometry({ ...line.baseline, points: [] }, `${path}.lines[${lineIndex}].baseline`, bounds, issues);
    }
    alternatives ||= (line?.alternatives?.length ?? 0) > 0;
    languages ||= line?.detectedLanguage !== undefined;
    directions ||= line?.detectedWritingDirection !== undefined;
    for (const [wordIndex, word] of (line?.words ?? []).entries()) {
      words += 1;
      if (ids.has(word?.id)) issues.push(`${path}.lines[${lineIndex}].words[${wordIndex}].id must be unique`);
      ids.add(word?.id);
      if (word?.polygon) {
        wordPolygons = true;
        checkCoordinateGeometry(word.polygon, `${path}.lines[${lineIndex}].words[${wordIndex}].polygon`, bounds, issues);
      }
      if (word?.boundingBox) {
        checkCoordinateBox(word.boundingBox, `${path}.lines[${lineIndex}].words[${wordIndex}].boundingBox`, bounds, issues);
      }
      alternatives ||= (word?.alternatives?.length ?? 0) > 0;
      languages ||= word?.detectedLanguage !== undefined;
      directions ||= word?.detectedWritingDirection !== undefined;
    }
  }
  const combinedLineText = (value?.lines ?? []).map((line) => line?.text).filter(Boolean).join('\n');
  if (value?.text !== combinedLineText) issues.push(`${path}.text does not match its line text`);
  if (words > 500_000) issues.push(`${path} exceeds 500000 words`);
  const languageTags = new Set();
  for (const [index, language] of (value?.detectedLanguages ?? []).entries()) {
    if (languageTags.has(language?.tag)) issues.push(`${path}.detectedLanguages[${index}].tag must be unique`);
    languageTags.add(language?.tag);
  }
  for (const [index, reason] of (value?.unsupportedContentReasons ?? []).entries()) {
    if (reason?.polygon) {
      checkCoordinateGeometry(reason.polygon, `${path}.unsupportedContentReasons[${index}].polygon`, bounds, issues);
    }
  }
  const caps = value?.engine?.capabilities;
  if ((value?.lines?.length ?? 0) > 0 && caps?.lineResults !== true) issues.push(`${path} has lines without lineResults capability`);
  if (words > 0 && caps?.wordResults !== true) issues.push(`${path} has words without wordResults capability`);
  if (wordPolygons && caps?.wordPolygons !== true) issues.push(`${path} has word polygons without wordPolygons capability`);
  if (alternatives && caps?.alternatives !== true) issues.push(`${path} has alternatives without alternatives capability`);
  if (languages && caps?.languageDetection !== true) issues.push(`${path} has detected languages without languageDetection capability`);
  if (directions && caps?.writingDirectionDetection !== true) issues.push(`${path} has writing directions without writingDirectionDetection capability`);
  if (baselines && caps?.lineBaselines !== true) issues.push(`${path} has engine baselines without lineBaselines capability`);
  if (value?.preprocessing?.status === 'applied') {
    if (!value.preprocessing.outputRaster || !value.preprocessing.transform) issues.push(`${path}.preprocessing is incomplete`);
    if (!(value.preprocessing.operations ?? []).some((operation) => operation?.applied === true)) {
      issues.push(`${path}.preprocessing has no applied operation`);
    }
    if (caps?.preprocessingMetadata !== true) issues.push(`${path} has preprocessing data without preprocessingMetadata capability`);
  } else if ((value?.preprocessing?.operations?.length ?? 0) > 0 || value?.preprocessing?.outputRaster || value?.preprocessing?.transform) {
    issues.push(`${path}.preprocessing data contradicts its status`);
  }
  if (value?.page?.status === 'unsupported' && (value?.unsupportedContentReasons?.length ?? 0) === 0) {
    issues.push(`${path}.unsupported page requires a reason`);
  }
  if (['failed', 'cancelled'].includes(value?.page?.status) && ((value?.lines?.length ?? 0) > 0 || value?.text !== '')) {
    issues.push(`${path}.${value.page.status} result contains recognition data`);
  }
  for (const [warningIndex, warning] of (value?.warnings ?? []).entries()) {
    for (const id of warning?.entityIds ?? []) {
      if (!ids.has(id)) issues.push(`${path}.warnings[${warningIndex}] references an unknown entity`);
    }
  }
  return issues;
}

function semanticJob(value, path) {
  const issues = [];
  if (Number.isSafeInteger(value?.page?.index) && Number.isSafeInteger(value?.document?.pageCount) &&
      value.page.index >= value.document.pageCount) issues.push(`${path}.page.index is outside document.pageCount`);
  const options = value?.recognitionOptions;
  const raster = value?.page?.sourceRaster;
  if (options?.rasterDpi !== raster?.dpi) issues.push(`${path}.recognitionOptions.rasterDpi must match source raster`);
  if (Number.isSafeInteger(options?.maximumPixels) && Number.isSafeInteger(raster?.widthPx) &&
      Number.isSafeInteger(raster?.heightPx) && raster.widthPx * raster.heightPx > options.maximumPixels) {
    issues.push(`${path}.source raster exceeds maximumPixels`);
  }
  if (Number.isSafeInteger(options?.maximumSide) && Math.max(raster?.widthPx ?? 0, raster?.heightPx ?? 0) > options.maximumSide) {
    issues.push(`${path}.source raster exceeds maximumSide`);
  }
  if (value?.documentPolicy?.skipMeaningfulExistingText === true && value?.documentPolicy?.forceRerun === true) {
    issues.push(`${path}.document policy is contradictory`);
  }
  const policy = options?.languagePolicy;
  if (policy?.mode === 'automatic' && ((policy.languages?.length ?? 0) > 0 || (policy.scripts?.length ?? 0) > 0)) {
    issues.push(`${path}.automatic language policy contains selectors`);
  }
  if (['prefer', 'restrict'].includes(policy?.mode) && (policy.languages?.length ?? 0) === 0 && (policy.scripts?.length ?? 0) === 0) {
    issues.push(`${path}.${policy.mode} language policy has no selector`);
  }
  const orientation = options?.orientation;
  if (orientation?.mode === 'fixed' && ![0, 90, 180, 270].includes(orientation.degrees)) {
    issues.push(`${path}.recognitionOptions.orientation has invalid fixed degrees`);
  }
  if (orientation?.mode !== 'fixed' && orientation?.degrees !== null) {
    issues.push(`${path}.recognitionOptions.orientation.degrees is only valid in fixed mode`);
  }
  const preprocessing = options?.preprocessing;
  if (preprocessing?.mode === 'none' && (preprocessing.operations?.length ?? 0) > 0) {
    issues.push(`${path}.recognitionOptions.preprocessing none mode contains operations`);
  }
  if (preprocessing?.mode === 'custom' && (preprocessing.operations?.length ?? 0) === 0) {
    issues.push(`${path}.recognitionOptions.preprocessing custom mode has no operations`);
  }
  return issues;
}

function semanticProgress(value, path) {
  const issues = [];
  if (['completed', 'partial', 'unsupported'].includes(value?.stage) && value?.fraction !== 1) {
    issues.push(`${path}.${value.stage} must have fraction 1`);
  }
  if (value?.stage === 'failed' && value?.error === null) issues.push(`${path}.failed requires error`);
  if (value?.stage !== 'failed' && value?.error !== null) issues.push(`${path}.error is only valid for failed stage`);
  if (!['completed', 'partial', 'unsupported', 'failed', 'cancelled'].includes(value?.stage) && value?.fraction === 1) {
    issues.push(`${path}.non-terminal progress must be less than 1`);
  }
  return issues;
}

function semanticWorkerMessage(value, path) {
  const issues = [];
  if (value?.type === 'recognize') {
    if (value.requestId !== value.job?.requestId) {
      issues.push(`${path}.requestId does not match the job`);
    }
    const width = value.image?.width;
    const height = value.image?.height;
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > 100_000_000) {
      issues.push(`${path}.image exceeds 100000000 pixels`);
    }
    if (value.image?.rgba instanceof ArrayBuffer && Number.isSafeInteger(pixels) &&
        value.image.rgba.byteLength !== pixels * 4) {
      issues.push(`${path}.image.rgba byte length does not match its dimensions`);
    }
    if (width !== value.job?.page?.sourceRaster?.widthPx ||
        height !== value.job?.page?.sourceRaster?.heightPx) {
      issues.push(`${path}.image dimensions do not match the job source raster`);
    }
  }
  if (value?.type === 'result' && value.requestId !== value.result?.requestId) {
    issues.push(`${path}.requestId does not match the result`);
  }
  return issues;
}

function semanticNativeJob(value, path) {
  const issues = [];
  const raster = value?.raster;
  const sourceRaster = value?.job?.page?.sourceRaster;
  const limits = value?.limits;
  const expectedRowBytes = raster?.widthPx * 4;
  const expectedByteLength = expectedRowBytes * raster?.heightPx;
  if (!Number.isSafeInteger(expectedByteLength) || raster?.rowBytes !== expectedRowBytes ||
      raster?.byteLength !== expectedByteLength) {
    issues.push(`${path}.raster dimensions and byte lengths are inconsistent`);
  }
  if (raster?.widthPx !== sourceRaster?.widthPx || raster?.heightPx !== sourceRaster?.heightPx) {
    issues.push(`${path}.raster dimensions do not match the job source raster`);
  }
  if (!equalJson(value?.preprocessingRequest, value?.job?.recognitionOptions?.preprocessing)) {
    issues.push(`${path}.preprocessingRequest does not match the job`);
  }
  if (limits?.timeoutMs !== value?.job?.recognitionOptions?.timeoutMs) {
    issues.push(`${path}.limits.timeoutMs does not match the job`);
  }
  const expectedLimits = {
    maxWidthPx: Math.min(value?.job?.recognitionOptions?.maximumSide, 8192),
    maxHeightPx: Math.min(value?.job?.recognitionOptions?.maximumSide, 8192),
    maxPixels: Math.min(value?.job?.recognitionOptions?.maximumPixels, 16_000_000),
    maxMetadataBytes: 1024 * 1024,
    maxRasterBytes: (64 * 1024 * 1024) - 32,
    maxResultBytes: 16 * 1024 * 1024,
  };
  for (const [key, expected] of Object.entries(expectedLimits)) {
    if (limits?.[key] !== expected) issues.push(`${path}.limits.${key} does not match the production job`);
  }
  const pixels = raster?.widthPx * raster?.heightPx;
  if (raster?.widthPx > limits?.maxWidthPx || raster?.heightPx > limits?.maxHeightPx ||
      !Number.isSafeInteger(pixels) || pixels > limits?.maxPixels ||
      raster?.byteLength > limits?.maxRasterBytes) {
    issues.push(`${path}.raster exceeds the native job limits`);
  }
  return issues;
}

function semanticState(value, path) {
  const issues = [];
  const pageIds = new Set();
  const pageIndexes = new Set();
  const entityIds = new Set();
  for (const [index, page] of (value?.pages ?? []).entries()) {
    if (pageIds.has(page?.id)) issues.push(`${path}.pages[${index}].id must be unique`);
    if (pageIndexes.has(page?.index)) issues.push(`${path}.pages[${index}].index must be unique`);
    pageIds.add(page?.id);
    pageIndexes.add(page?.index);
    if (Number.isSafeInteger(page?.index) && Number.isSafeInteger(value?.document?.pageCount) && page.index >= value.document.pageCount) {
      issues.push(`${path}.pages[${index}].index is outside document.pageCount`);
    }
    if (['applying', 'applied'].includes(page?.applicationStatus) && page?.resultRef === null) {
      issues.push(`${path}.pages[${index}] needs resultRef for application state`);
    }
    if (['in-review', 'accepted', 'rejected'].includes(page?.reviewStatus) && page?.resultRef === null) {
      issues.push(`${path}.pages[${index}] needs resultRef for review state`);
    }
    for (const group of ['corrections', 'estimatedBaselines', 'visibleEditRegions']) {
      for (const item of page?.[group] ?? []) {
        if (entityIds.has(item?.id)) issues.push(`${path}.pages[${index}].${group} IDs must be unique`);
        entityIds.add(item?.id);
      }
    }
    for (const [correctionIndex, correction] of (page?.corrections ?? []).entries()) {
      if (Number.isFinite(Date.parse(correction?.createdAt)) && Number.isFinite(Date.parse(correction?.updatedAt)) &&
          Date.parse(correction.updatedAt) < Date.parse(correction.createdAt)) {
        issues.push(`${path}.pages[${index}].corrections[${correctionIndex}].updatedAt precedes createdAt`);
      }
    }
    for (const [baselineIndex, baseline] of (page?.estimatedBaselines ?? []).entries()) {
      if (Number.isFinite(Date.parse(baseline?.createdAt)) && Number.isFinite(Date.parse(baseline?.updatedAt)) &&
          Date.parse(baseline.updatedAt) < Date.parse(baseline.createdAt)) {
        issues.push(`${path}.pages[${index}].estimatedBaselines[${baselineIndex}].updatedAt precedes createdAt`);
      }
    }
  }
  return issues;
}

function containsBox(outer, inner) {
  if (!outer || !inner) return true;
  return inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-6;
}

function semanticGeometry(value, path) {
  return validateOcrPageGeometryV1(value).issues.map((issue) => `${path}: ${issue}`);
}

function semanticModelPack(value, path) {
  const issues = [];
  if (value?.recognitionSupport?.languages?.includes('und')) issues.push(`${path}.und is not a supported-language selector`);
  if (value?.distribution?.bundled === false && value?.distribution?.downloadable === false) {
    issues.push(`${path}.distribution has no permitted source`);
  }
  const minimum = value?.applicationCompatibility?.minimumVersion;
  const maximum = value?.applicationCompatibility?.maximumVersionExclusive;
  if (typeof minimum === 'string' && typeof maximum === 'string' && compareSemver(minimum, maximum) >= 0) {
    issues.push(`${path}.applicationCompatibility maximum must exceed minimum`);
  }
  const files = new Set();
  for (const [name, asset] of Object.entries(value?.assets ?? {})) {
    const file = asset?.file;
    if (typeof file === 'string' && (file.startsWith('/') || file.includes('\\') ||
        file.split('/').includes('..'))) {
      issues.push(`${path}.assets.${name}.file is not a safe relative path`);
    }
    if (files.has(file)) issues.push(`${path}.assets.${name}.file must be unique`);
    files.add(file);
  }
  return issues;
}

const SEMANTICS = {
  'engine-v2': semanticEngine,
  'result-v2': semanticResult,
  'job-v1': semanticJob,
  'progress-v1': semanticProgress,
  'worker-message-v1': semanticWorkerMessage,
  'native-job-v1': semanticNativeJob,
  'document-state-v1': semanticState,
  'page-geometry-v1': semanticGeometry,
  'model-pack-v1': semanticModelPack,
};

function walk(value, schema, path, root, registry, issues) {
  if (schema === true) return;
  if (schema === false) {
    issues.push(`${path} is forbidden by schema`);
    return;
  }
  if (!isPlainObject(schema)) {
    issues.push(`${path} references an invalid schema node`);
    return;
  }
  if (value instanceof ArrayBuffer) {
    if (schema['x-ocrArrayBuffer'] !== true) issues.push(`${path} must not contain binary data`);
    return;
  }
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root, registry);
    if (!resolved.schema) issues.push(`${path} has unresolved schema reference ${schema.$ref}`);
    else walk(value, resolved.schema, path, resolved.root, registry, issues);
    return;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => {
      const branch = [];
      walk(value, candidate, path, root, registry, branch);
      return branch.length === 0;
    });
    if (matches.length === 0) issues.push(`${path} does not match any allowed schema`);
    return;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      const branch = [];
      walk(value, candidate, path, root, registry, branch);
      return branch.length === 0;
    });
    if (matches.length !== 1) issues.push(`${path} must match exactly one allowed schema`);
    if (schema['x-ocrSemantic'] && SEMANTICS[schema['x-ocrSemantic']]) {
      issues.push(...SEMANTICS[schema['x-ocrSemantic']](value, path));
    }
    if (schema['x-ocrJsonValue']) issues.push(...jsonSafetyIssues(value, path));
    return;
  }
  for (const candidate of schema.allOf ?? []) walk(value, candidate, path, root, registry, issues);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => valueMatchesType(value, type))) {
      issues.push(`${path} must be ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && !equalJson(value, schema.const)) issues.push(`${path} must equal its schema constant`);
  if (schema.enum && !schema.enum.some((entry) => equalJson(entry, value))) issues.push(`${path} is not in its schema enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) issues.push(`${path} does not match its schema pattern`);
    if (schema.format === 'date-time' && (!Number.isFinite(Date.parse(value)) || !value.endsWith('Z'))) {
      issues.push(`${path} must be an ISO UTC timestamp`);
    }
    if (schema.format === 'uri') {
      try { new URL(value); } catch { issues.push(`${path} must be a URI`); }
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} exceeds maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push(`${path} is below exclusive minimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push(`${path} exceeds exclusive maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} has too many items`);
    if (schema.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((entry) => equalJson(entry, value[index]))) issues.push(`${path}[${index}] must be unique`);
      }
    }
    if (schema.items) value.forEach((entry, index) => walk(entry, schema.items, `${path}[${index}]`, root, registry, issues));
    if (schema['x-ocrPolygon']) issues.push(...polygonIssues(value, path));
    if (schema['x-ocrPolyline']) issues.push(...polylineIssues(value, path));
    if (schema['x-uniqueBy']) {
      const seen = new Set();
      value.forEach((entry, index) => {
        const key = entry?.[schema['x-uniqueBy']];
        if (seen.has(key)) issues.push(`${path}[${index}].${schema['x-uniqueBy']} must be unique`);
        seen.add(key);
      });
    }
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) issues.push(`${path}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) walk(entry, schema.properties[key], `${path}.${key}`, root, registry, issues);
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
      else if (isPlainObject(schema.additionalProperties)) {
        walk(entry, schema.additionalProperties, `${path}.${key}`, root, registry, issues);
      }
    }
    if (schema['x-ocrAffine']) issues.push(...affineIssues(value, path));
    if (schema['x-ocrHomography']) issues.push(...homographyIssues(value, path));
  }
  if (schema['x-ocrSemantic'] && SEMANTICS[schema['x-ocrSemantic']]) {
    issues.push(...SEMANTICS[schema['x-ocrSemantic']](value, path));
  }
  if (schema['x-ocrJsonValue']) issues.push(...jsonSafetyIssues(value, path));
}

export function validateAgainstJsonSchema(value, schema, {
  schemas = [],
} = {}) {
  const issues = jsonSafetyIssues(value, '$', {
    allowArrayBuffers: schema['x-ocrStructuredClone'] === true,
  });
  if (issues.length > 0) return { ok: false, issues };
  if (schema['x-maxUtf8Bytes'] !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > schema['x-maxUtf8Bytes']) issues.push(`$ exceeds ${schema['x-maxUtf8Bytes']} serialized UTF-8 bytes`);
  }
  const registry = new Map();
  for (const entry of [schema, ...schemas]) {
    if (entry?.$id) registry.set(entry.$id, entry);
  }
  walk(value, schema, '$', schema, registry, issues);
  return { ok: issues.length === 0, issues };
}
