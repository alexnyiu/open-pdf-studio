import { OCR_CONTRACT_LIMITS } from '../contracts/validation.js';

export const PADDLE_DB_POSTPROCESS = Object.freeze({
  binaryThreshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.5,
  longitudinalUnclipRatio: 12,
  minimumComponentPixels: 6,
  minimumSidePixels: 3,
  maximumDetectorCandidates: 1_000,
  maximumLayoutBlocks: 256,
  maximumContourPointsPerCandidate: 16_384,
  maximumContourPointsPerPage: 262_144,
  estimatedResultBytesPerLine: 4_096,
  reservedResultBytes: 64 * 1_024,
  duplicateIouThreshold: 0.85,
  recognitionConfidenceThreshold: 0.6,
  maximumSupportedLineAngleDegrees: 15,
  maximumCompactRegionAreaRatio: 0.01,
  minimumQualifiedTextDensity: 1.5,
});

const EPSILON = 1e-9;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function signedArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

export function polygonArea(points) {
  return Array.isArray(points) && points.length >= 3 ? Math.abs(signedArea(points)) : 0;
}

function cross(origin, left, right) {
  return (left[0] - origin[0]) * (right[1] - origin[1]) -
    (left[1] - origin[1]) * (right[0] - origin[0]);
}

function convexHull(points) {
  const unique = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (unique.length <= 2) return unique;
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= EPSILON) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= EPSILON) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function normalizeLineAngleRadians(value) {
  let angle = value;
  while (angle >= Math.PI / 2) angle -= Math.PI;
  while (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

function normalizedAngleDifference(left, right) {
  return Math.abs(normalizeLineAngleRadians(left - right));
}

function rectangleFromExtents(angle, minimumAlong, maximumAlong, minimumAcross, maximumAcross) {
  const along = [Math.cos(angle), Math.sin(angle)];
  const across = [-along[1], along[0]];
  return [
    [minimumAlong * along[0] + minimumAcross * across[0], minimumAlong * along[1] + minimumAcross * across[1]],
    [maximumAlong * along[0] + minimumAcross * across[0], maximumAlong * along[1] + minimumAcross * across[1]],
    [maximumAlong * along[0] + maximumAcross * across[0], maximumAlong * along[1] + maximumAcross * across[1]],
    [minimumAlong * along[0] + maximumAcross * across[0], minimumAlong * along[1] + maximumAcross * across[1]],
  ];
}

function rectangleGeometry(points) {
  const width = distance(points[0], points[1]);
  const height = distance(points[1], points[2]);
  const center = points.reduce(
    (total, point) => [total[0] + point[0] / points.length, total[1] + point[1] / points.length],
    [0, 0],
  );
  return {
    points,
    width,
    height,
    center,
    angle: normalizeLineAngleRadians(Math.atan2(
      points[1][1] - points[0][1],
      points[1][0] - points[0][0],
    )),
  };
}

export function minimumAreaRectangle(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best = null;
  for (let index = 0; index < hull.length; index += 1) {
    const start = hull[index];
    const end = hull[(index + 1) % hull.length];
    const angle = normalizeLineAngleRadians(Math.atan2(end[1] - start[1], end[0] - start[0]));
    const along = [Math.cos(angle), Math.sin(angle)];
    const across = [-along[1], along[0]];
    let minimumAlong = Number.POSITIVE_INFINITY;
    let maximumAlong = Number.NEGATIVE_INFINITY;
    let minimumAcross = Number.POSITIVE_INFINITY;
    let maximumAcross = Number.NEGATIVE_INFINITY;
    for (const point of hull) {
      const projectedAlong = point[0] * along[0] + point[1] * along[1];
      const projectedAcross = point[0] * across[0] + point[1] * across[1];
      minimumAlong = Math.min(minimumAlong, projectedAlong);
      maximumAlong = Math.max(maximumAlong, projectedAlong);
      minimumAcross = Math.min(minimumAcross, projectedAcross);
      maximumAcross = Math.max(maximumAcross, projectedAcross);
    }
    const candidate = rectangleGeometry(rectangleFromExtents(
      angle,
      minimumAlong,
      maximumAlong,
      minimumAcross,
      maximumAcross,
    ));
    const area = candidate.width * candidate.height;
    if (!best || area < best.area - EPSILON ||
        (Math.abs(area - best.area) <= EPSILON && Math.abs(candidate.angle) < Math.abs(best.geometry.angle))) {
      best = { area, geometry: candidate };
    }
  }
  if (!best || best.area <= EPSILON) return null;
  const geometry = best.geometry;
  if (geometry.width >= geometry.height) return geometry;
  return rectangleGeometry([
    geometry.points[1],
    geometry.points[2],
    geometry.points[3],
    geometry.points[0],
  ]);
}

function edgeCross(start, end, point) {
  return (end[0] - start[0]) * (point[1] - start[1]) -
    (end[1] - start[1]) * (point[0] - start[0]);
}

function lineIntersection(segmentStart, segmentEnd, clipStart, clipEnd) {
  const segmentX = segmentEnd[0] - segmentStart[0];
  const segmentY = segmentEnd[1] - segmentStart[1];
  const clipX = clipEnd[0] - clipStart[0];
  const clipY = clipEnd[1] - clipStart[1];
  const denominator = segmentX * clipY - segmentY * clipX;
  if (Math.abs(denominator) <= EPSILON) return segmentEnd;
  const offsetX = clipStart[0] - segmentStart[0];
  const offsetY = clipStart[1] - segmentStart[1];
  const ratio = (offsetX * clipY - offsetY * clipX) / denominator;
  return [segmentStart[0] + ratio * segmentX, segmentStart[1] + ratio * segmentY];
}

function intersectConvexPolygons(subject, clip) {
  if (subject.length < 3 || clip.length < 3) return [];
  const orientation = signedArea(clip) >= 0 ? 1 : -1;
  let output = subject.map((point) => [...point]);
  for (let edgeIndex = 0; edgeIndex < clip.length; edgeIndex += 1) {
    const clipStart = clip[edgeIndex];
    const clipEnd = clip[(edgeIndex + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    let previous = input.at(-1);
    let previousInside = orientation * edgeCross(clipStart, clipEnd, previous) >= -EPSILON;
    for (const current of input) {
      const currentInside = orientation * edgeCross(clipStart, clipEnd, current) >= -EPSILON;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
  }
  return output;
}

function polygonIntersectionOverUnion(left, right) {
  const leftArea = polygonArea(left);
  const rightArea = polygonArea(right);
  const intersectionArea = polygonArea(intersectConvexPolygons(left, right));
  const unionArea = leftArea + rightArea - intersectionArea;
  return unionArea > EPSILON ? intersectionArea / unionArea : 0;
}

function boundingBox(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function assertDetectorOutput(output) {
  const dimensions = output?.dims;
  const scores = output?.data;
  if (!Array.isArray(dimensions) || dimensions.length !== 4 || !(scores instanceof Float32Array)) {
    throw new TypeError('PaddleOCR detector returned an unexpected tensor');
  }
  const height = Number(dimensions[2]);
  const width = Number(dimensions[3]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      scores.length !== width * height || scores.some((value) => !Number.isFinite(value))) {
    throw new RangeError('PaddleOCR detector tensor dimensions or scores are invalid');
  }
  return { scores, width, height };
}

export function derivePostprocessBudget({
  sourceWidth,
  sourceHeight,
  maximumResultBytes = OCR_CONTRACT_LIMITS.maxResultBytes,
  maximumDetectorCandidates = PADDLE_DB_POSTPROCESS.maximumDetectorCandidates,
} = {}) {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) ||
      sourceWidth <= 0 || sourceHeight <= 0) {
    throw new TypeError('OCR postprocessing source dimensions must be positive integers');
  }
  if (!Number.isSafeInteger(maximumResultBytes) ||
      maximumResultBytes <= PADDLE_DB_POSTPROCESS.reservedResultBytes) {
    throw new RangeError('OCR postprocessing result budget is too small');
  }
  const resultCapacity = Math.floor(
    (maximumResultBytes - PADDLE_DB_POSTPROCESS.reservedResultBytes) /
    PADDLE_DB_POSTPROCESS.estimatedResultBytesPerLine,
  );
  const pageCapacity = Math.max(1, Math.floor(sourceWidth * sourceHeight /
    PADDLE_DB_POSTPROCESS.minimumComponentPixels));
  const maximumLines = Math.min(
    OCR_CONTRACT_LIMITS.maxLinesPerPage,
    maximumDetectorCandidates,
    resultCapacity,
    pageCapacity,
  );
  if (maximumLines < 1) throw new RangeError('OCR postprocessing line budget is empty');
  return Object.freeze({
    maximumLines,
    maximumBlocks: Math.min(PADDLE_DB_POSTPROCESS.maximumLayoutBlocks, maximumLines),
    maximumContourPoints: Math.min(
      PADDLE_DB_POSTPROCESS.maximumContourPointsPerPage,
      maximumLines * PADDLE_DB_POSTPROCESS.maximumContourPointsPerCandidate,
    ),
    maximumResultBytes,
    estimatedResultBytesPerLine: PADDLE_DB_POSTPROCESS.estimatedResultBytesPerLine,
  });
}

function createComplexityError(limit) {
  const error = new RangeError(`OCR page exceeds the ${limit}-line postprocessing complexity budget`);
  error.code = 'OCR_PAGE_COMPLEXITY_LIMIT';
  return error;
}

function connectedComponents(scores, width, height, options, budget) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];
  let contourPointCount = 0;
  for (let start = 0; start < scores.length; start += 1) {
    if (visited[start] || scores[start] <= options.binaryThreshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let count = 0;
    let scoreSum = 0;
    let weightedX = 0;
    let weightedY = 0;
    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      const score = scores[index];
      count += 1;
      scoreSum += score;
      weightedX += (x + 0.5) * score;
      weightedY += (y + 0.5) * score;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const neighbourY = y + offsetY;
        if (neighbourY < 0 || neighbourY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighbourX = x + offsetX;
          if ((offsetX === 0 && offsetY === 0) || neighbourX < 0 || neighbourX >= width) continue;
          const neighbour = neighbourY * width + neighbourX;
          if (!visited[neighbour] && scores[neighbour] > options.binaryThreshold) {
            visited[neighbour] = 1;
            queue[tail++] = neighbour;
          }
        }
      }
    }
    const score = scoreSum / count;
    if (count < options.minimumComponentPixels || score < options.boxThreshold) continue;
    const points = [];
    for (let queueIndex = 0; queueIndex < tail; queueIndex += 1) {
      const index = queue[queueIndex];
      const y = Math.floor(index / width);
      const x = index - y * width;
      const boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        scores[index - 1] <= options.binaryThreshold || scores[index + 1] <= options.binaryThreshold ||
        scores[index - width] <= options.binaryThreshold || scores[index + width] <= options.binaryThreshold;
      if (boundary) {
        if (points.length + 4 > options.maximumContourPointsPerCandidate ||
            contourPointCount + 4 > budget.maximumContourPoints) {
          throw createComplexityError(budget.maximumLines);
        }
        points.push([x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]);
        contourPointCount += 4;
      }
    }
    const rectangle = minimumAreaRectangle(points);
    if (!rectangle || Math.min(rectangle.width, rectangle.height) < options.minimumSidePixels) continue;
    components.push({
      ...rectangle,
      count,
      score,
      weightedScore: scoreSum,
      weightedCenter: [weightedX / scoreSum, weightedY / scoreSum],
    });
    if (components.length > budget.maximumLines) throw createComplexityError(budget.maximumLines);
  }
  return components;
}

function canMergeComponents(left, right) {
  if (normalizedAngleDifference(left.angle, right.angle) > 12 * Math.PI / 180) return false;
  const angle = normalizeLineAngleRadians((left.angle + right.angle) / 2);
  const along = [Math.cos(angle), Math.sin(angle)];
  const across = [-along[1], along[0]];
  const delta = [right.center[0] - left.center[0], right.center[1] - left.center[1]];
  const parallelDistance = Math.abs(delta[0] * along[0] + delta[1] * along[1]);
  const perpendicularDistance = Math.abs(delta[0] * across[0] + delta[1] * across[1]);
  const lineHeight = Math.max(left.height, right.height);
  const parallelGap = parallelDistance - (left.width + right.width) / 2;
  return perpendicularDistance <= lineHeight * 0.7 && parallelGap <= Math.max(12, lineHeight * 3);
}

function mergeComponentPair(left, right) {
  const rectangle = minimumAreaRectangle([...left.points, ...right.points]);
  const count = left.count + right.count;
  const weightedScore = left.weightedScore + right.weightedScore;
  return {
    ...rectangle,
    count,
    weightedScore,
    score: weightedScore / count,
    weightedCenter: [
      (left.weightedCenter[0] * left.weightedScore + right.weightedCenter[0] * right.weightedScore) /
        weightedScore,
      (left.weightedCenter[1] * left.weightedScore + right.weightedCenter[1] * right.weightedScore) /
        weightedScore,
    ],
  };
}

function mergeComponentsIntoLines(components) {
  const remaining = [...components].sort((left, right) =>
    left.center[1] - right.center[1] || left.center[0] - right.center[0] ||
    right.score - left.score);
  const lines = [];
  for (const component of remaining) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!canMergeComponents(line, component)) continue;
      const candidateDistance = distance(line.center, component.center);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) lines.push(component);
    else lines[bestIndex] = mergeComponentPair(lines[bestIndex], component);
  }
  return lines;
}

function unclipRectangle(rectangle, ratio, longitudinalRatio) {
  const area = rectangle.width * rectangle.height;
  const perimeter = 2 * (rectangle.width + rectangle.height);
  const acrossDistance = perimeter > EPSILON ? area * ratio / perimeter : 0;
  const alongDistance = perimeter > EPSILON ? area * longitudinalRatio / perimeter : 0;
  const along = [Math.cos(rectangle.angle), Math.sin(rectangle.angle)];
  const across = [-along[1], along[0]];
  const centerAlong = rectangle.center[0] * along[0] + rectangle.center[1] * along[1];
  const centerAcross = rectangle.center[0] * across[0] + rectangle.center[1] * across[1];
  return rectangleGeometry(rectangleFromExtents(
    rectangle.angle,
    centerAlong - rectangle.width / 2 - alongDistance,
    centerAlong + rectangle.width / 2 + alongDistance,
    centerAcross - rectangle.height / 2 - acrossDistance,
    centerAcross + rectangle.height / 2 + acrossDistance,
  ));
}

function scaleAndClampRectangle(rectangle, mapWidth, mapHeight, sourceWidth, sourceHeight) {
  const points = rectangle.points.map((point) => [
    clamp(point[0] / mapWidth * sourceWidth, 0, sourceWidth),
    clamp(point[1] / mapHeight * sourceHeight, 0, sourceHeight),
  ]);
  const normalized = minimumAreaRectangle(points);
  if (!normalized || polygonArea(normalized.points) <= EPSILON) return null;
  const boundedPoints = normalized.points.map((point) => [
    clamp(point[0], 0, sourceWidth),
    clamp(point[1], 0, sourceHeight),
  ]);
  if (convexHull(boundedPoints).length !== 4 || polygonArea(boundedPoints) <= EPSILON) return null;
  const boundedGeometry = rectangleGeometry(boundedPoints);
  const bounds = boundingBox(boundedPoints);
  if (bounds.width <= EPSILON || bounds.height <= EPSILON) return null;
  return {
    polygon: boundedPoints,
    boundingBox: bounds,
    width: boundedGeometry.width,
    height: boundedGeometry.height,
    center: boundedGeometry.center,
    angleRadians: boundedGeometry.angle,
    angleDegrees: normalizeLineAngleRadians(boundedGeometry.angle) * 180 / Math.PI,
  };
}

export function suppressDuplicateDetections(
  candidates,
  threshold = PADDLE_DB_POSTPROCESS.duplicateIouThreshold,
) {
  const selected = [];
  const ranked = [...candidates].sort((left, right) =>
    right.detectionConfidence - left.detectionConfidence ||
    left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x);
  for (const candidate of ranked) {
    if (selected.some((existing) =>
      polygonIntersectionOverUnion(existing.polygon, candidate.polygon) >= threshold)) continue;
    selected.push(candidate);
  }
  return selected;
}

export function detectionMapToQuadrilaterals(output, sourceWidth, sourceHeight, options = {}) {
  const detector = assertDetectorOutput(output);
  const settings = { ...PADDLE_DB_POSTPROCESS, ...options };
  const derivedBudget = derivePostprocessBudget({
    sourceWidth,
    sourceHeight,
    maximumResultBytes: options.maximumResultBytes,
    maximumDetectorCandidates: options.maximumDetectorCandidates,
  });
  const budget = options.budget ? { ...derivedBudget, ...options.budget } : derivedBudget;
  const components = connectedComponents(
    detector.scores,
    detector.width,
    detector.height,
    settings,
    budget,
  );
  const merged = mergeComponentsIntoLines(components);
  if (merged.length > budget.maximumLines) throw createComplexityError(budget.maximumLines);
  const candidates = merged
    .map((line) => {
      const compactAreaRatio = line.width * line.height / (detector.width * detector.height);
      if (line.width / Math.max(EPSILON, line.height) < 1.5 &&
          compactAreaRatio > settings.maximumCompactRegionAreaRatio) return null;
      const recognitionRectangle = unclipRectangle(
        line,
        settings.unclipRatio,
        settings.unclipRatio,
      );
      const supportRectangle = unclipRectangle(
        line,
        settings.unclipRatio,
        settings.longitudinalUnclipRatio,
      );
      const recognitionGeometry = scaleAndClampRectangle(
        recognitionRectangle,
        detector.width,
        detector.height,
        sourceWidth,
        sourceHeight,
      );
      const geometry = scaleAndClampRectangle(
        supportRectangle,
        detector.width,
        detector.height,
        sourceWidth,
        sourceHeight,
      );
      return geometry && recognitionGeometry ? {
        ...geometry,
        recognitionPolygon: recognitionGeometry.polygon,
        contentWidth: recognitionGeometry.width,
        contentHeight: recognitionGeometry.height,
        detectionConfidence: clamp(line.score, 0, 1),
        sourceComponentCount: line.count,
      } : null;
    })
    .filter(Boolean);
  const deduplicated = suppressDuplicateDetections(candidates, settings.duplicateIouThreshold);
  if (deduplicated.length > budget.maximumLines) throw createComplexityError(budget.maximumLines);
  return deduplicated.sort((left, right) =>
    left.center[1] - right.center[1] || left.center[0] - right.center[0] ||
    left.angleDegrees - right.angleDegrees);
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function median(values) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function createLayoutBlocks(lines, maximumBlocks) {
  const ordered = [...lines].sort((left, right) =>
    left.boundingBox.x - right.boundingBox.x || left.boundingBox.y - right.boundingBox.y ||
    left.text.localeCompare(right.text, 'und'));
  const parents = ordered.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parents[current] !== current) current = parents[current];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = current;
      index = next;
    }
    return current;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const typicalHeight = Math.max(1, median(ordered.map((line) => line.boundingBox.height)));
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex].boundingBox;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex].boundingBox;
      const overlap = intervalsOverlap(left.x, left.x + left.width, right.x, right.x + right.width);
      const overlapRatio = overlap / Math.max(EPSILON, Math.min(left.width, right.width));
      const alignedEdge = Math.abs(left.x - right.x) <= typicalHeight * 2;
      if (overlapRatio >= 0.2 || alignedEdge) join(leftIndex, rightIndex);
    }
  }
  const groups = new Map();
  ordered.forEach((line, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(line);
    groups.set(root, group);
  });
  if (groups.size > maximumBlocks) {
    const error = new RangeError(`OCR layout exceeds the ${maximumBlocks}-block complexity budget`);
    error.code = 'OCR_PAGE_COMPLEXITY_LIMIT';
    throw error;
  }
  return [...groups.values()].map((blockLines) => {
    const block = boundingBox(blockLines.flatMap((line) => line.polygon));
    blockLines.sort((left, right) =>
      left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x ||
      left.text.localeCompare(right.text, 'und'));
    return { boundingBox: block, lines: blockLines };
  }).sort((left, right) =>
    left.boundingBox.x - right.boundingBox.x || left.boundingBox.y - right.boundingBox.y);
}

function rowClusters(lines) {
  const typicalHeight = Math.max(1, median(lines.map((line) => line.boundingBox.height)));
  const rows = [];
  for (const line of [...lines].sort((left, right) =>
    left.center[1] - right.center[1] || left.center[0] - right.center[0])) {
    let row = rows.find((candidate) => Math.abs(candidate.centerY - line.center[1]) <= typicalHeight * 0.65);
    if (!row) {
      row = { centerY: line.center[1], lines: [] };
      rows.push(row);
    }
    row.lines.push(line);
    row.centerY = row.lines.reduce((sum, item) => sum + item.center[1], 0) / row.lines.length;
  }
  return rows;
}

export function orderRecognizedLines(lines, budget) {
  const maximumBlocks = budget?.maximumBlocks ?? PADDLE_DB_POSTPROCESS.maximumLayoutBlocks;
  const blocks = createLayoutBlocks(lines, maximumBlocks);
  return {
    blocks,
    lines: blocks.flatMap((block) => block.lines),
  };
}

function unsupportedReason(id, code, message) {
  return { id, code, message };
}

export function classifyUnsupportedLayout({ candidates, recognizedLines, blocks }) {
  const reasons = [];
  if (candidates.some((candidate) =>
    Math.abs(candidate.angleDegrees) > PADDLE_DB_POSTPROCESS.maximumSupportedLineAngleDegrees)) {
    reasons.push(unsupportedReason(
      'unsupported-rotated-text',
      'rotated-text',
      'Page rotation or steeply rotated text is outside the qualified recognition scope.',
    ));
  }
  const rows = rowClusters(candidates);
  if (blocks.length >= 3 && rows.filter((row) => row.lines.length >= 3).length >= 2) {
    reasons.push(unsupportedReason(
      'unsupported-table-layout',
      'table',
      'Repeated row and column structure requires table-aware layout analysis.',
    ));
  } else if (blocks.length > 2) {
    reasons.push(unsupportedReason(
      'unsupported-complex-layout',
      'complex-layout',
      'The detected page contains more layout regions than the qualified two-column scope.',
    ));
  }
  if (reasons.length === 0 && recognizedLines.length > 0) {
    const strongLines = recognizedLines.filter((line) => line.confidence >=
      PADDLE_DB_POSTPROCESS.recognitionConfidenceThreshold);
    const density = strongLines.length === 0 ? 0 : strongLines.reduce((sum, line) => {
      const characters = Array.from(line.text.replace(/\s/gu, '')).length;
      const aspect = (line.contentWidth ?? line.width) /
        Math.max(1, line.contentHeight ?? line.height);
      return sum + characters / Math.max(1, aspect);
    }, 0) / strongLines.length;
    if (strongLines.length > 0 && density < PADDLE_DB_POSTPROCESS.minimumQualifiedTextDensity) {
      reasons.push(unsupportedReason(
        'unsupported-low-confidence-content',
        'low-confidence',
        'Detected content did not produce text dense enough for the qualified model scope.',
      ));
    }
  }
  return reasons;
}
