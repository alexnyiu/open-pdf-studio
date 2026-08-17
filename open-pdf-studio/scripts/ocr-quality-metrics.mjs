const EPSILON = 1e-9;

export function normalizeOcrText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function editDistance(left, right) {
  const source = Array.from(left);
  const target = Array.from(right);
  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  const current = new Array(target.length + 1);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    current[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      current[targetIndex] = Math.min(
        current[targetIndex - 1] + 1,
        previous[targetIndex] + 1,
        previous[targetIndex - 1] + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1),
      );
    }
    for (let targetIndex = 0; targetIndex <= target.length; targetIndex += 1) {
      previous[targetIndex] = current[targetIndex];
    }
  }
  return previous[target.length];
}

function textMetrics(expected, actual) {
  const expectedText = normalizeOcrText(expected);
  const actualText = normalizeOcrText(actual);
  const expectedCharacters = Array.from(expectedText);
  const actualCharacters = Array.from(actualText);
  const expectedWords = expectedText ? expectedText.split(' ') : [];
  const actualWords = actualText ? actualText.split(' ') : [];
  const characterEdits = editDistance(expectedCharacters, actualCharacters);
  const wordEdits = editDistance(expectedWords, actualWords);
  return {
    expectedCharacters: expectedCharacters.length,
    actualCharacters: actualCharacters.length,
    characterEdits,
    characterErrorRate: expectedCharacters.length === 0
      ? Number(actualCharacters.length > 0)
      : characterEdits / expectedCharacters.length,
    expectedWords: expectedWords.length,
    actualWords: actualWords.length,
    wordEdits,
    wordErrorRate: expectedWords.length === 0
      ? Number(actualWords.length > 0)
      : wordEdits / expectedWords.length,
  };
}

function signedPolygonArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  return Math.abs(signedPolygonArea(points));
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

export function intersectConvexPolygons(subject, clip) {
  if (!Array.isArray(subject) || subject.length < 3 || !Array.isArray(clip) || clip.length < 3) {
    return [];
  }
  const orientation = signedPolygonArea(clip) >= 0 ? 1 : -1;
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

export function polygonOverlap(expectedPoints, actualPoints) {
  const expectedArea = polygonArea(expectedPoints);
  const actualArea = polygonArea(actualPoints);
  const intersectionArea = polygonArea(intersectConvexPolygons(actualPoints, expectedPoints));
  const unionArea = expectedArea + actualArea - intersectionArea;
  return {
    expectedArea,
    actualArea,
    intersectionArea,
    intersectionOverUnion: unionArea > 0 ? intersectionArea / unionArea : 0,
    expectedCoverage: expectedArea > 0 ? intersectionArea / expectedArea : 0,
  };
}

function geometryPairs(expectedLines, actualLines) {
  const pairs = [];
  expectedLines.forEach((expected, expectedIndex) => {
    actualLines.forEach((actual, actualIndex) => {
      const overlap = polygonOverlap(expected.polygon.points, actual.polygon.points);
      if (overlap.intersectionArea > 0) pairs.push({ expectedIndex, actualIndex, ...overlap });
    });
  });
  return pairs.sort((left, right) =>
    right.intersectionOverUnion - left.intersectionOverUnion ||
    right.expectedCoverage - left.expectedCoverage ||
    left.expectedIndex - right.expectedIndex ||
    left.actualIndex - right.actualIndex);
}

export function matchLineGeometry(expectedLines, actualLines, { minimumIou = 0.1 } = {}) {
  const expectedMatched = new Set();
  const actualMatched = new Set();
  const matches = [];
  for (const pair of geometryPairs(expectedLines, actualLines)) {
    if (pair.intersectionOverUnion < minimumIou || expectedMatched.has(pair.expectedIndex) ||
        actualMatched.has(pair.actualIndex)) continue;
    expectedMatched.add(pair.expectedIndex);
    actualMatched.add(pair.actualIndex);
    matches.push(pair);
  }
  matches.sort((left, right) => left.actualIndex - right.actualIndex);
  const missedLineCount = expectedLines.length - matches.length;
  const duplicateLineCount = actualLines.length - matches.length;
  const precision = actualLines.length === 0 ? Number(expectedLines.length === 0) : matches.length / actualLines.length;
  const recall = expectedLines.length === 0 ? 1 : matches.length / expectedLines.length;
  return {
    matches,
    lineDetectionPrecision: precision,
    lineDetectionRecall: recall,
    meanPolygonIntersectionOverUnion: matches.length
      ? matches.reduce((sum, match) => sum + match.intersectionOverUnion, 0) / matches.length
      : Number(expectedLines.length === 0 && actualLines.length === 0),
    meanPolygonCoverage: matches.length
      ? matches.reduce((sum, match) => sum + match.expectedCoverage, 0) / matches.length
      : Number(expectedLines.length === 0 && actualLines.length === 0),
    missedLineCount,
    duplicateLineCount,
  };
}

export function readingOrderError(expectedLines, actualLines, matches) {
  if (expectedLines.length === 0) return 0;
  const actualSequence = [...matches]
    .sort((left, right) => left.actualIndex - right.actualIndex)
    .map((match) => match.expectedIndex);
  let inversions = 0;
  for (let left = 0; left < actualSequence.length; left += 1) {
    for (let right = left + 1; right < actualSequence.length; right += 1) {
      if (actualSequence[left] > actualSequence[right]) inversions += 1;
    }
  }
  const maximumInversions = actualSequence.length * (actualSequence.length - 1) / 2;
  return maximumInversions > 0 ? inversions / maximumInversions : 0;
}

function observedDisposition(result) {
  if (result?.page?.status === 'unsupported' || (result?.unsupportedContentReasons?.length ?? 0) > 0) {
    return 'unsupported';
  }
  return result?.page?.status ?? 'failed';
}

export function measureOcrFixture(fixture, result, resultBytes) {
  const actualLines = Array.isArray(result?.lines) ? result.lines : [];
  const geometry = matchLineGeometry(fixture.expected.lines, actualLines);
  const text = textMetrics(fixture.expected.text, result?.text ?? '');
  return {
    fixtureId: fixture.id,
    category: fixture.category,
    classification: fixture.classification,
    expectedDisposition: fixture.expected.disposition,
    observedDisposition: observedDisposition(result),
    ...text,
    readingOrderError: readingOrderError(fixture.expected.lines, actualLines, geometry.matches),
    lineDetectionPrecision: geometry.lineDetectionPrecision,
    lineDetectionRecall: geometry.lineDetectionRecall,
    meanPolygonIntersectionOverUnion: geometry.meanPolygonIntersectionOverUnion,
    meanPolygonCoverage: geometry.meanPolygonCoverage,
    missedLineCount: geometry.missedLineCount,
    duplicateLineCount: geometry.duplicateLineCount,
    expectedLineCount: fixture.expected.lines.length,
    actualLineCount: actualLines.length,
    resultBytes,
    dispositionCorrect: observedDisposition(result) === fixture.expected.disposition,
    matchedLines: geometry.matches.map((match) => ({
      expectedLineId: fixture.expected.lines[match.expectedIndex].id,
      actualLineId: actualLines[match.actualIndex].id,
      expectedIndex: match.expectedIndex,
      actualIndex: match.actualIndex,
      intersectionOverUnion: match.intersectionOverUnion,
      expectedCoverage: match.expectedCoverage,
    })),
  };
}

function safeRate(numerator, denominator, emptyValue = 0) {
  return denominator > 0 ? numerator / denominator : emptyValue;
}

export function aggregateOcrMetrics(records) {
  const supported = records.filter((record) => record.classification === 'supported');
  const unsupported = records.filter((record) => record.classification === 'unsupported');
  const rejected = records.filter((record) => record.classification === 'rejected');
  const sums = supported.reduce((total, record) => ({
    expectedCharacters: total.expectedCharacters + record.expectedCharacters,
    actualCharacters: total.actualCharacters + record.actualCharacters,
    characterEdits: total.characterEdits + record.characterEdits,
    expectedWords: total.expectedWords + record.expectedWords,
    actualWords: total.actualWords + record.actualWords,
    wordEdits: total.wordEdits + record.wordEdits,
    readingOrderError: total.readingOrderError + record.readingOrderError,
    matchedLines: total.matchedLines + record.matchedLines.length,
    expectedLines: total.expectedLines + record.expectedLineCount,
    actualLines: total.actualLines + record.actualLineCount,
    polygonIou: total.polygonIou + record.matchedLines.reduce(
      (sum, match) => sum + match.intersectionOverUnion,
      0,
    ),
    polygonCoverage: total.polygonCoverage + record.matchedLines.reduce(
      (sum, match) => sum + match.expectedCoverage,
      0,
    ),
    missedLines: total.missedLines + record.missedLineCount,
    duplicateLines: total.duplicateLines + record.duplicateLineCount,
  }), {
    expectedCharacters: 0,
    actualCharacters: 0,
    characterEdits: 0,
    expectedWords: 0,
    actualWords: 0,
    wordEdits: 0,
    readingOrderError: 0,
    matchedLines: 0,
    expectedLines: 0,
    actualLines: 0,
    polygonIou: 0,
    polygonCoverage: 0,
    missedLines: 0,
    duplicateLines: 0,
  });
  return {
    supportedFixtureCount: supported.length,
    unsupportedFixtureCount: unsupported.length,
    rejectedFixtureCount: rejected.length,
    expectedCharacters: sums.expectedCharacters,
    actualCharacters: sums.actualCharacters,
    characterEdits: sums.characterEdits,
    characterErrorRate: safeRate(sums.characterEdits, sums.expectedCharacters, Number(sums.actualCharacters > 0)),
    expectedWords: sums.expectedWords,
    actualWords: sums.actualWords,
    wordEdits: sums.wordEdits,
    wordErrorRate: safeRate(sums.wordEdits, sums.expectedWords, Number(sums.actualWords > 0)),
    readingOrderError: safeRate(sums.readingOrderError, supported.length),
    lineDetectionPrecision: safeRate(sums.matchedLines, sums.actualLines, Number(sums.expectedLines === 0)),
    lineDetectionRecall: safeRate(sums.matchedLines, sums.expectedLines, 1),
    meanPolygonIntersectionOverUnion: safeRate(sums.polygonIou, sums.matchedLines, Number(sums.expectedLines === 0)),
    meanPolygonCoverage: safeRate(sums.polygonCoverage, sums.matchedLines, Number(sums.expectedLines === 0)),
    missedLineCount: sums.missedLines,
    duplicateLineCount: sums.duplicateLines,
    unsupportedPageAccuracy: safeRate(
      unsupported.filter((record) => record.dispositionCorrect).length,
      unsupported.length,
      1,
    ),
    rejectedInputAccuracy: safeRate(
      rejected.filter((record) => record.dispositionCorrect).length,
      rejected.length,
      1,
    ),
    peakResultBytes: records.reduce((maximum, record) => Math.max(maximum, record.resultBytes ?? 0), 0),
  };
}

const THRESHOLD_RULES = Object.freeze({
  maximumCharacterErrorRate: ['characterErrorRate', 'maximum'],
  maximumWordErrorRate: ['wordErrorRate', 'maximum'],
  maximumReadingOrderError: ['readingOrderError', 'maximum'],
  minimumLineDetectionPrecision: ['lineDetectionPrecision', 'minimum'],
  minimumLineDetectionRecall: ['lineDetectionRecall', 'minimum'],
  minimumMeanPolygonIntersectionOverUnion: ['meanPolygonIntersectionOverUnion', 'minimum'],
  minimumMeanPolygonCoverage: ['meanPolygonCoverage', 'minimum'],
  maximumMissedLineCount: ['missedLineCount', 'maximum'],
  maximumDuplicateLineCount: ['duplicateLineCount', 'maximum'],
  minimumUnsupportedPageAccuracy: ['unsupportedPageAccuracy', 'minimum'],
  minimumRejectedInputAccuracy: ['rejectedInputAccuracy', 'minimum'],
  maximumPeakResultBytes: ['peakResultBytes', 'maximum'],
});

function checkThresholds(metrics, thresholds, path) {
  const failures = [];
  for (const [policyKey, limit] of Object.entries(thresholds ?? {})) {
    const rule = THRESHOLD_RULES[policyKey];
    if (!rule) {
      failures.push(`${path}.${policyKey} is not a supported OCR quality threshold`);
      continue;
    }
    if (limit === null) continue;
    const [metricKey, direction] = rule;
    const actual = metricKey === 'peakResultBytes'
      ? metrics.peakResultBytes ?? metrics.resultBytes
      : metrics[metricKey];
    if (!Number.isFinite(actual) || !Number.isFinite(limit)) {
      failures.push(`${path}.${policyKey} must compare finite values`);
      continue;
    }
    if ((direction === 'maximum' && actual > limit) || (direction === 'minimum' && actual < limit)) {
      failures.push(`${path}.${policyKey}: ${metricKey} ${actual} violates ${limit}`);
    }
  }
  return failures;
}

export function evaluateOcrAcceptance(records, policy) {
  if (policy?.contract !== 'open-pdf-studio.ocr.quality-thresholds' || policy?.schemaVersion !== 1) {
    throw new TypeError('OCR quality threshold policy is incompatible');
  }
  if (!['proposed', 'approved'].includes(policy.approvalStatus)) {
    throw new TypeError('OCR quality threshold policy approvalStatus is invalid');
  }
  if (typeof policy.policyVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(policy.policyVersion)) {
    throw new TypeError('OCR quality threshold policyVersion must be semver');
  }
  if (!Array.isArray(policy.platformScope) ||
      policy.platformScope.length !== 1 || policy.platformScope[0] !== 'macos') {
    throw new TypeError('OCR quality threshold policy must be macOS-only');
  }
  if (policy.approvalStatus === 'approved' &&
      (typeof policy.approvedBy !== 'string' || policy.approvedBy.trim().length === 0 ||
       typeof policy.approvedAt !== 'string' || !Number.isFinite(Date.parse(policy.approvedAt)))) {
    throw new TypeError('Approved OCR quality thresholds require an approver and timestamp');
  }
  const aggregate = aggregateOcrMetrics(records);
  const aggregateFailures = checkThresholds(aggregate, policy.thresholds?.aggregate, 'thresholds.aggregate');
  const categories = records.map((record) => {
    if (record.classification === 'unsupported') {
      return { fixtureId: record.fixtureId, category: record.category, status: 'UNSUPPORTED', failures: [] };
    }
    if (record.classification === 'rejected') {
      return {
        fixtureId: record.fixtureId,
        category: record.category,
        status: record.dispositionCorrect ? 'PASS' : 'FAIL',
        failures: record.dispositionCorrect ? [] : ['expected rejection was not observed'],
      };
    }
    const thresholds = policy.thresholds?.categories?.[record.category];
    const failures = thresholds
      ? checkThresholds(record, thresholds, `thresholds.categories.${record.category}`)
      : [`no threshold is defined for supported category ${record.category}`];
    if (!record.dispositionCorrect) {
      failures.push(`expected ${record.expectedDisposition} disposition; observed ${record.observedDisposition}`);
    }
    return {
      fixtureId: record.fixtureId,
      category: record.category,
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
    };
  });
  const requiredFailures = categories.filter((category) => category.status === 'FAIL');
  return {
    approvalStatus: policy.approvalStatus,
    policyVersion: policy.policyVersion,
    aggregate,
    aggregateFailures,
    categories,
    passesThresholds: aggregateFailures.length === 0 && requiredFailures.length === 0,
    releaseAccepted: policy.approvalStatus === 'approved' &&
      aggregateFailures.length === 0 && requiredFailures.length === 0,
  };
}
