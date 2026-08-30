import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateBranchProtection,
  evaluateBranchProtectionWithFallback,
} from './evaluate-github-branch-protection.mjs';
import {
  evaluateReleaseContext,
  evaluateReleaseHardening as evaluateReleaseHardeningCore,
  loadEvidence,
  validateRequiredJobResults,
  validateWorktreeState,
  validatedExpectedHead,
} from './evaluate-ocr-release-hardening.mjs';
import {
  AUTHORITATIVE_RELEASE_CONTEXT_CONTRACT,
  EDITOR_COVERAGE_DIMENSIONS,
  EDITOR_COVERAGE_MANIFEST_CONTRACT,
  FINDING_IDS,
  MACOS_ARTIFACT_REQUIRED_CRITERIA,
  MACOS_FILESYSTEM_ADVISORY_CRITERIA,
  MACOS_FILESYSTEM_BLOCKING_CRITERIA,
  MACOS_HARDENING_REQUIRED_ARTIFACTS,
  MACOS_OCR_PRODUCTION_REQUIRED_CRITERIA,
  PACKAGED_ADVERSARIAL_REQUIRED_CASES,
  PACKAGED_EDITOR_REQUIRED_SUITES,
  PERFORMANCE_THRESHOLDS,
  RELEASE_GO,
  RELEASE_NO_GO,
  REQUIRED_BROWSER_ACCEPTANCE_SUITES,
  REQUIRED_CHECK_NAMES,
  REQUIRED_GATE_IDS,
  REQUIRED_UPSTREAM_JOB_IDS,
  portableArtifactPath,
} from './ocr-release-hardening-policy.mjs';
import { evaluateEditorPerformanceReport } from './verify-editor-performance-report.mjs';
import { writeGateEvidence } from './write-release-gate-evidence.mjs';
import {
  BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
  BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
} from './browser-editor-acceptance-manifest.mjs';

const HEAD = '1401961154d4e689a90f7ce8c76b91961ba80b0b';
const CLEAN_WORKTREE = Object.freeze({ clean: true, dirtyPathCount: 0 });
const REPOSITORY = 'OpenAEC-Foundation/open-pdf-studio';

function authoritativeReleaseContext(overrides = {}) {
  const pullRequestNumber = overrides.pullRequestNumber ?? 42;
  const repository = overrides.repository ?? REPOSITORY;
  const baseRef = overrides.baseRef ?? 'main';
  const headRef = overrides.headRef ?? 'ocr-release-hardening';
  return {
    mode: 'github-actions',
    eventName: 'pull_request',
    baseRef,
    headRef,
    githubRef: `refs/pull/${pullRequestNumber}/merge`,
    repository,
    eventPayload: {
      number: pullRequestNumber,
      repository: { full_name: repository },
      pull_request: {
        state: 'open',
        base: { ref: baseRef, repo: { full_name: repository } },
        head: { ref: headRef },
      },
    },
    ...overrides,
  };
}

function evaluateReleaseHardening(reports, options = {}) {
  return evaluateReleaseHardeningCore(reports, {
    releaseContext: authoritativeReleaseContext(),
    ...options,
  });
}

function source(name, value) {
  return { path: `/evidence/${name}.json`, value };
}

function passingMetrics() {
  return {
    typingToPaintP95Ms: 15.99,
    warmExactValidationMs: 99.99,
    maxOrdinaryTypingTaskMs: 49.99,
    activeExactLayoutTasks: 1,
    idlePlacementReads: 0,
    idlePlacementWrites: 0,
    historyEntries: 100,
    historyApproxBytes: 12 * 1024 * 1024,
    ocrUiPublicationHz: 10,
    ocrBookkeepingCpuPercent: 0.99,
    ocrProgressMonotonic: true,
    lateOcrPublicationAfterCancel: false,
  };
}

function passingCoverageManifest() {
  const artifact = 'editor-matrix-evidence.json';
  return {
    contract: EDITOR_COVERAGE_MANIFEST_CONTRACT,
    schemaVersion: 1,
    status: 'PASS',
    head: HEAD,
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    artifacts: [artifact],
    matrixCases: EDITOR_COVERAGE_DIMENSIONS.editorFamilies.flatMap((editorFamily) =>
      EDITOR_COVERAGE_DIMENSIONS.viewModes.flatMap((viewMode) =>
        EDITOR_COVERAGE_DIMENSIONS.rotations.flatMap((rotation) =>
          EDITOR_COVERAGE_DIMENSIONS.zoomPercents.flatMap((zoomPercent) =>
            EDITOR_COVERAGE_DIMENSIONS.themes.map((theme) => ({
              editorFamily, viewMode, rotation, zoomPercent, theme, status: 'PASS', artifact,
            })))))),
    lifecycleCases: EDITOR_COVERAGE_DIMENSIONS.editorFamilies.flatMap((editorFamily) =>
      EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios.map((scenario) => ({
        editorFamily, scenario, status: 'PASS', artifact,
      }))),
  };
}

function passingApplicationControllerPerformance(measuredPageCount, {
  requestedPrefetches = Math.max(0, measuredPageCount - 1),
} = {}) {
  const stageSources = {
    rasterization: 'rasterMs',
    childStartup: 'childStartupMs',
    modelStartup: 'modelStartupMs',
    inference: 'detectionMs + recognitionMs',
    detection: 'detectionMs',
    recognition: 'recognitionMs',
    validation: 'validationMs',
    apply: 'applyMs',
    totalOcr: 'totalOcrMs',
  };
  const stages = Object.fromEntries(Object.entries(stageSources).map(([name, source]) => [name, {
    source,
    samples: measuredPageCount,
    totalMs: measuredPageCount,
    meanMs: 1,
    medianMs: 1,
    p95Ms: 1,
    maxMs: 1,
  }]));
  return {
    contract: 'open-pdf-studio.ocr.application-performance',
    schemaVersion: 1,
    expectedPageCount: 100,
    measuredPageCount,
    pageCoverageComplete: measuredPageCount === 100,
    instrumentationAvailable: true,
    failedOpen: false,
    stageOrder: Object.keys(stageSources),
    stages,
    resourceLifecycle: {
      pageSamples: measuredPageCount,
      pagesWithLifecycle: measuredPageCount,
      lifecycleEvents: measuredPageCount * 8,
      pagesWithResources: measuredPageCount,
      instrumentationAvailable: true,
      failedOpen: false,
      cleanup: {
        jobEnvelopeDroppedPages: measuredPageCount,
        onnxSessionsReleasedPages: measuredPageCount,
        transferredBuffersDroppedPages: measuredPageCount,
        eventListenersRemovedPages: measuredPageCount,
        offlinePolicyEnforcedPages: measuredPageCount,
        offlineSelfTestPassedPages: measuredPageCount,
        duplicateModelInstancePages: 0,
        maximumAdapterInstances: 1,
      },
    },
    prefetch: {
      requested: requestedPrefetches,
      used: requestedPrefetches,
      discarded: 0,
      failed: 0,
      maxBuffered: requestedPrefetches > 0 ? 1 : 0,
      rasterMs: requestedPrefetches,
      bytesPrepared: requestedPrefetches * 4,
      bytesUsed: requestedPrefetches * 4,
      peakBufferedBytes: requestedPrefetches > 0 ? 4 : 0,
      boundedBuffer: true,
    },
  };
}

function passingOcrProductionPerformance() {
  const completionControllerPerformance = passingApplicationControllerPerformance(100);
  const cancellationControllerPerformance = passingApplicationControllerPerformance(55, {
    requestedPrefetches: 55,
  });
  return {
    contract: 'open-pdf-studio.ocr.production-100-page-qualification',
    schemaVersion: 1,
    status: 'PASS',
    head: HEAD,
    qualificationMode: 'full',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:30:00.000Z',
    platform: { operatingSystem: 'darwin', architecture: 'arm64' },
    appBinary: '/artifacts/Open PDF Studio.app/Contents/MacOS/open-pdf-studio',
    automation: {
      visibleProductionChain: [
        '#ep-recognize-text',
        '#ocr-recognition-form',
        'entire-document',
        'OcrWorkflowService',
        'OcrApplicationController',
        'native disposable child',
      ],
      genericPackagedUiAutomation: true,
      ocrStateInjectionUsed: false,
      unitControllerUsed: false,
      adapterDirectlyUsed: false,
      developmentOnlyOcrMcpEntryPointUsed: false,
      testOnlyOcrEntryPointUsed: false,
    },
    fixture: {
      generatedDynamically: true,
      generatedArtifactsCommitted: false,
      complete: { pageCount: 100, imageOnlyPages: 100, sha256: 'a'.repeat(64) },
      cancellation: { pageCount: 100, imageOnlyPages: 100, sha256: 'b'.repeat(64) },
    },
    completion: {
      status: 'PASS',
      serializedInference: true,
      childProcessesObserved: 100,
      childProcessesSurviving: 0,
      exactPageCounts: { completed: 100, skipped: 0, unsupported: 0, failed: 0, cancelled: 0 },
      progress: { monotonic: true, last: 100 },
      controllerPerformance: completionControllerPerformance,
      sourceOriginalPreserved: true,
      copy: { status: 'PASS' },
      saveReopen: { ownedPages: 100, renderingMode3StreamsPerPage: 1 },
      externalReaders: { pdfJs: 'PASS', pdfium: 'PASS' },
      cache: { payloads: 100, metadata: 100 },
      nativeJobTemp: { files: [] },
      staleOrGenerationTokenErrors: 0,
      memory: {
        baselineParentRssBytes: 1,
        peakParentRssBytes: 2,
        peakChildRssBytes: 1,
        settledParentRssBytes: 1,
      },
    },
    cancellation: {
      status: 'PASS',
      lateResultsApplied: false,
      childProcessesSurviving: 0,
      activeChildReaped: true,
      queuedPagesStopped: true,
      sourceOriginalPreserved: true,
      countsAtTerminal: { completed: 55, skipped: 0, unsupported: 0, failed: 0, cancelled: 45 },
      countsAfterSettling: { completed: 55, skipped: 0, unsupported: 0, failed: 0, cancelled: 45 },
      controllerPerformance: cancellationControllerPerformance,
      nativeJobTemp: { files: [] },
    },
    performance: {
      applicationController: completionControllerPerformance,
      cancellationApplicationController: cancellationControllerPerformance,
      workflowPublication: {
        instrumentationAvailable: true,
        uiSubscriberMounted: true,
        realClock: true,
        syntheticEvents: false,
        virtualTime: false,
        serviceOnly: false,
        failedOpen: false,
        maximumOrdinaryDeliveryHz: 10,
        bookkeepingCpuPercent: 0.99,
        clonedBytes: 1,
        latePublicationAfterCancel: false,
      },
    },
  };
}

function passingPerformanceInput(metrics = passingMetrics()) {
  const workflow = passingOcrProductionPerformance().performance.workflowPublication;
  return {
    contract: 'open-pdf-studio.editor-performance',
    schemaVersion: 1,
    gateId: 'macos-editor-ocr-performance',
    status: 'RUNNING',
    head: HEAD,
    artifacts: ['performance.json', 'app-stdout.log', 'app-stderr.log'],
    metrics,
    provenance: {
      editor: {
        execution: 'packaged-production-ui',
        realClock: true,
        virtualTime: false,
        serviceOnly: false,
        stateSeeding: false,
      },
      ocr: {
        sourceContract: 'open-pdf-studio.ocr.production-100-page-qualification',
        sourceHead: HEAD,
        execution: 'packaged-production-ui-native-ocr',
        ...Object.fromEntries([
          'instrumentationAvailable', 'uiSubscriberMounted', 'realClock', 'syntheticEvents',
          'virtualTime', 'serviceOnly', 'failedOpen',
        ].map((name) => [name, workflow[name]])),
      },
    },
    instrumentation: {
      editor: Object.fromEntries([
        'longTaskObserver', 'exactLayoutScheduler', 'editorLayoutStore', 'placementMetrics',
      ].map((name) => [name, { available: true, failedOpen: false }])),
    },
    measurements: { ocrProduction100Page: passingOcrProductionPerformance() },
  };
}

function passingReports() {
  const reports = REQUIRED_GATE_IDS
    .filter((gateId) => !['packaged-macos-editor-acceptance', 'macos-editor-ocr-performance'].includes(gateId))
    .map((gateId) => source(gateId, {
      contract: 'open-pdf-studio.release-gate-evidence',
      schemaVersion: 1,
      gateId,
      status: 'PASS',
      head: HEAD,
      testCommands: [`npm run ${gateId}`],
      artifacts: gateId === 'macos-ocr-release-hardening'
        ? [...MACOS_HARDENING_REQUIRED_ARTIFACTS]
        : undefined,
    }));
  reports.push(source('packaged-editor', {
    contract: 'open-pdf-studio.editor-packaged-acceptance',
    schemaVersion: 1,
    gateId: 'packaged-macos-editor-acceptance',
    status: 'PASS',
    head: HEAD,
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    browserAcceptance: {
      contract: BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
      schemaVersion: BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
      required: true,
      status: 'PASS',
      suites: REQUIRED_BROWSER_ACCEPTANCE_SUITES.map((name) => ({
        name, command: `npm run ${name}`, code: 0, signal: null, status: 'PASS',
        startedAt: '2026-08-30T12:00:00.000Z',
        completedAt: '2026-08-30T12:00:10.000Z',
      })),
      manifest: {
        contract: BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
        schemaVersion: BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
        status: 'PASS',
        head: HEAD,
        startedAt: '2026-08-30T12:00:00.000Z',
        completedAt: '2026-08-30T12:01:00.000Z',
        suites: REQUIRED_BROWSER_ACCEPTANCE_SUITES.map((name) => ({
          name, command: `npm run ${name}`, code: 0, signal: null, status: 'PASS',
          startedAt: '2026-08-30T12:00:00.000Z',
          completedAt: '2026-08-30T12:00:10.000Z',
        })),
      },
    },
    editorCoverage: {
      status: 'PASS',
      artifactEvidenceValidated: true,
      issues: [],
      manifest: passingCoverageManifest(),
    },
    packagedApp: {
      bundlePath: '/artifacts/Open PDF Studio.app',
      executablePath: '/artifacts/Open PDF Studio.app/Contents/MacOS/open-pdf-studio',
    },
    suites: PACKAGED_EDITOR_REQUIRED_SUITES.map((name) => ({ name, code: 0 })),
    artifacts: PACKAGED_EDITOR_REQUIRED_SUITES.map(
      (name) => `logs/${name.replaceAll(':', '-')}.log`,
    ),
  }));
  reports.push(source('performance', evaluateEditorPerformanceReport(passingPerformanceInput())));
  reports.push(source('annotation-text-child', {
    contract: 'open-pdf-studio.annotation-text-packaged-acceptance',
    schemaVersion: 1,
    status: 'PASS',
    head: HEAD,
  }));
  reports.push(source('repository-controls', {
    contract: 'open-pdf-studio.repository-controls',
    schemaVersion: 1,
    gateId: 'repository-controls',
    status: 'PASS',
    repository: 'OpenAEC-Foundation/open-pdf-studio',
    branch: 'main',
    criteria: {
      repositoryIdentified: true,
      mainBranchProtected: true,
      upToDateBranchRequired: true,
      approvingReviewRequired: true,
      exactRequiredChecksConfigured: true,
    },
    requiredChecks: [...REQUIRED_CHECK_NAMES],
    configuredChecks: [...REQUIRED_CHECK_NAMES],
    missingChecks: [],
    unexpectedChecks: [],
  }));
  reports.push(source('macos-artifact', {
    contract: 'open-pdf-studio.macos-release-hardening',
    schemaVersion: 1,
    head: HEAD,
    platform: { os: 'darwin', architecture: 'arm64' },
    appPath: '/artifacts/Open PDF Studio.app',
    criteria: {
      ...Object.fromEntries(MACOS_ARTIFACT_REQUIRED_CRITERIA.map((name) => [name, { status: 'PASS' }])),
      arm64AppPackaging: {
        status: 'PASS',
        bundleIdentifier: 'org.openaec.openpdfstudio',
        version: '1.85.0',
        appArchitectures: ['arm64'],
      },
      codeSigningValidation: { status: 'PASS', signatureKind: 'ad-hoc', hardenedRuntime: true },
      developerIdSigning: { status: 'UNVERIFIED' },
      notarization: { status: 'UNVERIFIED' },
      gatekeeperAssessment: { status: 'UNVERIFIED' },
      quarantineDownloadStyleLaunch: { status: 'UNVERIFIED' },
    },
  }));
  reports.push(source('macos-filesystem', {
    contract: 'open-pdf-studio.macos-filesystem-edge-cases',
    schemaVersion: 1,
    head: HEAD,
    overallStatus: 'PASS',
    platform: { os: 'darwin', architecture: 'arm64' },
    appPath: '/artifacts/Open PDF Studio.app',
    criteria: {
      ...Object.fromEntries(MACOS_FILESYSTEM_BLOCKING_CRITERIA.map((name) => [name, { status: 'PASS' }])),
      ...Object.fromEntries(MACOS_FILESYSTEM_ADVISORY_CRITERIA.map((name) => [name, { status: 'PASS' }])),
    },
  }));
  reports.push(source('macos-ocr-production', {
    contract: 'open-pdf-studio.ocr-macos-production-decision',
    schemaVersion: 1,
    head: HEAD,
    scope: 'macos-arm64',
    classification: 'MACOS PRODUCTION GO',
    productionTarget: { platform: 'darwin', architecture: 'arm64' },
    criteria: Object.fromEntries(MACOS_OCR_PRODUCTION_REQUIRED_CRITERIA.map((name) => [name, true])),
    failures: [],
    evidence: {
      platform: 'darwin',
      architecture: 'arm64',
      buildKind: 'packaged-release',
      recognitionCycles: 10,
      cancellationCycles: 10,
      uniqueChildProcesses: 20,
      engine: 'PaddleOCR',
      artifacts: {
        applicationArchitectures: ['arm64'],
        packagedSidecarArchitectures: ['arm64'],
        checksumVerification: {
          models: 3,
          runtimeAssets: 2,
          dependency: { integrity: 'sha512-test' },
        },
      },
    },
  }));
  reports.push(source('macos-ocr-adversarial', {
    contract: 'open-pdf-studio.ocr.adversarial-packaged-qualification',
    schemaVersion: 1,
    head: HEAD,
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:10:00.000Z',
    status: 'PASS',
    platform: { operatingSystem: 'darwin', architecture: 'arm64' },
    appBinary: '/artifacts/Open PDF Studio.app/Contents/MacOS/open-pdf-studio',
    automation: {
      visibleProductionAction: '#ep-recognize-text',
      genericPackagedUiAutomation: true,
      developmentOnlyOcrMcpEntryPointUsed: false,
      testOnlyOcrEntryPointUsed: false,
    },
    cases: Object.fromEntries(PACKAGED_ADVERSARIAL_REQUIRED_CASES.map((name) => [name, {
      status: 'PASS',
      expectedResult: 'failed-safely',
      actualResult: 'failed-safely',
      originalPreserved: true,
      partialOwnedStream: false,
      childProcessesSurviving: 0,
      cache: { payloads: 0, metadata: 0, temporary: [] },
      nativeJobTemp: { files: [] },
    }])),
    error: null,
  }));
  return reports;
}

test('release acceptance enumerates every audit finding and emits the exact GO wording', () => {
  const result = evaluateReleaseHardening(passingReports(), {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(result.decision, RELEASE_GO);
  assert.equal(result.releaseContext.contract, AUTHORITATIVE_RELEASE_CONTEXT_CONTRACT);
  assert.equal(result.releaseContext.status, 'PASS');
  assert.equal(result.releaseContext.authoritative, true);
  assert.equal(result.releaseContext.eventPayloadValidated, true);
  assert.equal(result.releaseContext.pullRequestNumber, 42);
  assert.deepEqual(Object.keys(result.findings), FINDING_IDS);
  assert.equal(Object.values(result.findings).every((finding) => finding.status === 'PASS'), true);
  assert.equal(result.packagedApp.bundleIdentifier, 'org.openaec.openpdfstudio');
  assert.equal(result.packagedApp.bundlePath, 'Open PDF Studio.app');
  assert.equal(result.packagedApp.signatureKind, 'ad-hoc');
  assert.equal(result.distributionTrust.status, 'NOT_CLAIMED');
  assert.match(result.distributionTrust.note, /not Developer ID signing or notarization evidence/u);
  assert.equal(result.findings['H-10'].evidence.includes('macos-artifact.json'), true);
  assert.equal(result.findings['H-10'].evidence.includes('macos-filesystem.json'), true);
  assert.equal(result.findings['H-10'].evidence.includes('macos-ocr-production.json'), true);
  assert.equal(result.findings['H-10'].evidence.includes('macos-ocr-adversarial.json'), true);
  assert.equal(result.artifacts.every(portableArtifactPath), true);
});

test('release context fails closed unless an open pull request targets main', () => {
  const absent = evaluateReleaseHardeningCore(passingReports(), {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(absent.decision, RELEASE_NO_GO);
  assert.equal(absent.releaseContext.status, 'FAIL');
  assert.equal(absent.releaseContext.authoritative, false);
  assert.equal(absent.evidenceErrors.some(({ path: value }) => value === 'release-context'), true);

  const localDiagnostic = evaluateReleaseHardeningCore(passingReports(), {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
    releaseContext: { mode: 'local-diagnostic' },
  });
  assert.equal(localDiagnostic.decision, RELEASE_NO_GO);
  assert.equal(localDiagnostic.releaseContext.mode, 'local-diagnostic');
  assert.match(localDiagnostic.releaseContext.issues.join(' '), /not an authoritative release context/u);

  const invalidContexts = [
    ['push event', authoritativeReleaseContext({ eventName: 'push' }), /release event must be pull_request/u],
    ['wrong base', authoritativeReleaseContext({ baseRef: 'release' }), /base ref must be main/u],
    ['missing payload', { ...authoritativeReleaseContext(), eventPayload: null }, /event payload is missing/u],
    ['closed pull request', {
      ...authoritativeReleaseContext(),
      eventPayload: {
        ...authoritativeReleaseContext().eventPayload,
        pull_request: {
          ...authoritativeReleaseContext().eventPayload.pull_request,
          state: 'closed',
        },
      },
    }, /must be open/u],
    ['mismatched pull request number', {
      ...authoritativeReleaseContext(),
      eventPayload: { ...authoritativeReleaseContext().eventPayload, number: 43 },
    }, /number does not match/u],
  ];
  for (const [description, releaseContext, expectedIssue] of invalidContexts) {
    const result = evaluateReleaseHardeningCore(passingReports(), {
      expectedHead: HEAD,
      worktreeState: CLEAN_WORKTREE,
      releaseContext,
    });
    assert.equal(result.decision, RELEASE_NO_GO, description);
    assert.equal(result.releaseContext.status, 'FAIL', description);
    assert.match(result.releaseContext.issues.join(' '), expectedIssue, description);
  }
});

test('release context cross-checks the GitHub repository and pull request payload', () => {
  const result = evaluateReleaseContext(authoritativeReleaseContext(), {
    expectedRepository: REPOSITORY,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.repository, REPOSITORY);

  const wrongRepository = evaluateReleaseContext(authoritativeReleaseContext({
    repository: 'someone/another-repository',
  }), { expectedRepository: REPOSITORY });
  assert.equal(wrongRepository.status, 'FAIL');
  assert.match(wrongRepository.issues.join(' '), /does not match OpenAEC-Foundation/u);
});

test('missing repository controls fail RB-05 and the release decision closed', () => {
  const reports = passingReports().filter(({ value }) => value.gateId !== 'repository-controls');
  const result = evaluateReleaseHardening(reports, { expectedHead: HEAD });
  assert.equal(result.decision, RELEASE_NO_GO);
  assert.equal(result.findings['RB-05'].status, 'FAIL');
  assert.deepEqual(result.findings['RB-05'].failedGates, ['repository-controls']);
  assert.equal(result.repositoryControls.externalConfiguration, true);
});

test('repository controls require producer criteria and the expected repository identity', () => {
  const incompleteReports = passingReports();
  delete incompleteReports.find(
    ({ value }) => value.gateId === 'repository-controls',
  ).value.criteria.repositoryIdentified;
  const incomplete = evaluateReleaseHardening(incompleteReports, {
    expectedHead: HEAD,
    expectedRepository: 'OpenAEC-Foundation/open-pdf-studio',
  });
  assert.equal(incomplete.decision, RELEASE_NO_GO);
  assert.match(
    incomplete.gates['repository-controls'].invalidSources[0].issues.join(' '),
    /repositoryIdentified/u,
  );

  const wrongRepositoryReports = passingReports();
  wrongRepositoryReports.find(
    ({ value }) => value.gateId === 'repository-controls',
  ).value.repository = 'someone/another-repository';
  const wrongRepository = evaluateReleaseHardening(wrongRepositoryReports, {
    expectedHead: HEAD,
    expectedRepository: 'OpenAEC-Foundation/open-pdf-studio',
  });
  assert.equal(wrongRepository.decision, RELEASE_NO_GO);
  assert.match(
    wrongRepository.gates['repository-controls'].invalidSources[0].issues.join(' '),
    /not OpenAEC-Foundation\/open-pdf-studio/u,
  );

  const extraCheckReports = passingReports();
  const extraCheckControls = extraCheckReports.find(
    ({ value }) => value.gateId === 'repository-controls',
  ).value;
  extraCheckControls.configuredChecks.push('Unrelated legacy check');
  extraCheckControls.unexpectedChecks.push('Unrelated legacy check');
  const extraCheck = evaluateReleaseHardening(extraCheckReports, {
    expectedHead: HEAD,
    expectedRepository: 'OpenAEC-Foundation/open-pdf-studio',
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(extraCheck.decision, RELEASE_NO_GO);
  assert.match(
    extraCheck.gates['repository-controls'].invalidSources[0].issues.join(' '),
    /exactly the required check set|unexpected required checks/u,
  );
});

test('missing or stale required evidence cannot satisfy a finding', () => {
  const missing = evaluateReleaseHardening(
    passingReports().filter(({ value }) => value.gateId !== 'packaged-macos-editor-acceptance'),
    { expectedHead: HEAD },
  );
  assert.equal(missing.decision, RELEASE_NO_GO);
  assert.equal(missing.gates['packaged-macos-editor-acceptance'].status, 'FAIL');
  assert.equal(missing.findings['RB-01'].status, 'FAIL');

  const staleReports = passingReports();
  staleReports.find(({ value }) => value.gateId === 'static-verification').value.head = 'stale';
  const stale = evaluateReleaseHardening(staleReports, { expectedHead: HEAD });
  assert.equal(stale.decision, RELEASE_NO_GO);
  assert.notDeepEqual(stale.gates['static-verification'].staleSources, []);
});

test('an explicit expected HEAD cannot override the checked-out HEAD', () => {
  assert.equal(validatedExpectedHead(HEAD, HEAD), HEAD);
  assert.throws(
    () => validatedExpectedHead('2401961154d4e689a90f7ce8c76b91961ba80b0b', HEAD),
    /does not match checked-out HEAD/u,
  );
  assert.throws(() => validatedExpectedHead('', 'short'), /not a full Git object ID/u);
});

test('required upstream CI job outcomes fail the final decision closed', () => {
  assert.deepEqual(validateRequiredJobResults(
    REQUIRED_UPSTREAM_JOB_IDS.map((name) => `${name}=success`),
  ), []);
  const partial = validateRequiredJobResults(['static-verification=success']);
  assert.equal(partial.length, REQUIRED_UPSTREAM_JOB_IDS.length - 1);
  assert.match(partial.map(({ error }) => error).join(' '), /required job result is missing/u);
  const errors = validateRequiredJobResults([
    'static-verification=failure',
    'build=cancelled',
    'packaged-macos-editor-acceptance=skipped',
    'save-render-coherence-report-verification=success',
    'macos-editor-ocr-performance=success',
    'malformed',
  ]);
  assert.equal(errors.length, 4);
  const result = evaluateReleaseHardening(passingReports(), {
    expectedHead: HEAD,
    evidenceErrors: errors,
  });
  assert.equal(result.decision, RELEASE_NO_GO);
  assert.match(result.evidenceErrors.map(({ error }) => error).join(' '), /failure.*cancelled.*skipped.*invalid/u);
});

test('dirty source provenance cannot emit a release GO for baseline HEAD', () => {
  assert.deepEqual(validateWorktreeState({ clean: true, dirtyPathCount: 0 }), []);
  const errors = validateWorktreeState({ clean: false, dirtyPathCount: 7 });
  const result = evaluateReleaseHardening(passingReports(), {
    expectedHead: HEAD,
    evidenceErrors: errors,
    worktreeState: { clean: false, dirtyPathCount: 7 },
  });
  assert.equal(result.decision, RELEASE_NO_GO);
  assert.equal(result.sourceProvenance.worktreeClean, false);
  assert.equal(result.sourceProvenance.dirtyPathCount, 7);
  assert.match(result.evidenceErrors[0].error, /dirty worktree \(7 paths\)/u);
});

test('missing source provenance cannot emit a release GO through the reusable evaluator', () => {
  const result = evaluateReleaseHardening(passingReports(), { expectedHead: HEAD });
  assert.equal(result.decision, RELEASE_NO_GO);
  assert.equal(result.sourceProvenance.worktreeClean, null);
  assert.match(result.evidenceErrors.map(({ error }) => error).join(' '), /worktree state is unavailable/u);
});

test('wrong contracts, missing HEAD, and incomplete packaged suites fail closed', () => {
  const wrongContractReports = passingReports();
  const wrongContract = wrongContractReports.find(({ value }) => value.gateId === 'static-verification');
  wrongContract.value.contract = 'open-pdf-studio.editor-packaged-acceptance';
  const wrongContractResult = evaluateReleaseHardening(wrongContractReports, { expectedHead: HEAD });
  assert.equal(wrongContractResult.decision, RELEASE_NO_GO);
  assert.match(
    wrongContractResult.gates['static-verification'].invalidSources[0].issues.join(' '),
    /contract must be/u,
  );

  const missingHeadReports = passingReports();
  delete missingHeadReports.find(({ value }) => value.gateId === 'desktop-build-macos-26').value.head;
  const missingHeadResult = evaluateReleaseHardening(missingHeadReports, { expectedHead: HEAD });
  assert.equal(missingHeadResult.decision, RELEASE_NO_GO);
  assert.match(
    missingHeadResult.gates['desktop-build-macos-26'].invalidSources[0].issues.join(' '),
    /HEAD is missing/u,
  );

  const incompletePackagedReports = passingReports();
  incompletePackagedReports.find(({ value }) => value.gateId === 'packaged-macos-editor-acceptance').value.suites.pop();
  const incompletePackaged = evaluateReleaseHardening(incompletePackagedReports, { expectedHead: HEAD });
  assert.equal(incompletePackaged.decision, RELEASE_NO_GO);
  assert.match(
    incompletePackaged.gates['packaged-macos-editor-acceptance'].invalidSources[0].issues.join(' '),
    /did not pass in the packaged aggregate/u,
  );

  const invalidPerformanceReports = passingReports();
  delete invalidPerformanceReports.find(({ value }) => value.gateId === 'macos-editor-ocr-performance')
    .value.schemaVersion;
  const invalidPerformance = evaluateReleaseHardening(invalidPerformanceReports, { expectedHead: HEAD });
  assert.equal(invalidPerformance.decision, RELEASE_NO_GO);
  assert.equal(invalidPerformance.performance.status, 'FAIL');
  assert.match(invalidPerformance.performance.evidenceIssues.join(' '), /schemaVersion must be 1/u);
});

test('missing artifacts and duplicate or spoofed suite results fail closed', () => {
  const missingGateArtifactReports = passingReports();
  missingGateArtifactReports.find(
    ({ value }) => value.gateId === 'macos-ocr-release-hardening',
  ).value.artifacts.pop();
  const missingGateArtifact = evaluateReleaseHardening(missingGateArtifactReports, { expectedHead: HEAD });
  assert.equal(missingGateArtifact.decision, RELEASE_NO_GO);
  assert.match(
    missingGateArtifact.gates['macos-ocr-release-hardening'].invalidSources[0].issues.join(' '),
    /required artifact is missing/u,
  );

  const missingPackagedArtifactReports = passingReports();
  missingPackagedArtifactReports.find(
    ({ value }) => value.gateId === 'packaged-macos-editor-acceptance',
  ).value.artifacts.pop();
  const missingPackagedArtifact = evaluateReleaseHardening(
    missingPackagedArtifactReports,
    { expectedHead: HEAD },
  );
  assert.equal(missingPackagedArtifact.decision, RELEASE_NO_GO);
  assert.match(
    missingPackagedArtifact.gates['packaged-macos-editor-acceptance']
      .invalidSources[0].issues.join(' '),
    /required artifact is missing/u,
  );

  const duplicateSuiteReports = passingReports();
  const duplicateGate = duplicateSuiteReports.find(
    ({ value }) => value.gateId === 'packaged-macos-editor-acceptance',
  ).value;
  duplicateGate.suites[1] = structuredClone(duplicateGate.suites[0]);
  duplicateGate.suites[0].status = 'FAIL';
  const duplicateSuite = evaluateReleaseHardening(duplicateSuiteReports, { expectedHead: HEAD });
  assert.equal(duplicateSuite.decision, RELEASE_NO_GO);
  assert.match(
    duplicateSuite.gates['packaged-macos-editor-acceptance'].invalidSources[0].issues.join(' '),
    /duplicate entry|did not pass/u,
  );
});

test('failed browser acceptance and incomplete editor coverage cannot be reported as packaged PASS', () => {
  const browserReports = passingReports();
  const browserGate = browserReports.find(
    ({ value }) => value.gateId === 'packaged-macos-editor-acceptance',
  ).value;
  browserGate.browserAcceptance.status = 'FAIL';
  browserGate.browserAcceptance.suites[0].status = 'FAIL';
  browserGate.browserAcceptance.manifest.suites[0].status = 'FAIL';
  browserGate.status = 'PASS';
  const browserResult = evaluateReleaseHardening(browserReports, { expectedHead: HEAD });
  assert.equal(browserResult.decision, RELEASE_NO_GO);
  assert.match(
    browserResult.gates['packaged-macos-editor-acceptance'].invalidSources[0].issues.join(' '),
    /supplemental browser acceptance did not pass/u,
  );

  const coverageReports = passingReports();
  const coverageGate = coverageReports.find(
    ({ value }) => value.gateId === 'packaged-macos-editor-acceptance',
  ).value;
  coverageGate.editorCoverage.manifest.matrixCases.pop();
  coverageGate.status = 'PASS';
  const coverageResult = evaluateReleaseHardening(coverageReports, { expectedHead: HEAD });
  assert.equal(coverageResult.decision, RELEASE_NO_GO);
  assert.match(
    coverageResult.gates['packaged-macos-editor-acceptance'].invalidSources[0].issues.join(' '),
    /coverage matrix case is missing/u,
  );

  const clickAwayReports = passingReports();
  const clickAwayGate = clickAwayReports.find(
    ({ value }) => value.gateId === 'packaged-macos-editor-acceptance',
  ).value;
  clickAwayGate.editorCoverage.manifest.lifecycleCases =
    clickAwayGate.editorCoverage.manifest.lifecycleCases.filter((entry) => !(
      entry.editorFamily === 'native-source-text' && entry.scenario === 'click-away-commit'
    ));
  clickAwayGate.status = 'PASS';
  const clickAwayResult = evaluateReleaseHardening(clickAwayReports, { expectedHead: HEAD });
  assert.equal(clickAwayResult.decision, RELEASE_NO_GO);
  assert.match(
    clickAwayResult.gates['packaged-macos-editor-acceptance'].invalidSources[0].issues.join(' '),
    /coverage lifecycle case is missing: native-source-text\|click-away-commit/u,
  );
});

test('synthetic, virtual, service-only, stale, or failed-open performance evidence is rejected', () => {
  for (const [description, mutate, expected] of [
    ['virtual time', (input) => {
      input.provenance.ocr.virtualTime = true;
      input.measurements.ocrProduction100Page.performance.workflowPublication.virtualTime = true;
    }, /virtualTime/u],
    ['service-only source', (input) => {
      input.provenance.ocr.serviceOnly = true;
      input.measurements.ocrProduction100Page.performance.workflowPublication.serviceOnly = true;
    }, /serviceOnly/u],
    ['synthetic events', (input) => {
      input.provenance.ocr.syntheticEvents = true;
      input.measurements.ocrProduction100Page.performance.workflowPublication.syntheticEvents = true;
    }, /syntheticEvents/u],
    ['stale OCR HEAD', (input) => {
      input.measurements.ocrProduction100Page.head = 'stale';
    }, /must match the editor performance HEAD/u],
    ['failed-open long tasks', (input) => {
      input.instrumentation.editor.longTaskObserver = { available: false, failedOpen: true };
    }, /longTaskObserver/u],
    ['missing fixture hash', (input) => {
      delete input.measurements.ocrProduction100Page.fixture.cancellation.sha256;
    }, /100 image-only pages/u],
    ['incomplete save and reopen proof', (input) => {
      delete input.measurements.ocrProduction100Page.completion.saveReopen;
    }, /completion evidence is incomplete/u],
    ['missing visible production chain', (input) => {
      input.measurements.ocrProduction100Page.automation.visibleProductionChain = [];
    }, /visible production chain/u],
    ['missing controller stage evidence', (input) => {
      delete input.measurements.ocrProduction100Page.performance.applicationController.stages.validation;
    }, /controller performance evidence is invalid/u],
    ['incomplete controller resource cleanup', (input) => {
      input.measurements.ocrProduction100Page.performance.applicationController
        .resourceLifecycle.cleanup.onnxSessionsReleasedPages = 99;
      input.measurements.ocrProduction100Page.completion.controllerPerformance
        .resourceLifecycle.cleanup.onnxSessionsReleasedPages = 99;
    }, /cleanup evidence is incomplete/u],
  ]) {
    const reports = passingReports();
    const input = passingPerformanceInput();
    mutate(input);
    const forged = evaluateEditorPerformanceReport(input);
    forged.status = 'PASS';
    reports.find(({ value }) => value.gateId === 'macos-editor-ocr-performance').value = forged;
    const result = evaluateReleaseHardening(reports, { expectedHead: HEAD });
    assert.equal(result.decision, RELEASE_NO_GO, description);
    assert.match(result.performance.evidenceIssues.join(' '), expected, description);
  }
});

test('performance thresholds preserve strict and inclusive boundaries', () => {
  const passing = evaluateEditorPerformanceReport(passingPerformanceInput());
  assert.equal(passing.status, 'PASS');
  assert.deepEqual(passing.evidenceIssues, []);
  assert.deepEqual(Object.keys(passing.criteria), Object.keys(PERFORMANCE_THRESHOLDS));

  for (const name of ['typingToPaintP95Ms', 'warmExactValidationMs', 'maxOrdinaryTypingTaskMs', 'ocrBookkeepingCpuPercent']) {
    const metrics = passingMetrics();
    metrics[name] = PERFORMANCE_THRESHOLDS[name].limit;
    const result = evaluateEditorPerformanceReport(passingPerformanceInput(metrics));
    assert.equal(result.criteria[name].status, 'FAIL', name);
  }

  const missing = evaluateEditorPerformanceReport(passingPerformanceInput({}));
  assert.equal(missing.status, 'FAIL');
  assert.equal(Object.values(missing.criteria).every((criterion) => criterion.status === 'FAIL'), true);
});

test('distribution trust is separate and becomes blocking only when requested', () => {
  const reports = passingReports();
  const ordinary = evaluateReleaseHardening(reports, {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(ordinary.decision, RELEASE_GO);
  assert.equal(ordinary.distributionTrust.status, 'NOT_CLAIMED');

  const distribution = evaluateReleaseHardening(reports, {
    expectedHead: HEAD,
    requireDistributionTrust: true,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(distribution.decision, RELEASE_NO_GO);
  assert.equal(distribution.distributionTrust.status, 'FAIL');
});

test('current generic evidence cannot replace the macOS artifact hardening report', () => {
  const missingArtifact = passingReports().filter(
    ({ value }) => value.contract !== 'open-pdf-studio.macos-release-hardening',
  );
  const missing = evaluateReleaseHardening(missingArtifact, { expectedHead: HEAD });
  assert.equal(missing.decision, RELEASE_NO_GO);
  assert.equal(missing.gates['macos-ocr-release-hardening'].status, 'FAIL');
  assert.match(missing.gates['macos-ocr-release-hardening'].reason, /artifact hardening evidence is missing/u);

  const unverifiedArtifact = passingReports();
  unverifiedArtifact.find(({ value }) => value.contract === 'open-pdf-studio.macos-release-hardening')
    .value.criteria.arm64AppPackaging.status = 'UNVERIFIED';
  const unverified = evaluateReleaseHardening(unverifiedArtifact, { expectedHead: HEAD });
  assert.equal(unverified.decision, RELEASE_NO_GO);
  assert.match(unverified.gates['macos-ocr-release-hardening'].reason, /did not all pass/u);

  for (const [contract, reason] of [
    ['open-pdf-studio.macos-filesystem-edge-cases', /filesystem edge-case evidence is missing/u],
    ['open-pdf-studio.ocr-macos-production-decision', /OCR production decision evidence is missing/u],
    ['open-pdf-studio.ocr.adversarial-packaged-qualification', /adversarial OCR evidence is missing/u],
  ]) {
    const reports = passingReports().filter(({ value }) => value.contract !== contract);
    const result = evaluateReleaseHardening(reports, { expectedHead: HEAD });
    assert.equal(result.decision, RELEASE_NO_GO);
    assert.match(result.gates['macos-ocr-release-hardening'].reason, reason);
  }

  const advisoryFilesystemReports = passingReports();
  advisoryFilesystemReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.macos-filesystem-edge-cases',
  ).value.criteria.externalVolumeFallbackAndOriginalPreservation.status = 'UNVERIFIED';
  advisoryFilesystemReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.macos-filesystem-edge-cases',
  ).value.criteria.icloudDriveProviderTransaction.status = 'UNVERIFIED';
  advisoryFilesystemReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.macos-filesystem-edge-cases',
  ).value.overallStatus = 'UNVERIFIED';
  const advisoryFilesystem = evaluateReleaseHardening(advisoryFilesystemReports, {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(advisoryFilesystem.decision, RELEASE_GO);
  assert.deepEqual(
    advisoryFilesystem.gates['macos-ocr-release-hardening'].supportingCriteria.filesystemEdgeCases,
    { reportedStatus: 'UNVERIFIED', blockingStatus: 'PASS', advisoryUnverifiedAllowed: true },
  );

  for (const contract of [
    'open-pdf-studio.macos-release-hardening',
    'open-pdf-studio.macos-filesystem-edge-cases',
    'open-pdf-studio.ocr-macos-production-decision',
    'open-pdf-studio.ocr.adversarial-packaged-qualification',
  ]) {
    const staleSupportingReports = passingReports();
    staleSupportingReports.find(({ value }) => value.contract === contract).value.head = 'stale';
    const staleSupporting = evaluateReleaseHardening(staleSupportingReports, { expectedHead: HEAD });
    assert.equal(staleSupporting.decision, RELEASE_NO_GO);
    assert.match(
      staleSupporting.gates['macos-ocr-release-hardening'].reason,
      /schema and HEAD validation/u,
    );
  }
});

test('supporting reports cannot claim GO with missing criteria or incomplete OCR provenance', () => {
  const missingArtifactCriterionReports = passingReports();
  delete missingArtifactCriterionReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.macos-release-hardening',
  ).value.criteria.temporaryArtifactCleanup;
  const missingArtifactCriterion = evaluateReleaseHardening(
    missingArtifactCriterionReports,
    { expectedHead: HEAD },
  );
  assert.equal(missingArtifactCriterion.decision, RELEASE_NO_GO);
  assert.match(
    missingArtifactCriterion.gates['macos-ocr-release-hardening']
      .invalidSupportingSources[0].issues.join(' '),
    /temporaryArtifactCleanup/u,
  );

  const blockingFilesystemUnverifiedReports = passingReports();
  const blockingFilesystem = blockingFilesystemUnverifiedReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.macos-filesystem-edge-cases',
  ).value;
  blockingFilesystem.criteria.permissionsLockedDestination.status = 'UNVERIFIED';
  blockingFilesystem.overallStatus = 'UNVERIFIED';
  const blockingFilesystemUnverified = evaluateReleaseHardening(
    blockingFilesystemUnverifiedReports,
    { expectedHead: HEAD },
  );
  assert.equal(blockingFilesystemUnverified.decision, RELEASE_NO_GO);
  assert.equal(
    blockingFilesystemUnverified.gates['macos-ocr-release-hardening']
      .supportingCriteria.filesystemEdgeCases.blockingStatus,
    'FAIL',
  );

  const incompleteOcrReports = passingReports();
  delete incompleteOcrReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.ocr-macos-production-decision',
  ).value.criteria.resourceCleanup;
  const incompleteOcr = evaluateReleaseHardening(incompleteOcrReports, { expectedHead: HEAD });
  assert.equal(incompleteOcr.decision, RELEASE_NO_GO);
  assert.match(
    incompleteOcr.gates['macos-ocr-release-hardening']
      .invalidSupportingSources[0].issues.join(' '),
    /resourceCleanup/u,
  );

  const incompleteAdversarialReports = passingReports();
  const incompleteAdversarialSource = incompleteAdversarialReports.find(
    ({ value }) => value.contract === 'open-pdf-studio.ocr.adversarial-packaged-qualification',
  );
  delete incompleteAdversarialSource.value.cases[PACKAGED_ADVERSARIAL_REQUIRED_CASES[0]];
  const incompleteAdversarial = evaluateReleaseHardening(incompleteAdversarialReports, {
    expectedHead: HEAD,
    worktreeState: CLEAN_WORKTREE,
  });
  assert.equal(incompleteAdversarial.decision, RELEASE_NO_GO);
  assert.match(
    incompleteAdversarial.gates['macos-ocr-release-hardening']
      .invalidSupportingSources[0].issues.join(' '),
    /exact required case set|case evidence is incomplete/u,
  );
});

test('branch protection evidence requires exact checks, strict updates, and an approval', () => {
  const protection = {
    required_status_checks: { strict: true, contexts: REQUIRED_CHECK_NAMES },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  };
  const passing = evaluateBranchProtection(protection, { repository: 'OpenAEC-Foundation/open-pdf-studio' });
  assert.equal(passing.status, 'PASS');
  assert.deepEqual(passing.missingChecks, []);
  assert.deepEqual(passing.unexpectedChecks, []);

  const missing = structuredClone(protection);
  missing.required_status_checks.contexts.pop();
  assert.equal(evaluateBranchProtection(missing, { repository: 'OpenAEC-Foundation/open-pdf-studio' }).status, 'FAIL');

  const nonStrict = structuredClone(protection);
  nonStrict.required_status_checks.strict = false;
  assert.equal(evaluateBranchProtection(nonStrict).criteria.upToDateBranchRequired, false);

  const extra = structuredClone(protection);
  extra.required_status_checks.contexts.push('Unrelated legacy check');
  const extraResult = evaluateBranchProtection(extra, {
    repository: 'OpenAEC-Foundation/open-pdf-studio',
  });
  assert.equal(extraResult.status, 'FAIL');
  assert.equal(extraResult.criteria.exactRequiredChecksConfigured, false);
  assert.deepEqual(extraResult.unexpectedChecks, ['Unrelated legacy check']);

  const rules = [
    {
      type: 'pull_request',
      parameters: { required_approving_review_count: 1 },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: REQUIRED_CHECK_NAMES.map((context) => ({ context })),
      },
    },
  ];
  const ruleset = evaluateBranchProtection(rules, { repository: 'OpenAEC-Foundation/open-pdf-studio' });
  assert.equal(ruleset.status, 'PASS');
  assert.match(ruleset.source, /active-rules-for-branch/u);

  const splitRuleset = evaluateBranchProtection([
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: REQUIRED_CHECK_NAMES.slice(0, 3).map((context) => ({ context })),
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: REQUIRED_CHECK_NAMES.slice(3).map((context) => ({ context })),
      },
    },
    { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
  ], { repository: 'OpenAEC-Foundation/open-pdf-studio' });
  assert.equal(splitRuleset.status, 'FAIL');
  assert.equal(splitRuleset.criteria.upToDateBranchRequired, false);
  assert.deepEqual(splitRuleset.missingChecks, []);
});

test('empty active rules require an explicit valid classic protection fallback', () => {
  const repository = 'OpenAEC-Foundation/open-pdf-studio';
  const classicProtection = {
    required_status_checks: { strict: true, contexts: REQUIRED_CHECK_NAMES },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  };

  const unavailable = evaluateBranchProtectionWithFallback([], { repository });
  assert.equal(unavailable.status, 'FAIL');
  assert.deepEqual(unavailable.fallback, {
    eligible: true,
    supplied: false,
    used: false,
    reason: 'classic-protection-fallback-not-supplied',
  });

  const passing = evaluateBranchProtectionWithFallback([], {
    classicProtection,
    repository,
  });
  assert.equal(passing.status, 'PASS');
  assert.equal(passing.fallback.used, true);
  assert.match(passing.source, /classic branch-protection API fallback/iu);
  assert.deepEqual(passing.missingChecks, []);
  assert.deepEqual(passing.unexpectedChecks, []);
  const releaseReports = passingReports();
  releaseReports.find(
    ({ value }) => value.gateId === 'repository-controls',
  ).value = passing;
  assert.equal(evaluateReleaseHardening(releaseReports, {
    expectedHead: HEAD,
    expectedRepository: repository,
    worktreeState: CLEAN_WORKTREE,
  }).decision, RELEASE_GO);

  for (const malformed of [null, [], 'not-protection', 42]) {
    const result = evaluateBranchProtectionWithFallback([], {
      classicProtection: malformed,
      repository,
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.fallback.used, false);
    assert.match(result.inputIssues.join(' '), /must be a JSON object/u);
  }

  const incomplete = evaluateBranchProtectionWithFallback([], {
    classicProtection: {},
    repository,
  });
  assert.equal(incomplete.status, 'FAIL');
  assert.equal(incomplete.fallback.used, true);
  assert.deepEqual(incomplete.missingChecks, REQUIRED_CHECK_NAMES);

  const incompleteActiveRules = [{
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_CHECK_NAMES.map((context) => ({ context })),
    },
  }];
  const activeRulesWin = evaluateBranchProtectionWithFallback(incompleteActiveRules, {
    classicProtection,
    repository,
  });
  assert.equal(activeRulesWin.status, 'FAIL');
  assert.equal(activeRulesWin.fallback.eligible, false);
  assert.equal(activeRulesWin.fallback.used, false);

  const malformedActiveRules = evaluateBranchProtectionWithFallback({}, {
    classicProtection,
    repository,
  });
  assert.equal(malformedActiveRules.status, 'FAIL');
  assert.equal(malformedActiveRules.fallback.used, false);
  assert.match(malformedActiveRules.inputIssues.join(' '), /must be an array/u);
});

test('gate evidence writer records immutable HEAD, commands, and artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opds-release-evidence-'));
  const outputPath = path.join(directory, 'static.json');
  try {
    const report = await writeGateEvidence({
      gateId: 'static-verification',
      status: 'PASS',
      outputPath,
      head: HEAD,
      commands: ['npm ci', 'npm run test'],
      artifacts: ['test-artifacts/static.log'],
    });
    assert.equal(report.head, HEAD);
    assert.deepEqual(report.testCommands, ['npm ci', 'npm run test']);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evidence loading verifies declared artifacts on disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opds-release-artifacts-'));
  const reportPath = path.join(directory, 'performance.json');
  const artifactPath = path.join(directory, 'performance.log');
  try {
    await writeFile(reportPath, `${JSON.stringify({
      contract: 'open-pdf-studio.editor-performance',
      artifacts: ['performance.log'],
    })}\n`);
    const missing = await loadEvidence([directory]);
    assert.equal(missing.errors.length, 1);
    assert.match(missing.errors[0].error, /declared artifact is missing/u);

    await writeFile(artifactPath, 'measured output\n');
    const present = await loadEvidence([directory]);
    assert.deepEqual(present.errors, []);
    assert.deepEqual(present.artifacts, ['performance.json', 'performance.log']);
    assert.equal(present.reports[0].artifactPath, 'performance.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing and malformed evidence inputs are reported instead of aborting evaluation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opds-invalid-release-evidence-'));
  const malformedPath = path.join(directory, 'malformed.json');
  const missingPath = path.join(directory, 'missing.json');
  try {
    await writeFile(malformedPath, '{not json}\n');
    const loaded = await loadEvidence([directory, missingPath]);
    assert.deepEqual(loaded.reports, []);
    assert.equal(loaded.errors.length, 2);
    assert.equal(loaded.errors.some((entry) => entry.path === malformedPath), true);
    assert.equal(loaded.errors.some((entry) => entry.path === missingPath), true);
    const result = evaluateReleaseHardening(loaded.reports, {
      expectedHead: HEAD,
      evidenceErrors: loaded.errors,
      worktreeState: CLEAN_WORKTREE,
    });
    assert.equal(result.decision, RELEASE_NO_GO);
    assert.equal(result.evidenceErrors.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
