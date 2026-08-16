import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MACOS_PRODUCTION_GO,
  MACOS_PRODUCTION_NO_GO,
  evaluateMacosProductionReport,
} from './evaluate-ocr-phase-a-macos-report.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function job(index, type) {
  return {
    index,
    type,
    childPid: type === 'recognition' ? 1000 + index : 2000 + index,
    childExitStatus: 0,
    isolationBoundary: 'native-child-process',
    activeOcrChildPidsAfterSettle: [],
    exactNormalizedMatch: type === 'recognition' ? true : undefined,
    cancelled: type === 'cancellation' ? true : undefined,
    cancellationMethod: type === 'cancellation' ? 'worker.terminate' : undefined,
    resources: {
      offline: {
        policyEnforced: type === 'recognition',
        selfTestPassed: type === 'recognition',
      },
    },
  };
}

function passingReport() {
  const recognition = Array.from({ length: 10 }, (_, index) => job(index + 1, 'recognition'));
  const cancellation = Array.from({ length: 10 }, (_, index) => job(index + 1, 'cancellation'));
  return {
    schemaVersion: 3,
    measuredAt: '2026-08-16T00:00:00.000Z',
    environment: {
      platform: 'darwin',
      arch: 'arm64',
      buildKind: 'packaged-release',
      debugBuild: false,
    },
    gate: { memoryRemediationPass: true, platformValidated: 'darwin-arm64' },
    isolation: { boundary: 'native-child-process', oneJob: true },
    fixture: { unchangedAfterRun: true },
    result: {
      source: { kind: 'pdf-page' },
      engine: { provider: 'PaddleOCR' },
    },
    timing: { rasterMs: 1 },
    memory: {
      checkpoints: {
        processStart: { roles: { 'pdfium-worker': { rssBytes: 1 } } },
        afterRepeatedRecognitionAndCancellationCycles: { activeOcrChildPids: [] },
      },
      repeatedCycles: {
        bounded: true,
        attributionStable: true,
        recognition,
        cancellation,
        uniqueChildProcesses: 20,
        maximumSettledDeltaMiB: 12.73,
        finalRetainedDeltaMiB: 5.84,
        linearTrendMiBPerCycle: -0.35,
      },
    },
    accuracy: {
      allRecognitionCyclesExact: true,
      exactNormalizedMatch: true,
      editDistance: 0,
      normalizedActual: 'open pdf studio',
      normalizedExpected: 'open pdf studio',
    },
    cancellation: { allTerminatedWorkers: true },
    offline: {
      pass: true,
      externalNetworkRequestsRequired: false,
      sameOriginAssetGuard: true,
      allWorkerFetchesGuarded: true,
      externalBlockSelfTestPassed: true,
      vendoredAssetsChecksumVerified: true,
    },
    viewerResponsiveness: {
      responsiveWhileOcrActive: true,
      allDuringRequestsSucceeded: true,
      allDuringRequestsCompletedBeforeOcr: true,
      ocrExactNormalizedMatch: true,
      activeOcrChildPidsAfterProbe: [],
      baseline: [{ result: { engine: 'Raster (PDFium)' } }],
    },
    resourceLifetime: {
      liveJavaScriptReferencesDropped: true,
      jobEnvelopeDropped: true,
      onnxSessionsReleased: true,
      openCv: { resourcesReleased: true },
      imageBitmap: { closed: true },
      senderBufferDetached: true,
      transferredBuffersDropped: true,
      eventListenersRemoved: true,
      messagePorts: { closed: true },
      modelCache: { modelByteReferencesDropped: true },
      maximumAdapterInstancesPerChild: 1,
      duplicateModelInstances: false,
      staleResultRetentionPrevented: true,
      trueProcessLeakObserved: false,
    },
    packageSize: { builtOcrBytes: 1 },
  };
}

function passingArtifacts() {
  return {
    packagedApp: true,
    applicationArm64: true,
    packagedSidecarArm64: true,
    universalPackagingArchitectureChecked: true,
    modelAndDependencyChecksumsVerified: true,
    summary: { appBundle: 'Open PDF Studio.app' },
  };
}

test('macOS evaluator emits its distinct production GO without Windows or Linux reports', () => {
  const decision = evaluateMacosProductionReport(passingReport(), passingArtifacts());
  assert.equal(decision.classification, MACOS_PRODUCTION_GO);
  assert.equal(decision.scope, 'macos-arm64');
  assert.deepEqual(decision.failures, []);
  assert.equal(decision.productionTarget.windows, 'deferred-not-supported');
  assert.equal(decision.productionTarget.linux, 'deferred-not-supported');
  assert.equal(Object.values(decision.criteria).every(Boolean), true);
});

test('macOS evaluator fails every fixed production criterion independently', () => {
  const cases = [
    ['packagedReleaseApp', (report, artifacts) => { artifacts.packagedApp = false; }],
    ['macosArm64LiveExecution', (report) => { report.environment.arch = 'x64'; }],
    ['tenRecognitionCycles', (report) => { report.memory.repeatedCycles.recognition.pop(); }],
    ['tenCancellationCycles', (report) => { report.memory.repeatedCycles.cancellation.pop(); }],
    ['uniqueDisposableChildPerJob', (report) => {
      report.memory.repeatedCycles.cancellation[0].childPid =
        report.memory.repeatedCycles.recognition[0].childPid;
    }],
    ['noSurvivingChild', (report) => {
      report.memory.checkpoints.afterRepeatedRecognitionAndCancellationCycles
        .activeOcrChildPids = [1234];
    }],
    ['settledRetainedRssWithin32MiB', (report) => {
      report.memory.repeatedCycles.maximumSettledDeltaMiB = 32.01;
    }],
    ['growthWithin2MiBPerCycle', (report) => {
      report.memory.repeatedCycles.linearTrendMiBPerCycle = 2.01;
    }],
    ['exactGoldenFixtureText', (report) => { report.accuracy.normalizedActual = 'wrong'; }],
    ['offlineEnforcement', (report) => { report.offline.pass = false; }],
    ['staleResultRejection', (report) => {
      report.resourceLifetime.staleResultRetentionPrevented = false;
    }],
    ['viewerResponsiveness', (report) => {
      report.viewerResponsiveness.responsiveWhileOcrActive = false;
    }],
    ['resourceCleanup', (report) => { report.resourceLifetime.onnxSessionsReleased = false; }],
    ['modelAndDependencyChecksumVerification', (report, artifacts) => {
      artifacts.modelAndDependencyChecksumsVerified = false;
    }],
    ['validMacosSidecarArchitecture', (report, artifacts) => {
      artifacts.packagedSidecarArm64 = false;
    }],
    ['universalPackagingArchitectureChecked', (report, artifacts) => {
      artifacts.universalPackagingArchitectureChecked = false;
    }],
    ['pdfiumInitialization', (report) => {
      report.memory.checkpoints.processStart.roles['pdfium-worker'].rssBytes = 0;
    }],
    ['paddleOcrPrimaryEngine', (report) => { report.result.engine.provider = 'Tesseract'; }],
    ['basePlatformContract', (report) => { report.packageSize.builtOcrBytes = 0; }],
  ];

  for (const [criterion, mutate] of cases) {
    const report = passingReport();
    const artifacts = passingArtifacts();
    mutate(report, artifacts);
    const decision = evaluateMacosProductionReport(report, artifacts);
    assert.equal(decision.classification, MACOS_PRODUCTION_NO_GO, criterion);
    assert.equal(decision.criteria[criterion], false, criterion);
    assert.notDeepEqual(decision.failures, [], criterion);
  }
});

test('macOS evaluator rejects reports from another operating system', () => {
  const report = passingReport();
  report.environment.platform = 'linux';
  const decision = evaluateMacosProductionReport(report, passingArtifacts());
  assert.equal(decision.classification, MACOS_PRODUCTION_NO_GO);
  assert.equal(decision.criteria.macosArm64LiveExecution, false);
});

test('CI makes deferred live OCR gates advisory and keeps the macOS decision blocking', async () => {
  const workflow = await readFile(path.join(projectDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(
    workflow,
    /name: Run OCR Phase A gate \(Windows\)[\s\S]*?continue-on-error: true[\s\S]*?shell: pwsh/,
  );
  assert.match(
    workflow,
    /name: Run OCR Phase A gate \(Linux AppImage\)[\s\S]*?continue-on-error: true[\s\S]*?shell: bash/,
  );
  assert.match(
    workflow,
    /name: Evaluate macOS OCR production decision[\s\S]*?evaluate-ocr-phase-a-macos-report\.mjs/,
  );
  assert.match(
    workflow,
    /name: OCR Phase A all-desktop future qualification \(advisory\)[\s\S]*?continue-on-error: true/,
  );
});
