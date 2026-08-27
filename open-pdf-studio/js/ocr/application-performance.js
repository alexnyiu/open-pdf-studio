// @ts-check

export const OCR_APPLICATION_PERFORMANCE_CONTRACT =
  'open-pdf-studio.ocr.application-performance';
export const OCR_APPLICATION_PERFORMANCE_SCHEMA_VERSION = 1;

const ROUNDING_FACTOR = 1000;

export const OCR_APPLICATION_PERFORMANCE_STAGES = Object.freeze([
  Object.freeze({ name: 'rasterization', source: 'rasterMs' }),
  Object.freeze({ name: 'childStartup', source: 'childStartupMs' }),
  Object.freeze({ name: 'modelStartup', source: 'modelStartupMs' }),
  Object.freeze({ name: 'inference', source: 'detectionMs + recognitionMs' }),
  Object.freeze({ name: 'detection', source: 'detectionMs' }),
  Object.freeze({ name: 'recognition', source: 'recognitionMs' }),
  Object.freeze({ name: 'validation', source: 'validationMs' }),
  Object.freeze({ name: 'apply', source: 'applyMs' }),
  Object.freeze({ name: 'totalOcr', source: 'totalOcrMs' }),
]);

function round(value) {
  return Math.round((value + Number.EPSILON) * ROUNDING_FACTOR) / ROUNDING_FACTOR;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}

function metricValue(performance, stage) {
  if (stage.name === 'inference') {
    const detection = Number(performance?.detectionMs);
    const recognition = Number(performance?.recognitionMs);
    return Number.isFinite(detection) && detection >= 0 &&
      Number.isFinite(recognition) && recognition >= 0
      ? detection + recognition
      : null;
  }
  const value = Number(performance?.[stage.source]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function summarizeMetric(values, source) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    source,
    samples: values.length,
    totalMs: round(total),
    meanMs: values.length > 0 ? round(total / values.length) : null,
    medianMs: values.length > 0 ? round(percentile(sorted, 0.5)) : null,
    p95Ms: values.length > 0 ? round(percentile(sorted, 0.95)) : null,
    maxMs: values.length > 0 ? round(sorted.at(-1)) : null,
  };
}

function resourceLifecycleSummary(measuredPages) {
  const resources = measuredPages.map((page) => page.performance?.resources ?? {});
  const lifecycle = measuredPages.map((page) => page.performance?.lifecycle ?? []);
  const count = (predicate) => resources.filter(predicate).length;
  const pagesWithLifecycle = lifecycle.filter((events) => Array.isArray(events) && events.length > 0).length;
  const pagesWithResources = resources.filter(
    (value) => value && typeof value === 'object' && Object.keys(value).length > 0,
  ).length;
  const cleanup = {
    jobEnvelopeDroppedPages: count((value) => value.jobEnvelopeDropped === true),
    onnxSessionsReleasedPages: count((value) => value.onnxSessionsReleased === true),
    transferredBuffersDroppedPages: count((value) => value.transferredBuffersDropped === true),
    eventListenersRemovedPages: count((value) => value.eventListenersRemoved === true),
    offlinePolicyEnforcedPages: count((value) => value.offline?.policyEnforced === true),
    offlineSelfTestPassedPages: count((value) => value.offline?.selfTestPassed === true),
    duplicateModelInstancePages: count((value) => value.duplicateModelInstances === true),
    maximumAdapterInstances: resources.reduce(
      (maximum, value) => Math.max(maximum, Number(value.maximumAdapterInstances) || 0),
      0,
    ),
  };
  const instrumentationAvailable = measuredPages.length > 0 &&
    pagesWithLifecycle === measuredPages.length && pagesWithResources === measuredPages.length;
  return {
    pageSamples: measuredPages.length,
    pagesWithLifecycle,
    lifecycleEvents: lifecycle.reduce(
      (sum, events) => sum + (Array.isArray(events) ? events.length : 0),
      0,
    ),
    pagesWithResources,
    instrumentationAvailable,
    failedOpen: !instrumentationAvailable,
    cleanup,
  };
}

function prefetchSummary(value = {}) {
  const numeric = (name) => {
    const number = Number(value?.[name]);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const summary = {
    requested: numeric('requested'),
    used: numeric('used'),
    discarded: numeric('discarded'),
    failed: numeric('failed'),
    maxBuffered: numeric('maxBuffered'),
    rasterMs: numeric('rasterMs'),
    bytesPrepared: numeric('bytesPrepared'),
    bytesUsed: numeric('bytesUsed'),
    peakBufferedBytes: numeric('peakBufferedBytes'),
  };
  return { ...summary, boundedBuffer: summary.maxBuffered <= 1 };
}

/**
 * Build a stable aggregate from the per-page timings retained by the
 * application controller. The aggregate contains no recognized text, source
 * paths, or mutable UI state and is safe to expose to the packaged harness.
 *
 * @param {Array<{pageNumber?: number, performance?: Record<string, any> | null}>} pages
 * @param {{prefetch?: Record<string, unknown>}} [options]
 */
export function summarizeOcrApplicationPerformance(pages, { prefetch = {} } = {}) {
  const pageList = Array.isArray(pages) ? pages : [];
  const measuredPages = pageList.filter(
    (page) => page?.performance && typeof page.performance === 'object',
  );
  const stages = Object.fromEntries(OCR_APPLICATION_PERFORMANCE_STAGES.map((stage) => {
    const values = measuredPages
      .map((page) => metricValue(page.performance, stage))
      .filter((value) => value !== null);
    return [stage.name, summarizeMetric(values, stage.source)];
  }));
  const instrumentationAvailable = measuredPages.length > 0 &&
    Object.values(stages).every((stage) => stage.samples === measuredPages.length);
  return {
    contract: OCR_APPLICATION_PERFORMANCE_CONTRACT,
    schemaVersion: OCR_APPLICATION_PERFORMANCE_SCHEMA_VERSION,
    expectedPageCount: pageList.length,
    measuredPageCount: measuredPages.length,
    pageCoverageComplete: pageList.length > 0 && measuredPages.length === pageList.length,
    instrumentationAvailable,
    failedOpen: !instrumentationAvailable,
    stageOrder: OCR_APPLICATION_PERFORMANCE_STAGES.map((stage) => stage.name),
    stages,
    resourceLifecycle: resourceLifecycleSummary(measuredPages),
    prefetch: prefetchSummary(prefetch),
  };
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validate aggregate evidence without trusting the producer's PASS/FAIL
 * fields. Release callers can additionally require complete resource cleanup
 * evidence from every measured page.
 */
export function validateOcrApplicationPerformanceSummary(value, {
  expectedPageCount = null,
  requireCompleteCoverage = true,
  requireCompleteResources = false,
} = {}) {
  const issues = [];
  if (value?.contract !== OCR_APPLICATION_PERFORMANCE_CONTRACT) {
    issues.push('application OCR performance contract is invalid');
  }
  if (value?.schemaVersion !== OCR_APPLICATION_PERFORMANCE_SCHEMA_VERSION) {
    issues.push(`application OCR performance schemaVersion must be ${OCR_APPLICATION_PERFORMANCE_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(value?.expectedPageCount) || value.expectedPageCount < 1) {
    issues.push('application OCR expected page count is invalid');
  }
  if (Number.isSafeInteger(expectedPageCount) && value?.expectedPageCount !== expectedPageCount) {
    issues.push(`application OCR expected page count must be ${expectedPageCount}`);
  }
  if (!Number.isSafeInteger(value?.measuredPageCount) || value.measuredPageCount < 0 ||
      value.measuredPageCount > value.expectedPageCount) {
    issues.push('application OCR measured page count is invalid');
  }
  if (requireCompleteCoverage && (value?.pageCoverageComplete !== true ||
      value?.measuredPageCount !== value?.expectedPageCount)) {
    issues.push('application OCR timing coverage is incomplete');
  }
  if (value?.instrumentationAvailable !== true || value?.failedOpen !== false) {
    issues.push('application OCR stage instrumentation is unavailable or failed open');
  }

  const expectedStageNames = OCR_APPLICATION_PERFORMANCE_STAGES.map((stage) => stage.name);
  if (JSON.stringify(value?.stageOrder) !== JSON.stringify(expectedStageNames)) {
    issues.push('application OCR stage order is invalid');
  }
  if (!value?.stages || typeof value.stages !== 'object' || Array.isArray(value.stages) ||
      JSON.stringify(Object.keys(value.stages)) !== JSON.stringify(expectedStageNames)) {
    issues.push('application OCR stage set is invalid');
  }
  for (const stage of OCR_APPLICATION_PERFORMANCE_STAGES) {
    const measured = value?.stages?.[stage.name];
    if (measured?.source !== stage.source) {
      issues.push(`application OCR stage source is invalid: ${stage.name}`);
    }
    if (!Number.isSafeInteger(measured?.samples) || measured.samples < 0 ||
        measured.samples !== value?.measuredPageCount) {
      issues.push(`application OCR stage sample count is invalid: ${stage.name}`);
    }
    for (const name of ['totalMs', 'meanMs', 'medianMs', 'p95Ms', 'maxMs']) {
      if (!isNonNegativeFinite(measured?.[name])) {
        issues.push(`application OCR stage metric is unavailable: ${stage.name}.${name}`);
      }
    }
    if (isNonNegativeFinite(measured?.medianMs) && isNonNegativeFinite(measured?.p95Ms) &&
        measured.medianMs > measured.p95Ms) {
      issues.push(`application OCR stage percentiles are inconsistent: ${stage.name}`);
    }
    if (isNonNegativeFinite(measured?.p95Ms) && isNonNegativeFinite(measured?.maxMs) &&
        measured.p95Ms > measured.maxMs) {
      issues.push(`application OCR stage maximum is inconsistent: ${stage.name}`);
    }
  }

  const resources = value?.resourceLifecycle;
  for (const name of ['pageSamples', 'pagesWithLifecycle', 'lifecycleEvents', 'pagesWithResources']) {
    if (!Number.isSafeInteger(resources?.[name]) || resources[name] < 0) {
      issues.push(`application OCR resource metric is unavailable: ${name}`);
    }
  }
  if (resources?.pageSamples !== value?.measuredPageCount) {
    issues.push('application OCR resource sample count does not match stage evidence');
  }
  if (requireCompleteResources) {
    if (resources?.instrumentationAvailable !== true || resources?.failedOpen !== false ||
        resources?.pagesWithLifecycle !== value?.measuredPageCount ||
        resources?.pagesWithResources !== value?.measuredPageCount) {
      issues.push('application OCR resource instrumentation is unavailable or failed open');
    }
    const cleanup = resources?.cleanup;
    for (const name of [
      'jobEnvelopeDroppedPages',
      'onnxSessionsReleasedPages',
      'transferredBuffersDroppedPages',
      'eventListenersRemovedPages',
      'offlinePolicyEnforcedPages',
      'offlineSelfTestPassedPages',
    ]) {
      if (cleanup?.[name] !== value?.measuredPageCount) {
        issues.push(`application OCR cleanup evidence is incomplete: ${name}`);
      }
    }
    if (cleanup?.duplicateModelInstancePages !== 0 ||
        !Number.isFinite(cleanup?.maximumAdapterInstances) || cleanup.maximumAdapterInstances > 1) {
      issues.push('application OCR resource evidence shows duplicate model instances');
    }
  }

  const prefetch = value?.prefetch;
  for (const name of [
    'requested', 'used', 'discarded', 'failed', 'maxBuffered', 'rasterMs',
    'bytesPrepared', 'bytesUsed', 'peakBufferedBytes',
  ]) {
    if (!isNonNegativeFinite(prefetch?.[name])) {
      issues.push(`application OCR prefetch metric is unavailable: ${name}`);
    }
  }
  if (prefetch?.boundedBuffer !== true || prefetch?.maxBuffered > 1) {
    issues.push('application OCR prefetch exceeded one buffered raster');
  }
  return issues;
}
