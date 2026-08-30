// @ts-check

import {
  applyOcrPageResult,
  beginOcrPageAttempt,
  ensureDocumentOcrState,
  isCurrentOcrPageToken,
  markOcrPageStage,
  restoreOcrCommandState,
  selectOcrCommandSnapshot,
  snapshotOcrCommandState,
} from './document-state.js';
import {
  cancelAllNativeOcrJobs,
  cancelNativeOcrDocument,
  cancelNativeOcrJob,
  cancelNativeOcrPagePrefetch,
  prefetchNativeOcrPageRaster,
  runNativeOcrPageForDocument,
} from './native-controller.js';
import {
  isPdfForegroundIdle,
  notePdfForegroundActivity,
} from '../pdf/foreground-activity.js';
import { backgroundRenderAdmissionAllowed } from '../pdf/render-resource-budget.js';
import { acquireWholePdfPreloadSuspension } from '../pdf/whole-pdf-preload-suspension.js';
import { assertOcrPageGeometryV1 } from './contracts/page-geometry.v1.js';
import { assertOcrResultV2 } from './contracts/v2.js';
import {
  createOcrCacheKeyFromRequest,
  fingerprintOcrDocument,
  getDefaultOcrResultCache,
  rebindCachedOcrEnvelope,
} from './cache.js';
import { getDefaultOcrModelPackState } from './model-state.js';
import { createApplicationOcrPageRequest } from './application-request.js';
import { recordAppliedOcrCompound } from './undo-commands.js';
import { summarizeOcrApplicationPerformance } from './application-performance.js';

export const OCR_APPLICATION_PAGE_STATES = Object.freeze([
  'queued',
  'rasterizing',
  'preprocessing',
  'recognizing',
  'validating',
  'applying',
  'completed',
  'skipped',
  'unsupported',
  'failed',
  'cancelled',
]);

const TERMINAL_PAGE_STATES = new Set(['completed', 'skipped', 'unsupported', 'failed', 'cancelled']);
const WEIGHTED_STAGES = ['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying'];
const activeApplicationControllers = new Set();
const activeDocumentApplicationJobs = new Map();
const CANCELLED_ASYNC_WAIT = Symbol('ocr-cancelled-async-wait');
let applicationJobSequence = 0;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clone(value) {
  return structuredClone(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function documentLifecycleGeneration(document) {
  return Number.isSafeInteger(document?.lifecycleGeneration)
    ? document.lifecycleGeneration
    : 0;
}

function yieldToEventLoop(_context = null) {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A cancellable FIFO gate shared by default across application controllers. */
export class OcrInferenceGate {
  constructor() {
    this.active = false;
    this.queue = [];
  }

  acquire(applicationJobId) {
    const ticket = {
      applicationJobId,
      cancelled: false,
      released: false,
      resolve: null,
    };
    const release = () => this.release(ticket);
    if (!this.active) {
      this.active = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      ticket.resolve = resolve;
      this.queue.push(ticket);
    });
  }

  release(ticket) {
    if (ticket.released) return;
    ticket.released = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.cancelled) continue;
      next.resolve(() => this.release(next));
      return;
    }
    this.active = false;
  }

  cancel(applicationJobId) {
    const remaining = [];
    for (const ticket of this.queue) {
      if (ticket.applicationJobId === applicationJobId) {
        ticket.cancelled = true;
        ticket.resolve(null);
      } else {
        remaining.push(ticket);
      }
    }
    this.queue = remaining;
  }
}

const defaultInferenceGate = new OcrInferenceGate();

export class OcrStageCostModel {
  constructor(initialCosts = {}) {
    // Seeds come from committed macOS timing evidence. Successful result
    // metrics replace them with an exponential moving average.
    this.costs = {
      queued: 1,
      rasterizing: 50,
      preprocessing: 1,
      recognizing: 800,
      validating: 8,
      applying: 8,
      ...initialCosts,
    };
    this.sampleCount = 0;
  }

  snapshot() {
    return { sampleCount: this.sampleCount, costsMs: clone(this.costs) };
  }

  fractionAtStage(stage) {
    if (TERMINAL_PAGE_STATES.has(stage)) return 1;
    const index = WEIGHTED_STAGES.indexOf(stage);
    if (index < 0) return 0;
    const total = WEIGHTED_STAGES.reduce((sum, name) => sum + this.costs[name], 0);
    const complete = WEIGHTED_STAGES.slice(0, index)
      .reduce((sum, name) => sum + this.costs[name], 0);
    return total > 0 ? complete / total : 0;
  }

  observe(resultMetrics, { validatingMs = 0, applyingMs = 0 } = {}) {
    if (!resultMetrics || typeof resultMetrics !== 'object') return;
    const measured = {
      rasterizing: Math.max(1, Number(resultMetrics.rasterMs) || 0),
      preprocessing: 1,
      recognizing: Math.max(1, ['workerStartupMs', 'modelStartupMs', 'detectionMs', 'recognitionMs']
        .reduce((sum, key) => sum + (Number(resultMetrics[key]) || 0), 0)),
      validating: Math.max(1, validatingMs),
      applying: Math.max(1, applyingMs),
    };
    const alpha = this.sampleCount === 0 ? 1 : 0.25;
    for (const [stage, value] of Object.entries(measured)) {
      this.costs[stage] = this.costs[stage] * (1 - alpha) + value * alpha;
    }
    this.sampleCount += 1;
  }
}

function failureMetadata(value, fallbackCode, fallbackStage) {
  return {
    code: typeof value?.code === 'string' ? value.code : fallbackCode,
    stage: typeof value?.stage === 'string' ? value.stage : fallbackStage,
    retryable: value?.retryable === true,
  };
}

export class ApplicationOcrJob {
  constructor(controller, options) {
    applicationJobSequence += 1;
    this.controller = controller;
    this.options = options;
    this.jobId = `ocr-document-job-${Date.now()}-${applicationJobSequence}`;
    this.documentId = options.document.id;
    this.documentGeneration = ensureDocumentOcrState(options.document).generation;
    this.documentLifecycleGeneration = documentLifecycleGeneration(options.document);
    this.ownerPdfDocument = options.document.pdfDoc;
    this.ownerPageCount = options.document.pdfDoc.numPages;
    this.ownerSourcePdfPath = options.sourcePdfPath;
    this.ownerDocumentFilePath = typeof options.document.filePath === 'string'
      ? options.document.filePath
      : null;
    this.sourceFingerprint = options.documentFingerprint
      ? clone(options.documentFingerprint)
      : null;
    this.status = 'queued';
    this.progress = 0;
    this.progressSequence = 0;
    this.cancelRequested = false;
    this.cancellationReason = null;
    this.resolveCancellation = null;
    this.cancellationSignal = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
    this.currentNativeJobId = null;
    this.appliedPageNumbers = [];
    this.rolledBackPageNumbers = [];
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.pages = new Map(options.pageNumbers.map((pageNumber) => [pageNumber, {
      pageNumber,
      state: 'queued',
      fraction: 0,
      attempts: 0,
      retries: 0,
      retryableFailureSeen: false,
      failure: null,
      staleRejected: false,
      cache: 'not-checked',
      retained: false,
      token: null,
      request: null,
      measuredStageCosts: null,
      performance: null,
    }]));
    this.pageFractionSum = 0;
    this.counts = Object.fromEntries(OCR_APPLICATION_PAGE_STATES.map((state) => [state, 0]));
    this.counts.queued = this.pages.size;
    this.prefetchedPage = null;
    this.activePrefetchReceipt = null;
    this.prefetchMetrics = {
      requested: 0,
      used: 0,
      discarded: 0,
      failed: 0,
      maxBuffered: 0,
      rasterMs: 0,
      bytesPrepared: 0,
      bytesUsed: 0,
      peakBufferedBytes: 0,
    };
    this.before = snapshotOcrCommandState(options.document, options.pageNumbers);
    this.completion = null;
  }

  cancel(reason = 'parent-cancelled') {
    return this.controller.cancelJob(this.jobId, reason);
  }

  requestCancellation(reason) {
    if (this.cancelRequested) return false;
    this.cancelRequested = true;
    this.cancellationReason = reason;
    this.resolveCancellation?.();
    this.resolveCancellation = null;
    return true;
  }

  pageSummaries() {
    return [...this.pages.values()].map((page) => ({
      pageNumber: page.pageNumber,
      state: page.state,
      fraction: page.fraction,
      attempts: page.attempts,
      retries: page.retries,
      retryableFailureSeen: page.retryableFailureSeen,
      failure: page.failure ? clone(page.failure) : null,
      staleRejected: page.staleRejected,
      cache: page.cache,
      retained: page.retained,
      measuredStageCosts: page.measuredStageCosts ? clone(page.measuredStageCosts) : null,
      performance: page.performance ? clone(page.performance) : null,
    }));
  }

  summary() {
    const pages = this.pageSummaries();
    return {
      jobId: this.jobId,
      documentId: this.documentId,
      documentGeneration: this.documentGeneration,
      documentLifecycleGeneration: this.documentLifecycleGeneration,
      status: this.status,
      progress: this.progress,
      cancellationReason: this.cancellationReason,
      keepCompletedPages: this.options.keepCompletedPages,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      counts: clone(this.counts),
      pages,
      stageCosts: this.controller.stageCosts.snapshot(),
      appliedPageNumbers: [...this.appliedPageNumbers],
      rolledBackPageNumbers: [...this.rolledBackPageNumbers],
      prefetch: clone(this.prefetchMetrics),
      performance: summarizeOcrApplicationPerformance(pages, {
        prefetch: this.prefetchMetrics,
      }),
    };
  }

  releaseTerminalResources() {
    this.before = null;
    this.ownerPdfDocument = null;
    this.sourceFingerprint = null;
    this.resolveCancellation = null;
    this.cancellationSignal = null;
    this.prefetchedPage = null;
    this.activePrefetchReceipt = null;
    this.options.createPageRequest = null;
    this.options.documentFingerprint = null;
    this.options.modelPack = null;
    this.options.onProgress = null;
    for (const page of this.pages.values()) {
      page.request = null;
      page.token = null;
      page.measuredStageCosts = null;
      page.performance = null;
    }
  }
}

export class OcrApplicationController {
  constructor({
    runPage = runNativeOcrPageForDocument,
    prefetchPage = prefetchNativeOcrPageRaster,
    cancelPrefetch = cancelNativeOcrPagePrefetch,
    cancelPage = cancelNativeOcrJob,
    cancelDocumentNative = cancelNativeOcrDocument,
    cancelAllNative = cancelAllNativeOcrJobs,
    cache = getDefaultOcrResultCache(),
    modelState = getDefaultOcrModelPackState(),
    fingerprintDocument = fingerprintOcrDocument,
    stageCosts = new OcrStageCostModel(),
    inferenceGate = defaultInferenceGate,
    clock = nowMs,
    yieldControl = yieldToEventLoop,
  } = {}) {
    this.runPage = runPage;
    this.prefetchPage = prefetchPage;
    this.cancelPrefetch = cancelPrefetch;
    this.cancelPage = cancelPage;
    this.cancelDocumentNative = cancelDocumentNative;
    this.cancelAllNative = cancelAllNative;
    this.cache = cache;
    this.modelState = modelState;
    this.fingerprintDocument = fingerprintDocument;
    this.stageCosts = stageCosts;
    this.inferenceGate = inferenceGate;
    this.clock = clock;
    this.yieldControl = yieldControl;
    this.jobs = new Map();
    activeApplicationControllers.add(this);
  }

  startDocumentJob({
    document,
    sourcePdfPath,
    pageNumbers = null,
    createPageRequest = null,
    documentFingerprint = null,
    modelPack = null,
    recognitionOptions = {},
    documentRevision = 0,
    force = false,
    keepCompletedPages = true,
    useCache = true,
    maximumRetries = 1,
    onProgress = null,
  }) {
    if (!document || typeof document.id !== 'string' || !document.pdfDoc) {
      throw new TypeError('Application OCR requires a loaded document');
    }
    if (typeof sourcePdfPath !== 'string' || sourcePdfPath.length === 0) {
      throw new TypeError('Application OCR requires a parent-side PDF path');
    }
    if (typeof document.filePath === 'string' && document.filePath !== sourcePdfPath) {
      throw Object.assign(new Error('Application OCR source path does not match the document owner'), {
        code: 'OCR_SOURCE_IDENTITY_CHANGED',
        retryable: false,
      });
    }
    const pages = pageNumbers ?? Array.from({ length: document.pdfDoc.numPages }, (_, index) => index + 1);
    if (!Array.isArray(pages) || pages.length === 0 ||
        pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > document.pdfDoc.numPages) ||
        new Set(pages).size !== pages.length) {
      throw new TypeError('Application OCR pageNumbers must uniquely identify loaded pages');
    }
    if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0 || maximumRetries > 3) {
      throw new RangeError('Application OCR maximumRetries must be between 0 and 3');
    }
    if (createPageRequest !== null && typeof createPageRequest !== 'function') {
      throw new TypeError('Application OCR createPageRequest must be a function');
    }
    if (activeDocumentApplicationJobs.has(document.id)) {
      throw Object.assign(new Error('An OCR application job is already active for this document'), {
        code: 'OCR_DOCUMENT_JOB_ACTIVE',
        retryable: false,
      });
    }
    const options = {
      document,
      sourcePdfPath,
      pageNumbers: [...pages],
      createPageRequest,
      documentFingerprint,
      modelPack,
      recognitionOptions,
      documentRevision,
      force: force === true,
      keepCompletedPages: keepCompletedPages !== false,
      useCache: useCache !== false,
      maximumRetries,
      onProgress: typeof onProgress === 'function' ? onProgress : null,
    };
    const job = new ApplicationOcrJob(this, options);
    const releasePreloadLane = acquireWholePdfPreloadSuspension(document, { reason: 'ocr-active' });
    this.jobs.set(job.jobId, job);
    activeDocumentApplicationJobs.set(document.id, job);
    job.completion = this.runJob(job).finally(() => {
      this.jobs.delete(job.jobId);
      if (activeDocumentApplicationJobs.get(document.id) === job) {
        activeDocumentApplicationJobs.delete(document.id);
      }
      job.releaseTerminalResources();
      releasePreloadLane();
      if (document.performanceProfile?.largeDocument === true || pages.length >= 50) {
        notePdfForegroundActivity('ocr-terminal-memory-release', 250);
      }
    });
    return job;
  }

  ownerIdentityFailure(job) {
    const { document } = job.options;
    if (!document || document.id !== job.documentId ||
        document.pdfDoc !== job.ownerPdfDocument ||
        documentLifecycleGeneration(document) !== job.documentLifecycleGeneration ||
        document.pdfDoc?.numPages !== job.ownerPageCount ||
        ensureDocumentOcrState(document).generation !== job.documentGeneration) {
      return {
        code: 'OCR_DOCUMENT_LIFECYCLE_CHANGED',
        stage: 'scheduling',
        retryable: false,
      };
    }
    if (job.ownerDocumentFilePath !== null &&
        (document.filePath !== job.ownerDocumentFilePath ||
         job.ownerDocumentFilePath !== job.ownerSourcePdfPath)) {
      return {
        code: 'OCR_SOURCE_IDENTITY_CHANGED',
        stage: 'scheduling',
        retryable: false,
      };
    }
    return null;
  }

  acceptRequestSourceIdentity(job, request) {
    const failure = this.ownerIdentityFailure(job);
    if (failure) return failure;
    if (!request || request.document?.id !== job.documentId ||
        request.document?.generation !== job.documentGeneration ||
        request.document?.pageCount !== job.ownerPageCount ||
        request.document?.revision !== job.options.documentRevision) {
      return {
        code: 'OCR_SOURCE_IDENTITY_CHANGED',
        stage: 'scheduling',
        retryable: false,
      };
    }
    if (job.sourceFingerprint === null) {
      job.sourceFingerprint = clone(request.document.fingerprint);
    } else if (!sameJson(job.sourceFingerprint, request.document.fingerprint)) {
      return {
        code: 'OCR_SOURCE_IDENTITY_CHANGED',
        stage: 'scheduling',
        retryable: false,
      };
    }
    return null;
  }

  rejectStaleOwner(job, page, stage = 'scheduling', pageBefore = null) {
    const failure = this.ownerIdentityFailure(job) ?? {
      code: 'OCR_SOURCE_IDENTITY_CHANGED',
      stage,
      retryable: false,
    };
    failure.stage = stage;
    page.staleRejected = true;
    job.requestCancellation(failure.code === 'OCR_DOCUMENT_LIFECYCLE_CHANGED'
      ? 'document-lifecycle-changed'
      : 'source-identity-changed');
    this.discardPagePrefetch(job);
    this.inferenceGate.cancel(job.jobId);
    this.restoreCurrentAttempt(job, page, pageBefore);
    if (!TERMINAL_PAGE_STATES.has(page.state)) {
      this.transition(job, page, 'failed', { failure });
    }
    if (job.currentNativeJobId) {
      Promise.resolve(this.cancelPage(job.currentNativeJobId)).catch(() => {});
    }
    return false;
  }

  transition(job, page, state, detail = {}) {
    if (!OCR_APPLICATION_PAGE_STATES.includes(state)) {
      throw new TypeError('Application OCR page state is unsupported');
    }
    const previousState = page.state;
    const previousFraction = page.fraction;
    page.state = state;
    page.fraction = Math.max(page.fraction, this.stageCosts.fractionAtStage(state));
    if (previousState !== state) {
      job.counts[previousState] = Math.max(0, job.counts[previousState] - 1);
      job.counts[state] += 1;
    }
    job.pageFractionSum += page.fraction - previousFraction;
    if (detail.failure) page.failure = clone(detail.failure);
    if (page.token && ['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying'].includes(state)) {
      markOcrPageStage(job.options.document, page.token, state);
    }
    const average = job.pageFractionSum / job.pages.size;
    job.progress = Math.max(job.progress, average);
    job.progressSequence += 1;
    try {
      job.options.onProgress?.({
        jobId: job.jobId,
        documentId: job.documentId,
        sequence: job.progressSequence,
        pageNumber: page.pageNumber,
        pageState: state,
        pageFraction: page.fraction,
        documentFraction: job.progress,
        attempts: page.attempts,
        retries: page.retries,
        failure: page.failure ? clone(page.failure) : null,
        stageCosts: this.stageCosts.snapshot(),
      });
    } catch {
      // Progress observers cannot affect OCR execution.
    }
  }

  async waitForCancellable(job, promise) {
    const settled = await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error }),
      ),
      job.cancellationSignal.then(() => ({ status: 'cancelled' })),
    ]);
    if (settled.status === 'cancelled') return CANCELLED_ASYNC_WAIT;
    if (settled.status === 'rejected') throw settled.error;
    return settled.value;
  }

  async cancellationWindow(job, page, stage) {
    const result = await this.waitForCancellable(job, this.yieldControl({
      jobId: job.jobId,
      documentId: job.documentId,
      pageNumber: page?.pageNumber ?? null,
      stage,
    }));
    return result === CANCELLED_ASYNC_WAIT || job.cancelRequested;
  }

  cancelCurrentAttempt(job, page, pageBefore = null) {
    if (!job.cancelRequested) return false;
    this.restoreCurrentAttempt(job, page, pageBefore);
    if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
    return true;
  }

  async prepareDefaults(job) {
    const options = job.options;
    if (this.ownerIdentityFailure(job)) return false;
    if (options.createPageRequest) return !job.cancelRequested;
    if (!options.documentFingerprint) {
      const fingerprint = await this.waitForCancellable(
        job,
        this.fingerprintDocument(options.sourcePdfPath),
      );
      if (fingerprint === CANCELLED_ASYNC_WAIT) return false;
      if (this.ownerIdentityFailure(job)) return false;
      options.documentFingerprint = fingerprint;
      job.sourceFingerprint = clone(fingerprint);
    }
    if (!options.modelPack) {
      const model = await this.waitForCancellable(job, this.modelState.requireInstalled());
      if (model === CANCELLED_ASYNC_WAIT) return false;
      if (this.ownerIdentityFailure(job)) return false;
      options.modelPack = model.manifest;
    }
    options.createPageRequest = (input) => createApplicationOcrPageRequest({
      ...input,
      documentFingerprint: options.documentFingerprint,
      modelPack: options.modelPack,
      recognitionOptions: options.recognitionOptions,
      documentRevision: options.documentRevision,
      force: options.force,
      keepCompletedPages: options.keepCompletedPages,
    });
    return !job.cancelRequested && !this.ownerIdentityFailure(job);
  }

  startPagePrefetch(job, pageNumber, recognitionOptions) {
    if (job.cancelRequested || job.prefetchedPage || !Number.isSafeInteger(pageNumber) ||
        !job.sourceFingerprint || this.ownerIdentityFailure(job)
        || !isPdfForegroundIdle() || !backgroundRenderAdmissionAllowed()) return;
    job.prefetchMetrics.requested += 1;
    let requested;
    try {
      requested = Promise.resolve(this.prefetchPage({
        sourcePdfPath: job.options.sourcePdfPath,
        applicationJobId: job.jobId,
        documentId: job.documentId,
        documentFingerprint: clone(job.sourceFingerprint),
        pageNumber,
        recognitionOptions,
      }));
    } catch {
      requested = Promise.reject(new Error('OCR page prefetch failed before scheduling'));
    }
    const prefetch = {
      pageNumber,
      promise: requested.then(
        (receipt) => ({ receipt, failed: false }),
        () => ({ receipt: null, failed: true }),
      ),
    };
    job.prefetchedPage = prefetch;
    job.prefetchMetrics.maxBuffered = Math.max(job.prefetchMetrics.maxBuffered, 1);
  }

  async takePagePrefetch(job, pageNumber) {
    const prefetch = job.prefetchedPage;
    if (!prefetch) return null;
    if (prefetch.pageNumber !== pageNumber) {
      this.discardPagePrefetch(job);
      return null;
    }
    job.prefetchedPage = null;
    const prepared = await this.waitForCancellable(job, prefetch.promise);
    if (prepared === CANCELLED_ASYNC_WAIT || job.cancelRequested) {
      job.prefetchMetrics.discarded += 1;
      Promise.resolve(this.cancelPrefetch(job.jobId)).catch(() => {});
      return null;
    }
    if (prepared.failed || !prepared.receipt || prepared.receipt.status !== 'ready') {
      job.prefetchMetrics.failed += 1;
      return null;
    }
    const bytes = Number(prepared.receipt.byteLength) || 0;
    job.prefetchMetrics.rasterMs += Number(prepared.receipt.rasterMs) || 0;
    job.prefetchMetrics.bytesPrepared += bytes;
    job.prefetchMetrics.bytesUsed += bytes;
    job.prefetchMetrics.peakBufferedBytes = Math.max(job.prefetchMetrics.peakBufferedBytes, bytes);
    job.prefetchMetrics.used += 1;
    job.activePrefetchReceipt = prepared.receipt;
    return prepared.receipt;
  }

  discardPagePrefetch(job) {
    if (!job.prefetchedPage && !job.activePrefetchReceipt) return;
    job.prefetchedPage = null;
    job.activePrefetchReceipt = null;
    job.prefetchMetrics.discarded += 1;
    Promise.resolve(this.cancelPrefetch(job.jobId)).catch(() => {});
  }

  async runJob(job) {
    job.status = 'running';
    try {
      const prepared = await this.prepareDefaults(job);
      if (!prepared) {
        const ownershipFailure = this.ownerIdentityFailure(job);
        if (ownershipFailure && !job.cancelRequested) {
          job.requestCancellation(ownershipFailure.code === 'OCR_DOCUMENT_LIFECYCLE_CHANGED'
            ? 'document-lifecycle-changed'
            : 'source-identity-changed');
        }
        for (const page of job.pages.values()) {
          if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
        }
        job.status = 'cancelled';
        job.progress = 1;
        job.finishedAt = new Date().toISOString();
        return job.summary();
      }
    } catch (error) {
      const failure = failureMetadata(error, 'OCR_MODEL_OR_FINGERPRINT_UNAVAILABLE', 'preparing');
      for (const page of job.pages.values()) {
        this.transition(job, page, job.cancelRequested ? 'cancelled' : 'failed',
          job.cancelRequested ? {} : { failure });
      }
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      job.finishedAt = new Date().toISOString();
      return job.summary();
    }

    for (let pageIndex = 0; pageIndex < job.options.pageNumbers.length; pageIndex += 1) {
      const pageNumber = job.options.pageNumbers[pageIndex];
      const nextPageNumber = job.options.pageNumbers[pageIndex + 1] ?? null;
      const page = job.pages.get(pageNumber);
      if (job.cancelRequested) {
        this.transition(job, page, 'cancelled');
        continue;
      }
      if (this.ownerIdentityFailure(job)) {
        this.rejectStaleOwner(job, page, 'scheduling');
        continue;
      }
      try {
        await this.runPageEntry(job, page, nextPageNumber);
      } catch (error) {
        this.restoreCurrentAttempt(job, page);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_PAGE_ORCHESTRATION_FAILED', 'scheduling'),
        });
      }
    }

    this.discardPagePrefetch(job);

    for (const page of job.pages.values()) {
      if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
    }
    const failed = [...job.pages.values()].some((page) => page.state === 'failed');
    const cancelled = job.cancelRequested || [...job.pages.values()].some((page) => page.state === 'cancelled');
    const hasTerminalProblem = failed || cancelled;
    if (hasTerminalProblem && !job.options.keepCompletedPages && job.appliedPageNumbers.length > 0) {
      const rollback = selectOcrCommandSnapshot(job.before, job.appliedPageNumbers);
      restoreOcrCommandState(job.options.document, rollback, { restoreDocumentState: false });
      job.rolledBackPageNumbers = [...job.appliedPageNumbers];
      for (const pageNumber of job.appliedPageNumbers) job.pages.get(pageNumber).retained = false;
      job.appliedPageNumbers = [];
    } else if (job.appliedPageNumbers.length > 0) {
      recordAppliedOcrCompound(job.options.document, job.before, job.appliedPageNumbers);
      for (const pageNumber of job.appliedPageNumbers) job.pages.get(pageNumber).retained = true;
    }
    job.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    job.progress = 1;
    job.finishedAt = new Date().toISOString();
    return job.summary();
  }

  async runPageEntry(job, page, nextPageNumber = null) {
    const { document } = job.options;
    const pageBefore = selectOcrCommandSnapshot(job.before, [page.pageNumber]);
    if (this.ownerIdentityFailure(job)) {
      this.rejectStaleOwner(job, page, 'scheduling', pageBefore);
      return;
    }
    let attempt;
    try {
      attempt = await beginOcrPageAttempt(document, page.pageNumber, { force: job.options.force });
    } catch (error) {
      this.transition(job, page, 'failed', {
        failure: failureMetadata(error, 'OCR_PAGE_PREPARATION_FAILED', 'scheduling'),
      });
      return;
    }
    if (this.ownerIdentityFailure(job)) {
      this.rejectStaleOwner(job, page, 'scheduling', pageBefore);
      return;
    }
    if (attempt.skipped) {
      if (job.prefetchedPage?.pageNumber === page.pageNumber) {
        this.discardPagePrefetch(job);
      }
      if (attempt.reason === 'stale-before-attempt') {
        page.staleRejected = true;
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_STALE_PAGE', stage: 'scheduling', retryable: false },
        });
      } else if (attempt.reason === 'existing-text-unverified') {
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_EXISTING_TEXT_UNVERIFIED', stage: 'validating', retryable: false },
        });
      } else {
        this.transition(job, page, 'skipped');
      }
      return;
    }
    page.token = attempt.token;
    let prefetchedRaster = await this.takePagePrefetch(job, page.pageNumber);
    if (job.cancelRequested) {
      this.cancelCurrentAttempt(job, page, pageBefore);
      return;
    }
    if (this.ownerIdentityFailure(job)) {
      this.rejectStaleOwner(job, page, 'scheduling', pageBefore);
      return;
    }

    for (let attemptIndex = 0; attemptIndex <= job.options.maximumRetries; attemptIndex += 1) {
      if (job.cancelRequested) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      page.attempts += 1;
      this.transition(job, page, 'queued');
      let request;
      try {
        request = await this.waitForCancellable(
          job,
          job.options.createPageRequest({
            document,
            token: page.token,
            pageNumber: page.pageNumber,
            attempt: attemptIndex,
          }),
        );
        if (request === CANCELLED_ASYNC_WAIT || job.cancelRequested) {
          this.cancelCurrentAttempt(job, page, pageBefore);
          return;
        }
        const sourceFailure = this.acceptRequestSourceIdentity(job, request);
        if (sourceFailure) {
          this.rejectStaleOwner(job, page, 'scheduling', pageBefore);
          return;
        }
        page.request = request;
      } catch (error) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_REQUEST_INVALID', 'scheduling'),
        });
        return;
      }

      let cacheKey;
      try {
        cacheKey = createOcrCacheKeyFromRequest(request);
      } catch (error) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_CACHE_KEY_INVALID', 'scheduling'),
        });
        return;
      }
      if (job.options.useCache && !job.options.force && attemptIndex === 0) {
        try {
          const cached = await this.waitForCancellable(
            job,
            this.cache.get(cacheKey, { documentId: document.id }),
          );
          if (cached === CANCELLED_ASYNC_WAIT || job.cancelRequested) {
            this.cancelCurrentAttempt(job, page, pageBefore);
            return;
          }
          page.cache = cached.status;
          if (cached.status === 'hit') {
            if (this.ownerIdentityFailure(job)) {
              this.rejectStaleOwner(job, page, 'validating', pageBefore);
              return;
            }
            this.transition(job, page, 'validating');
            if (await this.cancellationWindow(job, page, 'validating')) {
              this.cancelCurrentAttempt(job, page, pageBefore);
              return;
            }
            const validatingStarted = this.clock();
            const rebound = rebindCachedOcrEnvelope(cached.envelope, request, page.token);
            const validatingMs = this.clock() - validatingStarted;
            if (await this.cancellationWindow(job, page, 'validated')) {
              this.cancelCurrentAttempt(job, page, pageBefore);
              return;
            }
            await this.applyValidatedPage(
              job,
              page,
              rebound.result,
              rebound.pageGeometry,
              validatingMs,
              pageBefore,
              null,
            );
            return;
          }
        } catch (error) {
          page.cache = 'error';
          console.warn('[ocr-cache] validated cache lookup failed:',
            error?.code ?? error?.message ?? 'unknown cache lookup error');
        }
        if (this.cancelCurrentAttempt(job, page, pageBefore)) return;
      } else {
        page.cache = job.options.useCache ? 'bypassed' : 'disabled';
      }

      this.transition(job, page, 'rasterizing');
      if (await this.cancellationWindow(job, page, 'rasterizing')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      this.transition(job, page, 'preprocessing');
      if (await this.cancellationWindow(job, page, 'preprocessing')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      const releaseInference = await this.inferenceGate.acquire(job.jobId);
      if (!releaseInference || job.cancelRequested) {
        releaseInference?.();
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      if (this.ownerIdentityFailure(job)) {
        releaseInference();
        this.rejectStaleOwner(job, page, 'scheduling', pageBefore);
        return;
      }
      let prepared;
      try {
        this.transition(job, page, 'recognizing');
        this.startPagePrefetch(job, nextPageNumber, request.recognitionOptions);
        job.currentNativeJobId = request.jobId;
        prepared = await this.runPage({
          document,
          sourcePdfPath: job.options.sourcePdfPath,
          request,
          token: page.token,
          prefetchReceipt: prefetchedRaster,
        });
      } catch (error) {
        if (prefetchedRaster) {
          Promise.resolve(this.cancelPrefetch(job.jobId)).catch(() => {});
        }
        const failure = failureMetadata(error, 'OCR_PAGE_RUN_FAILED', 'recognizing');
        if (failure.retryable && attemptIndex < job.options.maximumRetries && !job.cancelRequested) {
          page.retryableFailureSeen = true;
          page.retries += 1;
          continue;
        }
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, job.cancelRequested ? 'cancelled' : 'failed', { failure });
        return;
      } finally {
        job.activePrefetchReceipt = null;
        prefetchedRaster = null;
        job.currentNativeJobId = null;
        releaseInference();
      }
      if (this.ownerIdentityFailure(job)) {
        this.rejectStaleOwner(job, page, 'validating', pageBefore);
        return;
      }
      const outcome = prepared?.outcome;
      if (!outcome) {
        page.staleRejected = true;
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_STALE_PAGE', stage: 'validating', retryable: false },
        });
        return;
      }
      if (outcome.status === 'cancelled' || job.cancelRequested) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      if (outcome.status === 'stale') {
        page.staleRejected = true;
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(outcome.failure, 'OCR_STALE_PAGE', 'validating'),
        });
        return;
      }
      if (outcome.status === 'failed') {
        const failure = failureMetadata(outcome.failure, 'OCR_PAGE_FAILED', 'recognizing');
        if (failure.retryable && attemptIndex < job.options.maximumRetries) {
          page.retryableFailureSeen = true;
          page.retries += 1;
          continue;
        }
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', { failure });
        return;
      }

      this.transition(job, page, 'validating');
      if (await this.cancellationWindow(job, page, 'validating')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      const validatingStarted = this.clock();
      let result;
      let pageGeometry;
      try {
        result = assertOcrResultV2(outcome.result);
        if (!['completed', 'partial', 'unsupported'].includes(result.page.status)) {
          throw new TypeError('Application OCR accepts only successful or unsupported completed results');
        }
        pageGeometry = assertOcrPageGeometryV1(prepared.pageGeometry);
      } catch (error) {
        const failure = failureMetadata(error, 'OCR_RESULT_INVALID', 'validating');
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', { failure });
        return;
      }
      const validatingMs = this.clock() - validatingStarted;
      if (await this.cancellationWindow(job, page, 'validated')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      if (!await this.applyValidatedPage(
        job,
        page,
        result,
        pageGeometry,
        validatingMs,
        pageBefore,
        {
          lifecycle: prepared.outcome?.lifecycle ?? [],
          resources: prepared.outcome?.resources ?? {},
        },
      )) return;
      if (job.options.useCache) {
        try {
          const cacheWrite = await this.cache.put(cacheKey, result, pageGeometry, { documentId: document.id });
          if (cacheWrite?.stored !== true) {
            throw Object.assign(new Error('validated OCR cache entry was not stored'), {
              code: 'OCR_CACHE_NOT_STORED',
            });
          }
          page.cache = 'stored';
        } catch (error) {
          page.cache = 'write-failed';
          console.warn('[ocr-cache] validated result was not stored:',
            error?.code ?? error?.message ?? 'unknown cache write error');
        }
      }
      return;
    }
  }

  restoreCurrentAttempt(job, page, pageBefore = null) {
    if (!page.token || !isCurrentOcrPageToken(job.options.document, page.token)) return false;
    const snapshot = pageBefore ?? selectOcrCommandSnapshot(job.before, [page.pageNumber]);
    return restoreOcrCommandState(job.options.document, snapshot, { restoreDocumentState: false });
  }

  async applyValidatedPage(job, page, result, pageGeometry, validatingMs, pageBefore, nativeEvidence = null) {
    if (this.cancelCurrentAttempt(job, page, pageBefore)) return false;
    if (this.ownerIdentityFailure(job)) {
      return this.rejectStaleOwner(job, page, 'applying', pageBefore);
    }
    if (!isCurrentOcrPageToken(job.options.document, page.token)) {
      page.staleRejected = true;
      this.transition(job, page, 'failed', {
        failure: { code: 'OCR_STALE_PAGE', stage: 'applying', retryable: false },
      });
      return false;
    }
    this.transition(job, page, 'applying');
    if (await this.cancellationWindow(job, page, 'applying')) {
      this.cancelCurrentAttempt(job, page, pageBefore);
      return false;
    }
    if (this.ownerIdentityFailure(job)) {
      return this.rejectStaleOwner(job, page, 'applying', pageBefore);
    }
    const applyingStarted = this.clock();
    let stateUpdate;
    try {
      stateUpdate = applyOcrPageResult(job.options.document, { result, pageGeometry, token: page.token });
    } catch (error) {
      this.restoreCurrentAttempt(job, page, pageBefore);
      this.transition(job, page, 'failed', {
        failure: failureMetadata(error, 'OCR_RESULT_INVALID', 'applying'),
      });
      return false;
    }
    const applyingMs = this.clock() - applyingStarted;
    if (!stateUpdate.applied) {
      page.staleRejected = true;
      this.restoreCurrentAttempt(job, page, pageBefore);
      this.transition(job, page, 'failed', {
        failure: { code: 'OCR_STALE_PAGE', stage: 'applying', retryable: false },
      });
      return false;
    }
    this.stageCosts.observe(result.metrics, { validatingMs, applyingMs });
    page.measuredStageCosts = this.stageCosts.snapshot();
    page.performance = {
      rasterMs: result.metrics.rasterMs,
      childStartupMs: result.metrics.workerStartupMs,
      modelStartupMs: result.metrics.modelStartupMs,
      detectionMs: result.metrics.detectionMs,
      recognitionMs: result.metrics.recognitionMs,
      validationMs: validatingMs,
      applyMs: applyingMs,
      totalOcrMs: result.metrics.totalOcrMs,
      lifecycle: clone(nativeEvidence?.lifecycle ?? []),
      resources: clone(nativeEvidence?.resources ?? {}),
    };
    job.appliedPageNumbers.push(page.pageNumber);
    this.transition(job, page, result.page.status === 'unsupported' ? 'unsupported' : 'completed');
    return true;
  }

  requestJobCancellationSync(job, reason = 'parent-cancelled') {
    if (!job || !job.requestCancellation(reason)) return false;
    this.discardPagePrefetch(job);
    this.inferenceGate.cancel(job.jobId);
    for (const page of job.pages.values()) {
      if (page.state === 'queued' && !page.token) this.transition(job, page, 'cancelled');
    }
    if (job.currentNativeJobId) {
      Promise.resolve(this.cancelPage(job.currentNativeJobId)).catch(() => {});
    }
    return true;
  }

  async cancelJob(jobId, reason = 'parent-cancelled') {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    this.requestJobCancellationSync(job, reason);
    return job.completion;
  }

  requestDocumentCancellationSync(documentId, reason = 'document-lifecycle-changed') {
    const jobs = [...this.jobs.values()].filter((job) => job.documentId === documentId);
    for (const job of jobs) this.requestJobCancellationSync(job, reason);
    return jobs.map((job) => job.completion);
  }

  async cancelDocument(documentId, reason = 'document-close') {
    const completions = this.requestDocumentCancellationSync(documentId, reason);
    try { await this.cancelDocumentNative(documentId); } catch { /* native exit hook is authoritative */ }
    return Promise.all(completions);
  }

  async cancelAll(reason = 'application-close') {
    const completions = [...this.jobs.values()].map((job) => this.cancelJob(job.jobId, reason));
    try { await this.cancelAllNative(); } catch { /* native RunEvent hook is authoritative */ }
    return Promise.all(completions);
  }

  dispose() {
    if (this.jobs.size > 0) throw new Error('Cannot dispose an OCR controller with active jobs');
    activeApplicationControllers.delete(this);
  }
}

export async function cancelApplicationOcrDocument(documentId, reason = 'document-close') {
  if (typeof documentId !== 'string' || documentId.length === 0) return [];
  if (activeApplicationControllers.size === 0) {
    try { await cancelNativeOcrDocument(documentId); } catch { /* document close continues */ }
    return [];
  }
  return Promise.all([...activeApplicationControllers].map((controller) =>
    controller.cancelDocument(documentId, reason)));
}

/**
 * Synchronously invalidates JS-owned work before a PDF proxy/content tree is
 * replaced. Native cancellation is dispatched without awaiting IPC; every
 * scheduling and apply boundary independently rechecks the captured owner.
 */
export function cancelApplicationOcrDocumentSync(documentId, reason = 'document-lifecycle-changed') {
  if (typeof documentId !== 'string' || documentId.length === 0) return [];
  const completions = [];
  for (const controller of activeApplicationControllers) {
    completions.push(...controller.requestDocumentCancellationSync(documentId, reason));
  }
  return completions;
}

export async function cancelAllApplicationOcrJobs(reason = 'application-close') {
  if (activeApplicationControllers.size === 0) {
    try { await cancelAllNativeOcrJobs(); } catch { /* native RunEvent hook is authoritative */ }
    return [];
  }
  return Promise.all([...activeApplicationControllers].map((controller) => controller.cancelAll(reason)));
}
