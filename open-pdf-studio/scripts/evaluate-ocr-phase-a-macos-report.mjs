import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validatePlatformReport } from './evaluate-ocr-phase-a-reports.mjs';
import { verifyOcrAssets } from './verify-ocr-assets.mjs';
import { verifyExecutableTarget } from './verify-pdfium-sidecar.mjs';

export const MACOS_PRODUCTION_GO = 'MACOS PRODUCTION GO';
export const MACOS_PRODUCTION_NO_GO = 'MACOS PRODUCTION NO-GO';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const execFileAsync = promisify(execFile);
const RETAINED_RSS_LIMIT_MIB = 32;
const GROWTH_LIMIT_MIB_PER_CYCLE = 2;

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

function noPids(value) {
  return Array.isArray(value) && value.length === 0;
}

function finiteAtMost(value, limit) {
  return Number.isFinite(value) && value <= limit;
}

function acceptedCancellationMethod(value) {
  return value === 'worker.terminate' || value === 'native-child-process-terminate';
}

function viewerUsesPdfium(viewer) {
  const probes = [...(viewer?.baseline ?? []), ...(viewer?.duringOcr ?? [])];
  return probes.some((probe) => probe?.result?.engine === 'Raster (PDFium)');
}

function resourcesWereCleaned(resources) {
  return resources?.liveJavaScriptReferencesDropped === true
    && resources?.jobEnvelopeDropped === true
    && resources?.onnxSessionsReleased === true
    && resources?.openCv?.resourcesReleased === true
    && resources?.imageBitmap?.closed === true
    && resources?.senderBufferDetached === true
    && resources?.transferredBuffersDropped === true
    && resources?.eventListenersRemoved === true
    && resources?.messagePorts?.closed === true
    && resources?.modelCache?.modelByteReferencesDropped === true
    && resources?.maximumAdapterInstancesPerChild <= 1
    && resources?.duplicateModelInstances === false
    && resources?.trueProcessLeakObserved === false;
}

export function evaluateMacosProductionReport(report, artifactEvidence = {}) {
  const repeated = report?.memory?.repeatedCycles;
  const recognition = repeated?.recognition ?? [];
  const cancellation = repeated?.cancellation ?? [];
  const jobs = [...recognition, ...cancellation];
  const childPids = jobs.map((job) => job?.childPid);
  const uniqueChildPids = new Set(childPids);
  const finalCheckpoint = report?.memory?.checkpoints
    ?.afterRepeatedRecognitionAndCancellationCycles;
  const viewer = report?.viewerResponsiveness;
  const resources = report?.resourceLifetime;
  const baseFailures = validatePlatformReport(report);

  const criteria = {
    packagedReleaseApp: report?.environment?.buildKind === 'packaged-release'
      && report?.environment?.debugBuild === false
      && artifactEvidence.packagedApp === true,
    macosArm64LiveExecution: report?.environment?.platform === 'darwin'
      && report?.environment?.arch === 'arm64'
      && report?.gate?.platformValidated === 'darwin-arm64'
      && artifactEvidence.applicationArm64 === true,
    tenRecognitionCycles: recognition.length >= 10,
    tenCancellationCycles: cancellation.length >= 10
      && cancellation.every((job) => job?.cancelled === true)
      && cancellation.every((job) => acceptedCancellationMethod(job?.cancellationMethod)),
    uniqueDisposableChildPerJob: jobs.length >= 20
      && childPids.every((pid) => Number.isInteger(pid) && pid > 0)
      && uniqueChildPids.size === jobs.length
      && repeated?.uniqueChildProcesses === jobs.length
      && report?.isolation?.boundary === 'native-child-process'
      && report?.isolation?.oneJob === true
      && jobs.every((job) => job?.isolationBoundary === 'native-child-process')
      && jobs.every((job) => job?.childExitStatus === 0 ||
        (job?.cancelled === true && job?.childReaped === true)),
    noSurvivingChild: jobs.every((job) => noPids(job?.activeOcrChildPidsAfterSettle))
      && noPids(finalCheckpoint?.activeOcrChildPids)
      && noPids(viewer?.activeOcrChildPidsAfterProbe),
    settledRetainedRssWithin32MiB: repeated?.bounded === true
      && repeated?.attributionStable === true
      && finiteAtMost(repeated?.maximumSettledDeltaMiB, RETAINED_RSS_LIMIT_MIB)
      && finiteAtMost(repeated?.finalRetainedDeltaMiB, RETAINED_RSS_LIMIT_MIB),
    growthWithin2MiBPerCycle: finiteAtMost(
      repeated?.linearTrendMiBPerCycle,
      GROWTH_LIMIT_MIB_PER_CYCLE,
    ),
    exactGoldenFixtureText: report?.accuracy?.allRecognitionCyclesExact === true
      && report?.accuracy?.exactNormalizedMatch === true
      && report?.accuracy?.editDistance === 0
      && typeof report?.accuracy?.normalizedActual === 'string'
      && report.accuracy.normalizedActual.length > 0
      && report?.accuracy?.normalizedActual === report?.accuracy?.normalizedExpected
      && recognition.every((job) => job?.exactNormalizedMatch === true)
      && viewer?.ocrExactNormalizedMatch === true,
    offlineEnforcement: report?.offline?.pass === true
      && report?.offline?.externalNetworkRequestsRequired === false
      && report?.offline?.sameOriginAssetGuard === true
      && report?.offline?.allWorkerFetchesGuarded === true
      && report?.offline?.externalBlockSelfTestPassed === true
      && recognition.every((job) => job?.resources?.offline?.policyEnforced === true)
      && recognition.every((job) => job?.resources?.offline?.selfTestPassed === true),
    staleResultRejection: resources?.staleResultRetentionPrevented === true,
    viewerResponsiveness: viewer?.responsiveWhileOcrActive === true
      && viewer?.allDuringRequestsSucceeded === true
      && viewer?.allDuringRequestsCompletedBeforeOcr === true,
    resourceCleanup: resourcesWereCleaned(resources)
      && report?.cancellation?.allTerminatedWorkers === true,
    modelAndDependencyChecksumVerification:
      report?.offline?.vendoredAssetsChecksumVerified === true
      && artifactEvidence.modelAndDependencyChecksumsVerified === true,
    validMacosSidecarArchitecture: artifactEvidence.packagedSidecarArm64 === true,
    universalPackagingArchitectureChecked:
      artifactEvidence.universalPackagingArchitectureChecked === true,
    pdfiumInitialization: report?.memory?.checkpoints?.processStart
      ?.roles?.['pdfium-worker']?.rssBytes > 0
      && report?.result?.source?.kind === 'pdf-page'
      && report?.timing?.rasterMs > 0
      && viewerUsesPdfium(viewer),
    paddleOcrPrimaryEngine: report?.result?.engine?.provider === 'PaddleOCR',
    basePlatformContract: baseFailures.length === 0,
  };

  const messages = {
    packagedReleaseApp: 'a packaged release .app was not verified',
    macosArm64LiveExecution: 'live execution was not verified as macOS arm64',
    tenRecognitionCycles: 'fewer than ten recognition cycles were reported',
    tenCancellationCycles: 'fewer than ten cancellation cycles were reported',
    uniqueDisposableChildPerJob: 'every OCR job did not use one unique disposable native child',
    noSurvivingChild: 'an OCR child survived a settled or viewer checkpoint',
    settledRetainedRssWithin32MiB: 'settled retained RSS exceeded 32 MiB',
    growthWithin2MiBPerCycle: 'cycle growth exceeded +2 MiB per cycle',
    exactGoldenFixtureText: 'golden-fixture text was not exact',
    offlineEnforcement: 'offline enforcement did not pass',
    staleResultRejection: 'stale-result rejection was not verified',
    viewerResponsiveness: 'viewer responsiveness did not pass',
    resourceCleanup: 'resource cleanup did not pass',
    modelAndDependencyChecksumVerification: 'model and dependency checksums were not verified',
    validMacosSidecarArchitecture: 'the packaged macOS sidecar is not valid for arm64',
    universalPackagingArchitectureChecked:
      'arm64/x86_64 macOS packaging inputs were not architecture-checked',
    pdfiumInitialization: 'PDFium initialization was not verified',
    paddleOcrPrimaryEngine: 'the live report did not use PaddleOCR',
    basePlatformContract: 'the shared Phase A platform contract did not pass',
  };
  const failures = Object.entries(criteria)
    .filter(([, passed]) => !passed)
    .map(([criterion]) => messages[criterion]);
  failures.push(...baseFailures.map((failure) => `platform report: ${failure}`));

  return {
    contract: 'open-pdf-studio.ocr-macos-production-decision',
    schemaVersion: 1,
    scope: 'macos-arm64',
    classification: failures.length === 0
      ? MACOS_PRODUCTION_GO
      : MACOS_PRODUCTION_NO_GO,
    evaluatedAt: new Date().toISOString(),
    productionTarget: {
      platform: 'darwin',
      architecture: 'arm64',
      windows: 'deferred-not-supported',
      linux: 'deferred-not-supported',
    },
    evidence: {
      reportMeasuredAt: report?.measuredAt ?? null,
      platform: report?.environment?.platform ?? null,
      architecture: report?.environment?.arch ?? null,
      buildKind: report?.environment?.buildKind ?? null,
      recognitionCycles: recognition.length,
      cancellationCycles: cancellation.length,
      uniqueChildProcesses: uniqueChildPids.size,
      maximumSettledDeltaMiB: repeated?.maximumSettledDeltaMiB ?? null,
      finalRetainedDeltaMiB: repeated?.finalRetainedDeltaMiB ?? null,
      linearTrendMiBPerCycle: repeated?.linearTrendMiBPerCycle ?? null,
      engine: report?.result?.engine?.provider ?? null,
      artifacts: artifactEvidence.summary ?? null,
    },
    limits: {
      settledRetainedRssMiB: RETAINED_RSS_LIMIT_MIB,
      growthMiBPerCycle: GROWTH_LIMIT_MIB_PER_CYCLE,
      minimumRecognitionCycles: 10,
      minimumCancellationCycles: 10,
    },
    criteria,
    failures: [...new Set(failures)],
  };
}

async function verifiedTarget(file, target) {
  return verifyExecutableTarget(await readFile(file), target);
}

export async function collectMacosArtifactEvidence(
  appBundle,
  binariesDir = path.join(projectDir, 'src-tauri', 'binaries'),
) {
  const resolvedApp = path.resolve(appBundle);
  const appInfo = await stat(resolvedApp);
  if (!appInfo.isDirectory() || !resolvedApp.endsWith('.app')) {
    throw new Error('macOS production evidence must point to a packaged .app bundle');
  }

  await stat(path.join(resolvedApp, 'Contents', 'Info.plist'));
  const application = await verifiedTarget(
    path.join(resolvedApp, 'Contents', 'MacOS', 'open-pdf-studio'),
    'aarch64-apple-darwin',
  );
  const packagedSidecar = await verifiedTarget(
    path.join(resolvedApp, 'Contents', 'MacOS', 'pdfium-worker'),
    'aarch64-apple-darwin',
  );
  const packagedPdfium = await verifiedTarget(
    path.join(resolvedApp, 'Contents', 'Resources', 'libpdfium.dylib'),
    'universal-apple-darwin',
  );
  const stagedArm64Sidecar = await verifiedTarget(
    path.join(binariesDir, 'pdfium-worker-aarch64-apple-darwin'),
    'aarch64-apple-darwin',
  );
  const stagedX86Sidecar = await verifiedTarget(
    path.join(binariesDir, 'pdfium-worker-x86_64-apple-darwin'),
    'x86_64-apple-darwin',
  );
  const universalPdfium = await verifiedTarget(
    path.join(binariesDir, 'macos-universal', 'libpdfium.dylib'),
    'universal-apple-darwin',
  );
  const assets = await verifyOcrAssets();
  const checksumsVerified = assets.ok === true
    && assets.models.length === 3
    && assets.runtime.length === 2
    && assets.package?.version === '1.27.0'
    && typeof assets.package?.integrity === 'string'
    && assets.package.integrity.length > 0;

  return {
    packagedApp: true,
    applicationArm64: application.architectures.includes('arm64'),
    packagedSidecarArm64: packagedSidecar.architectures.includes('arm64'),
    universalPackagingArchitectureChecked:
      stagedArm64Sidecar.architectures.includes('arm64')
      && stagedX86Sidecar.architectures.includes('x86_64')
      && universalPdfium.architectures.includes('arm64')
      && universalPdfium.architectures.includes('x86_64'),
    modelAndDependencyChecksumsVerified: checksumsVerified,
    summary: {
      appBundle: path.basename(resolvedApp),
      applicationArchitectures: application.architectures,
      packagedSidecarArchitectures: packagedSidecar.architectures,
      packagedPdfiumArchitectures: packagedPdfium.architectures,
      stagedSidecarArchitectures: {
        arm64: stagedArm64Sidecar.architectures,
        x86_64: stagedX86Sidecar.architectures,
      },
      universalPdfiumArchitectures: universalPdfium.architectures,
      checksumVerification: {
        models: assets.models.length,
        runtimeAssets: assets.runtime.length,
        dependency: assets.package,
      },
    },
  };
}

function parseArgs(args) {
  const values = { report: null, app: null, output: null, binariesDir: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--') && !values.report) {
      values.report = argument;
      continue;
    }
    if (!['--app', '--output', '--binaries-dir'].includes(argument) || !args[index + 1]) {
      throw new Error(`invalid argument ${argument}`);
    }
    const key = argument === '--binaries-dir' ? 'binariesDir' : argument.slice(2);
    values[key] = args[index + 1];
    index += 1;
  }
  if (!values.report || !values.app) {
    throw new Error(
      'usage: node scripts/evaluate-ocr-phase-a-macos-report.mjs <report.json> '
      + '--app <Open PDF Studio.app> [--binaries-dir path] [--output file]',
    );
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await readFile(path.resolve(options.report), 'utf8'));
  let artifactEvidence;
  try {
    artifactEvidence = await collectMacosArtifactEvidence(
      options.app,
      options.binariesDir ? path.resolve(options.binariesDir) : undefined,
    );
  } catch (error) {
    artifactEvidence = { summary: { verificationError: error.message } };
  }
  const decision = {
    ...evaluateMacosProductionReport(report, artifactEvidence),
    head: await gitHead(),
  };
  const serialized = `${JSON.stringify(decision, null, 2)}\n`;
  if (options.output) await writeFile(path.resolve(options.output), serialized, 'utf8');
  process.stdout.write(serialized);
  if (decision.classification !== MACOS_PRODUCTION_GO) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
