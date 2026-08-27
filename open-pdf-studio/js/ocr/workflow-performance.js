// @ts-check

import {
  OCR_WORKFLOW_PUBLICATION_INTERVAL_MS,
  OcrWorkflowService,
} from './workflow-service.js';
import { DEFAULT_OCR_RECOGNITION_OPTIONS } from './application-request.js';

export const OCR_WORKFLOW_PERFORMANCE_CONTRACT =
  'open-pdf-studio.ocr-workflow-performance';

function highResolutionNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pageSummary(pageNumber, state = 'queued') {
  return {
    pageNumber,
    state,
    fraction: state === 'queued' ? 0 : 1,
    attempts: state === 'queued' ? 0 : 1,
    retries: 0,
    retryableFailureSeen: false,
    failure: null,
    staleRejected: false,
    cache: 'disabled',
    retained: state === 'completed',
    measuredStageCosts: null,
    performance: null,
  };
}

function pageCounts(pages) {
  const counts = {
    queued: 0,
    rasterizing: 0,
    preprocessing: 0,
    recognizing: 0,
    validating: 0,
    applying: 0,
    completed: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const page of pages) counts[page.state] += 1;
  return counts;
}

function createVirtualScheduler() {
  let currentTime = 0;
  let timerId = 0;
  const timers = new Map();
  return {
    now: () => currentTime,
    setTimer(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, dueAt: currentTime + Math.max(0, delay) });
      return timerId;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const target = currentTime + Math.max(0, milliseconds);
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.dueAt;
        timer.callback();
      }
      currentTime = target;
    },
    flush() {
      while (timers.size > 0) {
        const nextDueAt = Math.min(...[...timers.values()].map((timer) => timer.dueAt));
        this.advance(nextDueAt - currentTime);
      }
    },
  };
}

/**
 * Exercise the real owner-scoped workflow bookkeeping with a deterministic
 * 100-page transition schedule. No document store, native command, file, or
 * network state is read or changed, so packaged performance producers can run
 * it without seeding the application UI.
 *
 * @param {{
 *   pageCount?: number,
 *   transitionIntervalMs?: number,
 *   performanceClock?: () => number,
 * }} [options]
 */
export async function runOcrWorkflowPerformanceBenchmark({
  pageCount = 100,
  transitionIntervalMs = 20,
  performanceClock = highResolutionNow,
} = {}) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new RangeError('OCR workflow benchmark pageCount must be a positive integer');
  }
  if (!Number.isFinite(transitionIntervalMs) || transitionIntervalMs <= 0) {
    throw new RangeError('OCR workflow benchmark transitionIntervalMs must be positive');
  }

  const scheduler = createVirtualScheduler();
  const completion = deferred();
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const initialPages = pageNumbers.map((pageNumber) => pageSummary(pageNumber));
  const document = {
    id: 'ocr-workflow-performance-owner',
    fileName: 'ocr-workflow-performance.pdf',
    pdfDoc: { numPages: pageCount },
  };
  /** @type {((event: any) => void) | null} */
  let publishProgress = null;
  const handle = {
    jobId: 'ocr-workflow-performance-job',
    completion: completion.promise,
    cancel: () => completion.promise,
    summary: () => ({
      jobId: 'ocr-workflow-performance-job',
      documentId: document.id,
      documentGeneration: 'ocr-workflow-performance-generation',
      documentLifecycleGeneration: 0,
      status: 'queued',
      progress: 0,
      cancellationReason: null,
      keepCompletedPages: true,
      startedAt: '2000-01-01T00:00:00.000Z',
      finishedAt: null,
      counts: pageCounts(initialPages),
      pages: structuredClone(initialPages),
      stageCosts: { sampleCount: 0, costsMs: {} },
      appliedPageNumbers: [],
      rolledBackPageNumbers: [],
      prefetch: {
        requested: 0, used: 0, discarded: 0, failed: 0, maxBuffered: 0,
        rasterMs: 0, bytesPrepared: 0, bytesUsed: 0, peakBufferedBytes: 0,
      },
    }),
  };
  const service = new OcrWorkflowService({
    controller: {
      startDocumentJob(options) {
        publishProgress = options.onProgress;
        return handle;
      },
      cancelDocument: async () => [],
      cancelAll: async () => [],
    },
    modelState: { requireInstalled: async () => ({}) },
    clock: scheduler.now,
    performanceClock,
    setTimer: /** @type {any} */ (scheduler.setTimer),
    clearTimer: /** @type {any} */ (scheduler.clearTimer),
  });
  const deliveredProgress = [];
  const updates = [];
  const unsubscribe = service.subscribeUpdates((update) => {
    updates.push(update);
    if (update.kind === 'progress') deliveredProgress.push(update.progress);
  });

  service.start({
    document,
    sourcePdfPath: '/benchmark-only/ocr-workflow-performance.pdf',
    pageNumbers,
    pageScope: { kind: 'entire-document' },
    recognitionPolicy: {
      existingText: 'skip',
      keepCompletedPages: true,
      useCache: false,
      maximumRetries: 0,
      recognitionOptions: structuredClone(DEFAULT_OCR_RECOGNITION_OPTIONS),
    },
    modelState: { status: 'installed', manifest: {}, identity: {} },
    documentRevision: 0,
  });
  if (typeof publishProgress !== 'function') {
    throw new Error('OCR workflow benchmark did not capture the progress owner');
  }

  /** @type {Array<[import('../types/ocr.js').OcrApplicationPageState, number]>} */
  const stages = [
    ['rasterizing', 0.08],
    ['preprocessing', 0.16],
    ['recognizing', 0.68],
    ['validating', 0.84],
    ['applying', 0.94],
    ['completed', 1],
  ];
  let sequence = 0;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    for (const [pageState, pageFraction] of stages) {
      sequence += 1;
      publishProgress({
        jobId: handle.jobId,
        documentId: document.id,
        sequence,
        pageNumber: pageIndex + 1,
        pageState,
        pageFraction,
        documentFraction: (pageIndex + pageFraction) / pageCount,
        attempts: 1,
        retries: 0,
        failure: null,
      });
      scheduler.advance(transitionIntervalMs);
    }
  }
  scheduler.flush();

  const progressMonotonic = deliveredProgress.every((progress, index) =>
    index === 0 || progress >= deliveredProgress[index - 1]);
  const cancellation = service.cancel(document.id, 'benchmark-cancelled');
  const publicationsAtCancel = updates.length;
  publishProgress({
    jobId: handle.jobId,
    documentId: document.id,
    sequence: sequence + 1,
    pageNumber: pageCount,
    pageState: 'failed',
    pageFraction: 1,
    documentFraction: 1,
    attempts: 1,
    retries: 0,
    failure: { code: 'OCR_BENCHMARK_LATE', stage: 'publication', retryable: false },
  });
  scheduler.advance(OCR_WORKFLOW_PUBLICATION_INTERVAL_MS * 2);
  const noLatePublicationAfterCancel = updates.length === publicationsAtCancel;

  const terminalPages = pageNumbers.map((pageNumber) =>
    pageSummary(pageNumber, pageNumber === pageCount ? 'cancelled' : 'completed'));
  completion.resolve({
    ...handle.summary(),
    status: 'cancelled',
    progress: 1,
    cancellationReason: 'benchmark-cancelled',
    finishedAt: '2000-01-01T00:00:01.000Z',
    pages: terminalPages,
    counts: pageCounts(terminalPages),
    appliedPageNumbers: pageNumbers.slice(0, -1),
  });
  await cancellation;
  await Promise.resolve();

  const publication = service.publicationMetrics();
  unsubscribe();
  const checks = {
    publicationAtMost10Hz: publication.maximumOrdinaryDeliveryHz <= 10,
    bookkeepingBelow1Percent: publication.bookkeepingCpuPercent < 1,
    progressMonotonic,
    noLatePublicationAfterCancel,
  };
  return {
    contract: OCR_WORKFLOW_PERFORMANCE_CONTRACT,
    schemaVersion: 1,
    fixture: {
      documentId: document.id,
      pageCount,
      transitionCount: sequence,
      transitionIntervalMs,
      virtualDurationMs: publication.elapsedMs,
    },
    metrics: {
      maximumPublicationHz: publication.maximumOrdinaryDeliveryHz,
      averagePublicationHz: publication.ordinaryDeliveryBatches * 1000 / publication.elapsedMs,
      ordinaryPublicationBatches: publication.ordinaryDeliveryBatches,
      immediatePublicationBatches: publication.immediateDeliveryBatches,
      bookkeepingEvents: publication.bookkeepingEvents,
      bookkeepingMs: publication.bookkeepingMs,
      bookkeepingCpuPercent: publication.bookkeepingCpuPercent,
      clonedBytes: publication.clonedBytes,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}
