import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createOcrQualityFixtures } from './generate-ocr-quality-fixtures.mjs';
import {
  evaluateOcrAcceptance,
  measureOcrFixture,
  normalizeOcrText,
  polygonOverlap,
} from './ocr-quality-metrics.mjs';
import {
  shouldFailOcrQualityGate,
  validateOcrQualityCorpus,
} from './run-ocr-quality-benchmark.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'quality-v1');
const policyPath = path.join(projectDir, 'docs', 'ocr', 'quality-benchmark', 'thresholds.v1.json');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function line(id, text, points) {
  return {
    id,
    text,
    polygon: { coordinateSpace: 'source-raster-pixels', points },
  };
}

function fixture(lines) {
  return {
    id: 'metric-fixture',
    category: 'metric-category',
    classification: 'supported',
    expected: {
      disposition: 'completed',
      text: lines.map((item) => item.text).join('\n'),
      readingOrder: lines.map((item) => item.id),
      lines,
    },
  };
}

function productionLine(id, text, points) {
  return {
    id,
    text,
    polygon: { coordinateSpace: 'source-raster-pixels', points },
  };
}

test('quality corpus is deterministic, small, licensed, and complete', async () => {
  const committed = JSON.parse(await readFile(path.join(corpusDir, 'corpus.v1.json'), 'utf8'));
  assert.equal(validateOcrQualityCorpus(committed), committed);
  assert.equal(committed.fixtures.length, 18);
  assert.equal(committed.fixtures.find((item) => item.id === 'dense-70-lines').expected.lines.length, 70);
  assert.deepEqual(
    committed.fixtures.filter((item) => item.id.startsWith('rotation-')).map((item) => item.classification),
    ['unsupported', 'unsupported', 'unsupported'],
  );
  assert.equal(committed.fixtures.find((item) => item.id === 'unsupported-table').classification, 'unsupported');
  assert.equal(committed.fixtures.find((item) => item.id === 'unsupported-cyrillic').classification, 'unsupported');
  assert.equal(committed.fixtures.find((item) => item.id === 'malformed-rgba').classification, 'rejected');
  assert.equal(committed.fixtures.find((item) => item.id === 'resource-heavy').classification, 'rejected');
  assert.equal(committed.excludedPassingScope.includes('handwriting'), true);
  assert.equal(committed.excludedPassingScope.includes('curved-text'), true);
  assert.equal(committed.excludedPassingScope.includes('severe-perspective-warping'), true);
  const mixedLayers = new Set(committed.fixtures
    .find((item) => item.id === 'mixed-image-native-text').expected.lines
    .map((item) => item.sourceLayer));
  assert.deepEqual([...mixedLayers].sort(), ['image', 'native-text']);
  await Promise.all([
    readFile(path.join(corpusDir, 'README.md')),
    readFile(path.join(corpusDir, 'PROVENANCE.md')),
    readFile(path.join(corpusDir, 'LICENSES.md')),
    readFile(path.join(corpusDir, '..', 'LICENSE-CC0-1.0.txt')),
    readFile(path.join(projectDir, 'public', 'pdfjs', 'web', 'standard_fonts', 'LICENSE_LIBERATION')),
  ]);

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ocr-quality-fixtures-'));
  try {
    const generated = await createOcrQualityFixtures(temporary);
    assert.deepEqual(generated, committed);
    let totalBytes = 0;
    for (const item of committed.fixtures.filter((entry) => entry.input.kind === 'rgba-page-raster')) {
      const [expectedBytes, generatedBytes] = await Promise.all([
        readFile(path.join(corpusDir, item.input.file)),
        readFile(path.join(temporary, item.input.file)),
      ]);
      assert.equal(digest(generatedBytes), item.input.sha256);
      assert.deepEqual(generatedBytes, expectedBytes);
      totalBytes += generatedBytes.byteLength;
    }
    assert.ok(totalBytes < 1024 * 1024);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('text, reading order, line detection, and polygon measures are independent', () => {
  const first = line('expected-1', 'Café first', [[0, 0], [100, 0], [100, 20], [0, 20]]);
  const second = line('expected-2', 'Second line', [[0, 40], [100, 40], [100, 60], [0, 60]]);
  const expected = fixture([first, second]);
  const reversed = {
    page: { status: 'completed' },
    text: 'CAFÉ FIRST\nSecond line',
    lines: [
      productionLine('actual-2', 'CAFÉ FIRST', second.polygon.points),
      productionLine('actual-1', 'Second line', first.polygon.points),
    ],
    unsupportedContentReasons: [],
  };
  const measured = measureOcrFixture(expected, reversed, 512);
  assert.equal(normalizeOcrText(' CAFÉ   FIRST '), 'café first');
  assert.equal(measured.characterErrorRate, 0);
  assert.equal(measured.wordErrorRate, 0);
  assert.equal(measured.readingOrderError, 1);
  assert.equal(measured.lineDetectionPrecision, 1);
  assert.equal(measured.lineDetectionRecall, 1);
  assert.equal(measured.meanPolygonIntersectionOverUnion, 1);
  assert.equal(measured.meanPolygonCoverage, 1);
  assert.equal(measured.missedLineCount, 0);
  assert.equal(measured.duplicateLineCount, 0);

  const overlap = polygonOverlap(
    [[0, 0], [100, 0], [100, 100], [0, 100]],
    [[50, 0], [150, 0], [150, 100], [50, 100]],
  );
  assert.equal(overlap.intersectionArea, 5000);
  assert.equal(overlap.intersectionOverUnion, 1 / 3);
  assert.equal(overlap.expectedCoverage, 0.5);
});

test('extra and missed line counts do not masquerade as reading-order error', () => {
  const expected = fixture([
    line('one', 'One', [[0, 0], [50, 0], [50, 20], [0, 20]]),
    line('two', 'Two', [[0, 40], [50, 40], [50, 60], [0, 60]]),
  ]);
  const measured = measureOcrFixture(expected, {
    page: { status: 'completed' },
    text: 'One\nExtra',
    lines: [
      productionLine('actual-one', 'One', [[0, 0], [50, 0], [50, 20], [0, 20]]),
      productionLine('extra', 'Extra', [[100, 100], [150, 100], [150, 120], [100, 120]]),
    ],
    unsupportedContentReasons: [],
  }, 256);
  assert.equal(measured.readingOrderError, 0);
  assert.equal(measured.missedLineCount, 1);
  assert.equal(measured.duplicateLineCount, 1);
  assert.equal(measured.lineDetectionPrecision, 0.5);
  assert.equal(measured.lineDetectionRecall, 0.5);
});

test('unexpected text on an expected-empty page is a detection error, not an order error', () => {
  const measured = measureOcrFixture(fixture([]), {
    page: { status: 'completed' },
    text: 'Unexpected',
    lines: [
      productionLine('unexpected', 'Unexpected', [[0, 0], [80, 0], [80, 20], [0, 20]]),
    ],
    unsupportedContentReasons: [],
  }, 128);
  assert.equal(measured.characterErrorRate, 1);
  assert.equal(measured.wordErrorRate, 1);
  assert.equal(measured.readingOrderError, 0);
  assert.equal(measured.lineDetectionPrecision, 0);
  assert.equal(measured.lineDetectionRecall, 1);
  assert.equal(measured.duplicateLineCount, 1);
});

test('a supported fixture cannot pass with an unsupported engine disposition', async () => {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const record = {
    fixtureId: 'blank-page',
    category: 'blank-page',
    classification: 'supported',
    expectedDisposition: 'completed',
    observedDisposition: 'unsupported',
    expectedCharacters: 0,
    actualCharacters: 0,
    characterEdits: 0,
    characterErrorRate: 0,
    expectedWords: 0,
    actualWords: 0,
    wordEdits: 0,
    wordErrorRate: 0,
    readingOrderError: 0,
    lineDetectionPrecision: 1,
    lineDetectionRecall: 1,
    meanPolygonIntersectionOverUnion: 1,
    meanPolygonCoverage: 1,
    missedLineCount: 0,
    duplicateLineCount: 0,
    expectedLineCount: 0,
    actualLineCount: 0,
    resultBytes: 100,
    dispositionCorrect: false,
    matchedLines: [],
  };
  const acceptance = evaluateOcrAcceptance([record], {
    ...policy,
    thresholds: {
      aggregate: {},
      categories: { 'blank-page': policy.thresholds.categories['blank-page'] },
    },
  });
  assert.equal(acceptance.categories[0].status, 'FAIL');
  assert.match(acceptance.categories[0].failures.at(-1), /expected completed disposition/);
});

test('approved policies fail regressions while proposed policies remain review evidence', async () => {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const record = {
    fixtureId: 'quality-case',
    category: 'quality-category',
    classification: 'supported',
    expectedDisposition: 'completed',
    observedDisposition: 'completed',
    expectedCharacters: 10,
    actualCharacters: 10,
    characterEdits: 2,
    characterErrorRate: 0.2,
    expectedWords: 2,
    actualWords: 2,
    wordEdits: 1,
    wordErrorRate: 0.5,
    readingOrderError: 0,
    lineDetectionPrecision: 1,
    lineDetectionRecall: 1,
    meanPolygonIntersectionOverUnion: 1,
    meanPolygonCoverage: 1,
    missedLineCount: 0,
    duplicateLineCount: 0,
    expectedLineCount: 1,
    actualLineCount: 1,
    resultBytes: 100,
    dispositionCorrect: true,
    matchedLines: [{ intersectionOverUnion: 1, expectedCoverage: 1 }],
  };
  const focusedPolicy = {
    ...policy,
    approvalStatus: 'proposed',
    approvedBy: null,
    approvedAt: null,
    thresholds: {
      aggregate: { maximumCharacterErrorRate: 0.1 },
      categories: { 'quality-category': { maximumCharacterErrorRate: 0.1 } },
    },
  };
  const proposed = evaluateOcrAcceptance([record], focusedPolicy);
  assert.equal(proposed.passesThresholds, false);
  assert.equal(proposed.releaseAccepted, false);
  assert.equal(shouldFailOcrQualityGate(proposed), false);
  assert.equal(shouldFailOcrQualityGate(proposed, { enforceProposed: true }), true);

  assert.throws(
    () => evaluateOcrAcceptance([record], { ...focusedPolicy, approvalStatus: 'approved' }),
    /approver and timestamp/,
  );
  const approved = evaluateOcrAcceptance([record], {
    ...focusedPolicy,
    approvalStatus: 'approved',
    approvedBy: 'user-approved-policy',
    approvedAt: '2026-08-16T00:00:00.000Z',
  });
  assert.equal(approved.releaseAccepted, false);
  assert.equal(shouldFailOcrQualityGate(approved), true);
});

test('user-approved policy defines unchanged thresholds for every supported category', async () => {
  const [corpus, policy] = await Promise.all([
    readFile(path.join(corpusDir, 'corpus.v1.json'), 'utf8').then(JSON.parse),
    readFile(policyPath, 'utf8').then(JSON.parse),
  ]);
  assert.equal(policy.approvalStatus, 'approved');
  assert.equal(policy.approvedBy, 'project-owner');
  assert.ok(Number.isFinite(Date.parse(policy.approvedAt)));
  const supportedCategories = corpus.fixtures
    .filter((item) => item.classification === 'supported')
    .map((item) => item.category)
    .sort();
  assert.deepEqual(Object.keys(policy.thresholds.categories).sort(), supportedCategories);
  assert.equal(policy.thresholds.aggregate.minimumUnsupportedPageAccuracy, null);
});

test('committed post-processing baseline preserves prior evidence and separates timing', async () => {
  const artifactDir = path.join(projectDir, 'docs', 'ocr', 'quality-benchmark');
  const [priorText, baselineText, timingText, deltaText, policy, report] = await Promise.all([
    readFile(path.join(artifactDir, 'baseline.macos.v1.json'), 'utf8'),
    readFile(path.join(artifactDir, 'baseline.macos.v2.json'), 'utf8'),
    readFile(path.join(artifactDir, 'timing.macos-arm64.v2.json'), 'utf8'),
    readFile(path.join(artifactDir, 'delta.macos.v1-to-v2.json'), 'utf8'),
    readFile(path.join(artifactDir, 'thresholds.v1.json'), 'utf8').then(JSON.parse),
    readFile(path.join(artifactDir, 'REPORT.md'), 'utf8'),
  ]);
  const prior = JSON.parse(priorText);
  const baseline = JSON.parse(baselineText);
  const timing = JSON.parse(timingText);
  const delta = JSON.parse(deltaText);
  assert.equal(baseline.contract, 'open-pdf-studio.ocr.quality-baseline');
  assert.match(baseline.baselineId, /^macos-ocr-quality-[a-f0-9]{24}$/);
  assert.equal(baseline.accuracy.cases.length, 18);
  assert.equal(baseline.acceptance.categories.length, 18);
  assert.equal(prior.acceptance.passesThresholds, false);
  assert.equal(baseline.acceptance.approvalStatus, 'approved');
  assert.equal(baseline.acceptance.passesThresholds, true);
  assert.equal(baseline.acceptance.releaseAccepted, true);
  assert.equal(baselineText.includes('"measuredAt"'), false);
  for (const item of baseline.accuracy.cases.filter((entry) => entry.result)) {
    assert.equal(Object.hasOwn(item.result, 'metrics'), false);
    for (const resultLine of item.result.lines) {
      assert.equal(resultLine.polygon.coordinateSpace, 'source-raster-pixels');
    }
  }
  assert.equal(timing.contract, 'open-pdf-studio.ocr.quality-timing');
  assert.equal(timing.accuracyBaselineId, baseline.baselineId);
  assert.equal(timing.method.informationalOnly, true);
  assert.ok(Number.isFinite(Date.parse(timing.measuredAt)));
  assert.ok(timing.summary.peakSerializedProductionResultBytes >= baseline.accuracy.aggregate.peakResultBytes);
  assert.equal(policy.basis.measuredBaselineId, prior.baselineId);
  assert.equal(delta.contract, 'open-pdf-studio.ocr.quality-delta');
  assert.equal(delta.fromBaselineId, prior.baselineId);
  assert.equal(delta.toBaselineId, baseline.baselineId);
  assert.equal(delta.categories.length, 18);
  assert.match(report, /meets its approved/);
  assert.match(report, /Category deltas/);
});
