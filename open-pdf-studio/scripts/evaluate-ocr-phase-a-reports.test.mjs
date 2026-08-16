import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_GO,
  PRODUCTION_NO_GO,
  evaluateProductionReports,
  validatePlatformReport,
} from './evaluate-ocr-phase-a-reports.mjs';

function passingReport(platform, arch = 'x64') {
  const recognition = Array.from({ length: 10 }, (_, index) => ({ index }));
  const cancellation = Array.from({ length: 10 }, (_, index) => ({ index }));
  return {
    schemaVersion: 3,
    measuredAt: '2026-08-15T00:00:00.000Z',
    environment: { platform, arch, buildKind: 'packaged-release', debugBuild: false },
    fixture: { unchangedAfterRun: true },
    memory: {
      checkpoints: {
        afterRepeatedRecognitionAndCancellationCycles: { activeOcrChildPids: [] },
      },
      repeatedCycles: {
        bounded: true,
        attributionStable: true,
        recognition,
        cancellation,
        uniqueChildProcesses: 20,
        finalRetainedDeltaMiB: 12,
        linearTrendMiBPerCycle: 0.1,
      },
    },
    resourceLifetime: {
      onnxSessionsReleased: true,
      transferredBuffersDropped: true,
      eventListenersRemoved: true,
      duplicateModelInstances: false,
      trueProcessLeakObserved: false,
    },
    accuracy: { allRecognitionCyclesExact: true },
    cancellation: { allTerminatedWorkers: true },
    offline: {
      pass: true,
      allWorkerFetchesGuarded: true,
      externalBlockSelfTestPassed: true,
    },
    viewerResponsiveness: { responsiveWhileOcrActive: true },
    packageSize: { builtOcrBytes: 1 },
    gate: { memoryRemediationPass: true },
  };
}

test('production evaluator requires a passing live report from every desktop OS', () => {
  const decision = evaluateProductionReports([
    passingReport('darwin', 'arm64'),
    passingReport('win32'),
    passingReport('linux'),
  ]);
  assert.equal(decision.classification, PRODUCTION_GO);
  assert.deepEqual(decision.failures, []);
});

test('production evaluator cannot promote a partial platform matrix', () => {
  const decision = evaluateProductionReports([passingReport('darwin', 'arm64')]);
  assert.equal(decision.classification, PRODUCTION_NO_GO);
  assert.match(decision.failures.join('\n'), /win32: live report is missing/);
  assert.match(decision.failures.join('\n'), /linux: live report is missing/);
});

test('platform validation rejects an unbounded or non-offline run', () => {
  const report = passingReport('linux');
  report.memory.repeatedCycles.bounded = false;
  report.offline.externalBlockSelfTestPassed = false;
  assert.deepEqual(validatePlatformReport(report), [
    'repeated-cycle memory is not bounded',
    'offline block self-test failed',
  ]);
});

test('platform validation rejects a misleading large negative memory delta', () => {
  const report = passingReport('darwin', 'arm64');
  report.memory.repeatedCycles.attributionStable = false;
  assert.deepEqual(validatePlatformReport(report), [
    'memory process attribution is unstable',
  ]);
});

test('platform validation rejects a debug-build report', () => {
  const report = passingReport('darwin', 'arm64');
  report.environment.buildKind = 'debug';
  report.environment.debugBuild = true;
  assert.deepEqual(validatePlatformReport(report), [
    'gate did not identify a packaged release build',
    'gate did not run against a release/package build',
  ]);
});

test('platform validation rejects an unknown external executable', () => {
  const report = passingReport('linux');
  report.environment.buildKind = 'external';
  assert.deepEqual(validatePlatformReport(report), [
    'gate did not identify a packaged release build',
  ]);
});
