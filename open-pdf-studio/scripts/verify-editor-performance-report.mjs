import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERFORMANCE_THRESHOLDS, metricPasses } from './ocr-release-hardening-policy.mjs';
import { validateOcrApplicationPerformanceSummary } from '../js/ocr/application-performance.js';

const REQUIRED_EDITOR_INSTRUMENTATION = Object.freeze([
  'longTaskObserver',
  'exactLayoutScheduler',
  'editorLayoutStore',
  'placementMetrics',
]);

function parseArguments(argv) {
  const options = { inputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') options.inputPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.inputPath) throw new Error('--input is required');
  return options;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reject virtual, service-only, synthetic, stale, or failed-open performance evidence. */
export function validateEditorPerformanceEvidence(report) {
  const issues = [];
  if (report?.contract !== 'open-pdf-studio.editor-performance') {
    issues.push('editor performance contract is invalid');
  }
  if (report?.schemaVersion !== 1) issues.push('editor performance schemaVersion must be 1');
  if (report?.gateId !== 'macos-editor-ocr-performance') {
    issues.push('editor performance gateId is invalid');
  }
  const editorProvenance = report?.provenance?.editor;
  if (editorProvenance?.execution !== 'packaged-production-ui') {
    issues.push('editor performance must execute through the packaged production UI');
  }
  if (editorProvenance?.realClock !== true || editorProvenance?.virtualTime !== false
      || editorProvenance?.serviceOnly !== false || editorProvenance?.stateSeeding !== false) {
    issues.push('editor performance provenance must be real-time, production-only, and not service-only');
  }
  for (const name of REQUIRED_EDITOR_INSTRUMENTATION) {
    const instrument = report?.instrumentation?.editor?.[name];
    if (instrument?.available !== true || instrument?.failedOpen !== false) {
      issues.push(`required editor instrumentation was unavailable or failed open: ${name}`);
    }
  }

  const ocr = report?.measurements?.ocrProduction100Page;
  if (ocr?.contract !== 'open-pdf-studio.ocr.production-100-page-qualification') {
    issues.push('real 100-page OCR qualification contract is missing');
  }
  if (ocr?.schemaVersion !== 1) issues.push('real 100-page OCR schemaVersion must be 1');
  if (!report?.head || !ocr?.head || ocr.head !== report.head) {
    issues.push('real 100-page OCR evidence must match the editor performance HEAD');
  }
  if (ocr?.status !== 'PASS' || ocr?.qualificationMode !== 'full') {
    issues.push('full real 100-page OCR qualification did not pass');
  }
  if (ocr?.platform?.operatingSystem !== 'darwin' || ocr?.platform?.architecture !== 'arm64'
      || typeof ocr?.appBinary !== 'string' || path.basename(ocr.appBinary) !== 'open-pdf-studio') {
    issues.push('real 100-page OCR execution did not identify the packaged macOS arm64 binary');
  }
  const startedAt = Date.parse(ocr?.startedAt);
  const finishedAt = Date.parse(ocr?.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    issues.push('real 100-page OCR timestamps are missing or invalid');
  }
  const automation = ocr?.automation;
  if (automation?.genericPackagedUiAutomation !== true
      || automation?.ocrStateInjectionUsed !== false
      || automation?.unitControllerUsed !== false
      || automation?.adapterDirectlyUsed !== false
      || automation?.developmentOnlyOcrMcpEntryPointUsed !== false
      || automation?.testOnlyOcrEntryPointUsed !== false) {
    issues.push('100-page OCR evidence did not preserve the packaged production UI path');
  }
  const visibleChain = automation?.visibleProductionChain;
  for (const stage of [
    '#ep-recognize-text',
    '#ocr-recognition-form',
    'OcrWorkflowService',
    'OcrApplicationController',
    'native disposable child',
  ]) {
    if (!Array.isArray(visibleChain) || !visibleChain.includes(stage)) {
      issues.push(`100-page OCR visible production chain is missing: ${stage}`);
    }
  }
  const completeFixture = ocr?.fixture?.complete;
  const cancellationFixture = ocr?.fixture?.cancellation;
  if (ocr?.fixture?.generatedDynamically !== true
      || ocr?.fixture?.generatedArtifactsCommitted !== false
      || completeFixture?.pageCount !== 100 || completeFixture?.imageOnlyPages !== 100
      || cancellationFixture?.pageCount !== 100 || cancellationFixture?.imageOnlyPages !== 100
      || !/^[0-9a-f]{64}$/u.test(completeFixture?.sha256 || '')
      || !/^[0-9a-f]{64}$/u.test(cancellationFixture?.sha256 || '')
      || completeFixture.sha256 === cancellationFixture.sha256) {
    issues.push('real OCR performance fixture must contain 100 image-only pages');
  }
  if (ocr?.completion?.status !== 'PASS' || ocr?.completion?.progress?.monotonic !== true
      || ocr?.completion?.progress?.last !== 100 || ocr?.completion?.serializedInference !== true
      || ocr?.completion?.childProcessesObserved !== 100
      || ocr?.completion?.childProcessesSurviving !== 0
      || !sameJson(ocr?.completion?.exactPageCounts, {
        completed: 100, skipped: 0, unsupported: 0, failed: 0, cancelled: 0,
      })
      || ocr?.completion?.sourceOriginalPreserved !== true
      || ocr?.completion?.copy?.status !== 'PASS'
      || ocr?.completion?.saveReopen?.ownedPages !== 100
      || ocr?.completion?.saveReopen?.renderingMode3StreamsPerPage !== 1
      || ocr?.completion?.externalReaders?.pdfJs !== 'PASS'
      || ocr?.completion?.externalReaders?.pdfium !== 'PASS'
      || ocr?.completion?.cache?.payloads !== 100
      || ocr?.completion?.cache?.metadata !== 100
      || !Array.isArray(ocr?.completion?.nativeJobTemp?.files)
      || ocr.completion.nativeJobTemp.files.length !== 0
      || ocr?.completion?.staleOrGenerationTokenErrors !== 0) {
    issues.push('real OCR completion evidence is incomplete');
  }
  const cancellationCounts = ocr?.cancellation?.countsAtTerminal;
  if (ocr?.cancellation?.status !== 'PASS' || ocr?.cancellation?.lateResultsApplied !== false
      || ocr?.cancellation?.childProcessesSurviving !== 0
      || ocr?.cancellation?.activeChildReaped !== true
      || ocr?.cancellation?.queuedPagesStopped !== true
      || ocr?.cancellation?.sourceOriginalPreserved !== true
      || !sameJson(cancellationCounts, ocr?.cancellation?.countsAfterSettling)
      || !Number.isInteger(cancellationCounts?.completed)
      || cancellationCounts.completed < 55 || cancellationCounts.completed >= 100
      || cancellationCounts?.cancelled !== 100 - cancellationCounts.completed
      || cancellationCounts?.failed !== 0 || cancellationCounts?.skipped !== 0
      || cancellationCounts?.unsupported !== 0
      || !Array.isArray(ocr?.cancellation?.nativeJobTemp?.files)
      || ocr.cancellation.nativeJobTemp.files.length !== 0) {
    issues.push('real OCR cancellation and late-publication evidence is incomplete');
  }
  const memory = ocr?.completion?.memory;
  for (const name of ['baselineParentRssBytes', 'peakParentRssBytes', 'peakChildRssBytes', 'settledParentRssBytes']) {
    if (!Number.isFinite(memory?.[name]) || memory[name] <= 0) {
      issues.push(`real OCR RSS evidence is unavailable: ${name}`);
    }
  }

  const applicationPerformance = ocr?.performance?.applicationController;
  for (const issue of validateOcrApplicationPerformanceSummary(applicationPerformance, {
    expectedPageCount: 100,
    requireCompleteCoverage: true,
    requireCompleteResources: true,
  })) {
    issues.push(`real OCR controller performance evidence is invalid: ${issue}`);
  }
  if (!sameJson(applicationPerformance, ocr?.completion?.controllerPerformance)) {
    issues.push('real OCR controller performance does not match packaged completion evidence');
  }
  const cancellationPerformance = ocr?.performance?.cancellationApplicationController;
  for (const issue of validateOcrApplicationPerformanceSummary(cancellationPerformance, {
    expectedPageCount: 100,
    requireCompleteCoverage: false,
    requireCompleteResources: true,
  })) {
    issues.push(`real cancelled OCR controller performance evidence is invalid: ${issue}`);
  }
  if (!sameJson(cancellationPerformance, ocr?.cancellation?.controllerPerformance) ||
      cancellationPerformance?.measuredPageCount !== cancellationCounts?.completed) {
    issues.push('real cancelled OCR controller performance does not match terminal page evidence');
  }

  const workflow = ocr?.performance?.workflowPublication;
  const ocrProvenance = report?.provenance?.ocr;
  if (ocrProvenance?.sourceContract !== 'open-pdf-studio.ocr.production-100-page-qualification'
      || ocrProvenance?.sourceHead !== report?.head
      || ocrProvenance?.execution !== 'packaged-production-ui-native-ocr') {
    issues.push('OCR performance provenance does not identify same-HEAD packaged native OCR');
  }
  for (const [name, expected] of Object.entries({
    instrumentationAvailable: true,
    uiSubscriberMounted: true,
    realClock: true,
    syntheticEvents: false,
    virtualTime: false,
    serviceOnly: false,
    failedOpen: false,
  })) {
    if (workflow?.[name] !== expected || ocrProvenance?.[name] !== expected) {
      issues.push(`real OCR workflow publication provenance is invalid: ${name}`);
    }
  }
  for (const name of ['maximumOrdinaryDeliveryHz', 'bookkeepingCpuPercent', 'clonedBytes']) {
    if (!Number.isFinite(workflow?.[name]) || workflow[name] < 0) {
      issues.push(`real OCR workflow publication metric is unavailable: ${name}`);
    }
  }
  if (workflow?.latePublicationAfterCancel !== false) {
    issues.push('real OCR workflow late-publication instrumentation did not pass');
  }
  const metricMappings = [
    ['ocrUiPublicationHz', workflow?.maximumOrdinaryDeliveryHz],
    ['ocrBookkeepingCpuPercent', workflow?.bookkeepingCpuPercent],
    ['ocrProgressMonotonic', ocr?.completion?.progress?.monotonic],
    ['lateOcrPublicationAfterCancel', workflow?.latePublicationAfterCancel],
  ];
  for (const [name, sourceValue] of metricMappings) {
    if (report?.metrics?.[name] !== sourceValue) {
      issues.push(`reported OCR performance metric does not match real production evidence: ${name}`);
    }
  }
  return issues;
}

export function evaluateEditorPerformanceReport(report) {
  const criteria = {};
  for (const [name, threshold] of Object.entries(PERFORMANCE_THRESHOLDS)) {
    const measured = report?.metrics?.[name];
    criteria[name] = {
      status: metricPasses(measured, threshold) ? 'PASS' : 'FAIL',
      measured: measured ?? null,
      ...threshold,
    };
  }
  const failures = Object.entries(criteria)
    .filter(([, result]) => result.status !== 'PASS')
    .map(([name]) => name);
  const evidenceIssues = validateEditorPerformanceEvidence(report);
  return {
    ...report,
    contract: 'open-pdf-studio.editor-performance',
    schemaVersion: 1,
    gateId: 'macos-editor-ocr-performance',
    status: failures.length === 0 && evidenceIssues.length === 0 ? 'PASS' : 'FAIL',
    criteria,
    evidenceIssues,
    failures: [...failures, ...(evidenceIssues.length > 0 ? ['performanceEvidence'] : [])],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  access(options.inputPath).then(() => readFile(options.inputPath, 'utf8')).then((contents) => {
    const result = evaluateEditorPerformanceReport(JSON.parse(contents));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
