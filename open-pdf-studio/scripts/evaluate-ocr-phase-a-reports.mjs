import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_GO = 'PRODUCTION GO';
export const PRODUCTION_NO_GO = 'EVALUATION GO, PRODUCTION NO-GO';

export function validatePlatformReport(report) {
  const failures = [];
  const repeated = report?.memory?.repeatedCycles;
  const checkpoints = report?.memory?.checkpoints;
  const resources = report?.resourceLifetime;
  const recognition = repeated?.recognition ?? [];
  const cancellation = repeated?.cancellation ?? [];
  const required = (condition, message) => {
    if (!condition) failures.push(message);
  };

  required(report?.schemaVersion === 3, 'report schema is not the current production-gate version');
  required(report?.environment?.buildKind === 'packaged-release', 'gate did not identify a packaged release build');
  required(report?.environment?.debugBuild === false, 'gate did not run against a release/package build');
  required(report?.gate?.memoryRemediationPass === true, 'memory remediation did not pass');
  required(repeated?.bounded === true, 'repeated-cycle memory is not bounded');
  required(repeated?.attributionStable === true, 'memory process attribution is unstable');
  required(recognition.length >= 10, 'fewer than 10 recognition cycles');
  required(cancellation.length >= 10, 'fewer than 10 cancellation cycles');
  required(
    repeated?.uniqueChildProcesses >= recognition.length + cancellation.length,
    'jobs did not use a fresh child process per cycle',
  );
  required(
    checkpoints?.afterRepeatedRecognitionAndCancellationCycles?.activeOcrChildPids?.length === 0,
    'an OCR child survived the repeated-cycle gate',
  );
  required(report?.accuracy?.allRecognitionCyclesExact === true, 'golden OCR text was not exact');
  required(report?.cancellation?.allTerminatedWorkers === true, 'Worker cancellation did not pass');
  required(report?.offline?.pass === true, 'offline gate did not pass');
  required(report?.offline?.allWorkerFetchesGuarded === true, 'not every Worker fetch was guarded');
  required(report?.offline?.externalBlockSelfTestPassed === true, 'offline block self-test failed');
  required(
    report?.viewerResponsiveness?.responsiveWhileOcrActive === true,
    'viewer responsiveness probe failed',
  );
  required(resources?.onnxSessionsReleased === true, 'ONNX sessions were not released');
  required(resources?.transferredBuffersDropped === true, 'transferred buffers were retained');
  required(resources?.eventListenersRemoved === true, 'Worker event listeners were retained');
  required(resources?.duplicateModelInstances === false, 'duplicate model instances were observed');
  required(resources?.trueProcessLeakObserved === false, 'a process-level leak was observed');
  required(report?.fixture?.unchangedAfterRun === true, 'golden fixture changed during the run');
  required(report?.packageSize?.builtOcrBytes > 0, 'OCR package-size measurement is missing');

  return failures;
}

export function evaluateProductionReports(reports) {
  const requiredPlatforms = ['darwin', 'win32', 'linux'];
  const platformReports = new Map();
  for (const report of reports) {
    if (requiredPlatforms.includes(report?.environment?.platform)) {
      platformReports.set(report.environment.platform, report);
    }
  }

  const platforms = {};
  const failures = [];
  for (const platform of requiredPlatforms) {
    const report = platformReports.get(platform);
    if (!report) {
      platforms[platform] = { present: false, failures: ['live report is missing'] };
      failures.push(`${platform}: live report is missing`);
      continue;
    }
    const reportFailures = validatePlatformReport(report);
    platforms[platform] = {
      present: true,
      architecture: report.environment.arch,
      measuredAt: report.measuredAt,
      failures: reportFailures,
      finalRetainedDeltaMiB: report.memory.repeatedCycles.finalRetainedDeltaMiB,
      linearTrendMiBPerCycle: report.memory.repeatedCycles.linearTrendMiBPerCycle,
      recognitionCycles: report.memory.repeatedCycles.recognition.length,
      cancellationCycles: report.memory.repeatedCycles.cancellation.length,
    };
    failures.push(...reportFailures.map((failure) => `${platform}: ${failure}`));
  }

  return {
    schemaVersion: 1,
    classification: failures.length === 0 ? PRODUCTION_GO : PRODUCTION_NO_GO,
    evaluatedAt: new Date().toISOString(),
    platforms,
    failures,
  };
}

async function jsonFiles(input) {
  const metadata = await stat(input);
  if (metadata.isFile()) return input.endsWith('.json') ? [input] : [];
  const files = [];
  for (const entry of await readdir(input, { withFileTypes: true })) {
    const child = path.join(input, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : null;
  if (outputIndex >= 0) args.splice(outputIndex, 2);
  if (args.length === 0) {
    throw new Error('usage: node scripts/evaluate-ocr-phase-a-reports.mjs <report-or-directory>... [--output file]');
  }
  const files = (await Promise.all(args.map((input) => jsonFiles(path.resolve(input))))).flat();
  const reports = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.environment?.platform && parsed?.memory?.repeatedCycles) reports.push(parsed);
  }
  const decision = evaluateProductionReports(reports);
  const serialized = `${JSON.stringify(decision, null, 2)}\n`;
  if (output) await writeFile(output, serialized, 'utf8');
  process.stdout.write(serialized);
  if (decision.classification !== PRODUCTION_GO) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
