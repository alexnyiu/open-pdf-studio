import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

import { assertOcrResultV1 } from '../js/ocr/contracts/v1.js';
import { validatePlatformReport } from './evaluate-ocr-phase-a-reports.mjs';
import { createOcrFixtures } from './generate-ocr-fixtures.mjs';
import { verifyOcrAssets } from './verify-ocr-assets.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectDir, 'tests', 'fixtures', 'ocr');

test('vendored OCR model/runtime assets match pinned size and checksums', async () => {
  const result = await verifyOcrAssets();
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 3);
  assert.equal(result.package.version, '1.27.0');
});

test('CC0 golden fixture set is deterministic and contains one selected page', async () => {
  const committed = JSON.parse(await readFile(path.join(fixtureDir, 'golden.json'), 'utf8'));
  assert.equal(committed.license, 'CC0-1.0');
  assert.equal(committed.fixtures.length, 3);
  assert.equal(committed.fixtures.filter((fixture) => fixture.selectedForSpike).length, 1);
  await readFile(path.join(fixtureDir, 'LICENSE-CC0-1.0.txt'), 'utf8');

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'opds-ocr-fixtures-'));
  try {
    const generated = await createOcrFixtures(temporary);
    assert.deepEqual(generated, committed);
    for (const fixture of committed.fixtures) {
      const bytes = await readFile(path.join(temporary, fixture.file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
      const pdf = await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(), 1);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('committed macOS Phase A measurement contains validated OCR JSON', async () => {
  const measurement = JSON.parse(await readFile(
    path.join(projectDir, 'docs', 'ocr', 'phase-a', 'measurements', 'macos-arm64.json'),
    'utf8',
  ));
  assert.equal(assertOcrResultV1(measurement.result).schemaVersion, 1);
  assert.equal(measurement.fixture.unchangedAfterRun, true);
  assert.equal(measurement.accuracy.exactNormalizedMatch, true);
  assert.equal(measurement.cancellation.cancellation.method, 'worker.terminate');
  assert.equal(measurement.offline.vendoredAssetsChecksumVerified, true);
});

test('committed macOS memory remediation passes 10 recognition and cancellation cycles', async () => {
  const measurement = JSON.parse(await readFile(
    path.join(
      projectDir,
      'docs',
      'ocr',
      'phase-a',
      'measurements',
      'macos-arm64-remediation.json',
    ),
    'utf8',
  ));
  assert.equal(measurement.schemaVersion, 2);
  assert.equal(assertOcrResultV1(measurement.result).schemaVersion, 1);
  assert.equal(measurement.memory.repeatedCycles.recognition.length, 10);
  assert.equal(measurement.memory.repeatedCycles.cancellation.length, 10);
  assert.equal(measurement.memory.repeatedCycles.uniqueChildProcesses, 20);
  assert.equal(measurement.memory.repeatedCycles.bounded, true);
  assert.equal(measurement.resourceLifetime.onnxSessionsReleased, true);
  assert.equal(measurement.resourceLifetime.jobEnvelopeDropped, true);
  assert.equal(measurement.resourceLifetime.transferredBuffersDropped, true);
  assert.equal(measurement.resourceLifetime.eventListenersRemoved, true);
  assert.equal(measurement.resourceLifetime.duplicateModelInstances, false);
  assert.equal(measurement.isolation.boundary, 'native-child-process');
  assert.equal(measurement.accuracy.allRecognitionCyclesExact, true);
  assert.equal(measurement.cancellation.allTerminatedWorkers, true);
  assert.deepEqual(
    measurement.memory.checkpoints.afterRepeatedRecognitionAndCancellationCycles
      .activeOcrChildPids,
    [],
  );
  for (const checkpoint of [
    'processStart',
    'beforeModelInitialization',
    'afterModelInitialization',
    'afterOnePageInference',
    'immediatelyBeforeDisposal',
    'afterOcrEngineDisposal',
    'afterWorkerTermination2s',
    'afterWorkerTermination5s',
    'afterWorkerTermination30s',
    'afterRepeatedRecognitionAndCancellationCycles',
  ]) {
    assert.equal(Number.isFinite(measurement.memory.checkpoints[checkpoint].rssBytes), true);
  }
});

test('final macOS Phase A re-evaluation keeps memory bounded and the viewer responsive', async () => {
  const measurement = JSON.parse(await readFile(
    path.join(
      projectDir,
      'docs',
      'ocr',
      'phase-a',
      'measurements',
      'macos-arm64-final.json',
    ),
    'utf8',
  ));
  assert.equal(measurement.schemaVersion, 2);
  assert.equal(assertOcrResultV1(measurement.result).schemaVersion, 1);
  assert.equal(measurement.memory.repeatedCycles.recognition.length, 10);
  assert.equal(measurement.memory.repeatedCycles.cancellation.length, 10);
  assert.equal(measurement.memory.repeatedCycles.uniqueChildProcesses, 20);
  assert.equal(measurement.memory.repeatedCycles.bounded, true);
  assert.equal(measurement.accuracy.allRecognitionCyclesExact, true);
  assert.equal(measurement.cancellation.allTerminatedWorkers, true);
  assert.equal(measurement.viewerResponsiveness.ocrExactNormalizedMatch, true);
  assert.equal(measurement.viewerResponsiveness.allDuringRequestsSucceeded, true);
  assert.equal(measurement.viewerResponsiveness.allDuringRequestsCompletedBeforeOcr, true);
  assert.equal(measurement.viewerResponsiveness.responsiveWhileOcrActive, true);
  assert.deepEqual(measurement.viewerResponsiveness.activeOcrChildPidsAfterProbe, []);
  assert.equal(measurement.resourceLifetime.trueProcessLeakObserved, false);
  assert.equal(measurement.offline.externalNetworkRequestsRequired, false);
});

test('packaged macOS Phase A production-gate report is eligible', async () => {
  const measurement = JSON.parse(await readFile(
    path.join(
      projectDir,
      'docs',
      'ocr',
      'phase-a',
      'measurements',
      'macos-arm64-production-gate.json',
    ),
    'utf8',
  ));
  assert.equal(measurement.schemaVersion, 3);
  assert.equal(measurement.environment.debugBuild, false);
  assert.equal(measurement.memory.repeatedCycles.attributionStable, true);
  assert.deepEqual(validatePlatformReport(measurement), []);
});
